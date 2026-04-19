// P6-5: streamJsonEngine 단위 테스트
//
// CLAUDE_BIN env var로 fake-claude.js 스크립트 주입.
// 실제 Claude CLI 없이 spawn args 확인, 이벤트 파싱, 프로세스 라이프사이클 검증.
//
// 테스트 대상:
//   - buildArgs: 옵션별 CLI args 조합 (worker/manager 분기)
//   - spawnAgent: env 합성, cwd 검증, isManager 분기
//   - sendInput: stream-json / raw-text 프로토콜 분기
//   - handleEvent: system/assistant/result 이벤트 처리
//   - isAlive / detectExitCode / kill / hasProcess / getOutput / getEvents / listSessions

'use strict';

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// 모든 테스트 완료 후 남은 엔진의 모든 프로세스를 강제 종료.
// Manager 모드 fake-claude 는 stdin 이 닫힐 때까지 살아있어서
// node:test runner 의 event loop 을 블로킹한다.
const _allEngines = [];
after(() => {
  for (const engine of _allEngines) {
    try {
      for (const session of engine.listSessions()) {
        if (session.alive && session.pid) {
          try { process.kill(session.pid, 'SIGTERM'); } catch { /* gone */ }
        }
      }
    } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// fake-claude.js 경로
//
// 이 스크립트는 실행 시:
//   1. process.argv 를 CLAUDE_ARGS_FILE 에 JSON으로 기록 (args 검사용)
//   2. system:init 이벤트 emit
//   3. stdin 줄을 읽어서 assistant 이벤트로 echo
//   4. stdin close → result 이벤트 + exit(0)
// ---------------------------------------------------------------------------

const FAKE_CLAUDE_SRC = `
#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const readline = require('node:readline');

const args = process.argv.slice(2);
const argsFile = process.env.CLAUDE_ARGS_FILE;
if (argsFile) {
  try { fs.writeFileSync(argsFile, JSON.stringify(args)); } catch {}
}

// Manager mode: has --input-format stream-json
// Worker mode: has -p (single-shot prompt)
const isManager = args.includes('--input-format');

const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake-sess', model: 'fake', tools: [], cwd: process.cwd() });
process.stdout.write(init + '\\n');

if (!isManager) {
  // Worker: emit assistant text for the prompt, then result, then exit
  const pIdx = args.indexOf('-p');
  const promptText = pIdx >= 0 ? args[pIdx + 1] : '';
  const astEvt = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'worker-echo:' + promptText }] } });
  process.stdout.write(astEvt + '\\n');
  const result = JSON.stringify({ type: 'result', is_error: false, result: 'done', total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 } });
  process.stdout.write(result + '\\n');
  process.exit(0);
} else {
  // Manager: read stdin lines, echo as assistant events + result per turn
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    const evt = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'echo:' + line }] } });
    process.stdout.write(evt + '\\n');
    // Emit a result after each turn (matching real Claude multi-turn behavior)
    const result = JSON.stringify({ type: 'result', is_error: false, result: 'turn-done', total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 } });
    process.stdout.write(result + '\\n');
  });
  rl.on('close', () => {
    process.exit(0);
  });
}
`.trimStart();

// 임시 디렉터리에 fake-claude.js 작성
const fakeClaudioPath = path.join(os.tmpdir(), 'palantir-fake-claude-test.js');
fs.writeFileSync(fakeClaudioPath, FAKE_CLAUDE_SRC, { mode: 0o755 });

// ---------------------------------------------------------------------------
// 헬퍼: 엔진 생성 (매 테스트마다 독립 인스턴스)
// ---------------------------------------------------------------------------

function makeRunService() {
  const events = [];
  const statusUpdates = [];
  const runs = new Map();
  return {
    _events: events,
    _statusUpdates: statusUpdates,
    addRunEvent(runId, type, data) { events.push({ runId, type, data }); },
    updateRunStatus(runId, status) { statusUpdates.push({ runId, status }); },
    updateRunResult(runId, result) {},
    getRun(runId) { return runs.get(runId) || null; },
    _setRun(runId, run) { runs.set(runId, run); },
  };
}

/**
 * createStreamJsonEngine 인스턴스를 만들되 CLAUDE_BIN 을 fake-claude.js 로 설정.
 * CLAUDE_ARGS_FILE 을 개별 tmpfile 로 설정하여 args 캡처.
 *
 * @returns {{ engine, argsFile: string }}
 */
function makeEngine({ runService = null, eventBus = null } = {}) {
  process.env.CLAUDE_BIN = fakeClaudioPath;
  const { createStreamJsonEngine } = require('../services/streamJsonEngine');
  const engine = createStreamJsonEngine({ runService, eventBus });
  _allEngines.push(engine);
  return { engine };
}

/**
 * spawnAgent를 실행하고 args 파일이 기록될 때까지 대기한다.
 * @returns {Promise<string[]>} CLI args (argv.slice(2))
 */
async function spawnAndCaptureArgs(engine, runId, opts, timeoutMs = 1000) {
  const argsFile = path.join(os.tmpdir(), `palantir-claude-args-${runId}.json`);
  process.env.CLAUDE_ARGS_FILE = argsFile;
  try {
    engine.spawnAgent(runId, { cwd: os.tmpdir(), ...opts });
  } finally {
    delete process.env.CLAUDE_ARGS_FILE;
  }

  // args 파일이 생길 때까지 최대 timeoutMs 동안 poll
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 20));
    if (fs.existsSync(argsFile)) {
      try {
        const raw = fs.readFileSync(argsFile, 'utf8');
        fs.unlinkSync(argsFile);
        return JSON.parse(raw);
      } catch { /* keep waiting */ }
    }
  }
  throw new Error(`args file not written within ${timeoutMs}ms for ${runId}`);
}

/**
 * 이벤트가 engine.getEvents(runId)에 나타날 때까지 poll.
 */
async function waitForEvent(engine, runId, predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const evts = engine.getEvents(runId);
    const found = evts.find(predicate);
    if (found) return found;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('event not received within timeout');
}

// ---------------------------------------------------------------------------
// 1. buildArgs / spawnAgent — args 확인
// ---------------------------------------------------------------------------

test('engine: worker spawn args contain --print --output-format stream-json --no-session-persistence', async () => {
  process.env.CLAUDE_BIN = fakeClaudioPath;
  const { engine } = makeEngine();

  const args = await spawnAndCaptureArgs(engine, 'run-args-worker', {
    prompt: 'do the thing',
    isManager: false,
  });

  assert.ok(args.includes('--print'), '--print 포함');
  assert.ok(args.includes('--output-format'), '--output-format 포함');
  assert.ok(args.includes('stream-json'), 'stream-json 포함');
  assert.ok(args.includes('-p'), 'worker는 -p 사용');
  assert.ok(args.includes('do the thing'), 'prompt 값 포함');
  assert.ok(!args.includes('--input-format'), 'worker에는 --input-format 없음');
  assert.ok(args.includes('--no-session-persistence'), '--no-session-persistence 포함');
});

test('engine: manager spawn args contain --input-format stream-json, no -p', async () => {
  process.env.CLAUDE_BIN = fakeClaudioPath;
  const { engine } = makeEngine();

  const args = await spawnAndCaptureArgs(engine, 'run-args-mgr', {
    prompt: 'manager prompt',
    isManager: true,
  });

  assert.ok(args.includes('--input-format'), '--input-format 포함');
  assert.ok(args.includes('stream-json'));
  assert.ok(!args.includes('-p'), 'manager는 -p 사용 안 함');
  assert.ok(!args.includes('--no-session-persistence'), 'manager는 session persistence 유지');
});

test('engine: optional args (model, mcpConfig, allowedTools, permissionMode, maxBudgetUsd) appended', async () => {
  process.env.CLAUDE_BIN = fakeClaudioPath;
  const { engine } = makeEngine();

  const args = await spawnAndCaptureArgs(engine, 'run-args-opts', {
    prompt: 'x',
    isManager: false,
    model: 'claude-opus-4',
    mcpConfig: '/tmp/mcp.json',
    allowedTools: ['Read', 'Write'],
    permissionMode: 'acceptEdits',
    maxBudgetUsd: 1.5,
  });

  assert.ok(args.includes('--model'));
  assert.ok(args.includes('claude-opus-4'));
  assert.ok(args.includes('--mcp-config'));
  assert.ok(args.includes('/tmp/mcp.json'));
  assert.ok(args.includes('--allowedTools'));
  assert.ok(args.includes('Read,Write'), 'allowedTools 쉼표 결합');
  assert.ok(args.includes('--permission-mode'));
  assert.ok(args.includes('acceptEdits'));
  assert.ok(args.includes('--max-budget-usd'));
  assert.ok(args.includes('1.5'));
});

test('engine: systemPrompt and addDir appended when provided', async () => {
  process.env.CLAUDE_BIN = fakeClaudioPath;
  const { engine } = makeEngine();

  const args = await spawnAndCaptureArgs(engine, 'run-args-sys', {
    prompt: 'x',
    isManager: false,
    systemPrompt: 'You are a robot',
    addDir: '/extra/dir',
  });

  assert.ok(args.includes('--append-system-prompt'));
  assert.ok(args.includes('You are a robot'));
  assert.ok(args.includes('--add-dir'));
  assert.ok(args.includes('/extra/dir'));
});

test('engine: spawnAgent returns { pid, engine, isManager }', (t) => {
  process.env.CLAUDE_BIN = fakeClaudioPath;
  const { engine } = makeEngine();

  const result = engine.spawnAgent('run-pid-test', {
    cwd: os.tmpdir(),
    isManager: false,
  });

  assert.ok(typeof result.pid === 'number' && result.pid > 0, 'pid는 양수');
  assert.equal(result.engine, 'stream-json');
  assert.equal(result.isManager, false);
});

test('engine: spawnAgent throws when cwd does not exist', () => {
  process.env.CLAUDE_BIN = fakeClaudioPath;
  const { engine } = makeEngine();

  assert.throws(
    () => engine.spawnAgent('run-bad-cwd', { prompt: 'x', cwd: '/absolutely/nonexistent/dir/12345', isManager: false }),
    (err) => err.message.includes('cwd does not exist'),
  );
});

// ---------------------------------------------------------------------------
// 2. handleEvent — system:init, assistant, result
// ---------------------------------------------------------------------------

test('engine: system:init event sets sessionId', async () => {
  process.env.CLAUDE_BIN = fakeClaudioPath;
  const rs = makeRunService();
  const { engine } = makeEngine({ runService: rs });

  engine.spawnAgent('run-init', { cwd: os.tmpdir(), isManager: false });

  await waitForEvent(engine, 'run-init', e => e.type === 'system');

  assert.equal(engine.getSessionId('run-init'), 'fake-sess');
  const initEvts = rs._events.filter(e => e.type === 'init');
  assert.equal(initEvts.length, 1, 'init 이벤트 기록됨');
  assert.ok(initEvts[0].data.includes('fake-sess'));
});

test('engine: assistant event records text in outputBuffer', async (t) => {
  process.env.CLAUDE_BIN = fakeClaudioPath;
  const rs = makeRunService();
  const { engine } = makeEngine({ runService: rs });
  t.after(() => engine.kill('run-asst'));

  engine.spawnAgent('run-asst', { cwd: os.tmpdir(), isManager: true });

  // init 이벤트 대기 후 메시지 전송
  await waitForEvent(engine, 'run-asst', e => e.type === 'system');
  engine.sendInput('run-asst', 'hello assistant');

  await waitForEvent(engine, 'run-asst', e => e.type === 'assistant');

  const output = engine.getOutput('run-asst');
  assert.ok(output && output.includes('echo:'), 'outputBuffer에 assistant 텍스트 포함');

  const astEvts = rs._events.filter(e => e.type === 'assistant_text');
  assert.ok(astEvts.length >= 1, 'assistant_text 이벤트 기록됨');
});

test('engine: result event for worker triggers updateRunStatus completed', async () => {
  process.env.CLAUDE_BIN = fakeClaudioPath;
  const rs = makeRunService();
  rs._setRun('run-result-w', { status: 'running' });
  const { engine } = makeEngine({ runService: rs });

  engine.spawnAgent('run-result-w', {
    prompt: 'run and exit',
    cwd: os.tmpdir(),
    isManager: false,
  });

  // worker: stdin close → result 이벤트 발생. fake-claude는 stdin close 시 result emit.
  // result 이벤트가 올 때까지 대기
  await waitForEvent(engine, 'run-result-w', e => e.type === 'result', 2000);

  // updateRunStatus가 'completed'로 호출됐는지 확인
  const completedUpdates = rs._statusUpdates.filter(u => u.status === 'completed');
  assert.ok(completedUpdates.length >= 1, 'completed status 업데이트 호출됨');
});

test('engine: result event for manager does NOT call updateRunStatus on non-error', async (t) => {
  process.env.CLAUDE_BIN = fakeClaudioPath;
  const rs = makeRunService();
  rs._setRun('run-result-mgr', { status: 'running' });
  const { engine } = makeEngine({ runService: rs });
  t.after(() => engine.kill('run-result-mgr'));

  engine.spawnAgent('run-result-mgr', { cwd: os.tmpdir(), isManager: true });

  // Wait for init event
  await waitForEvent(engine, 'run-result-mgr', e => e.type === 'system');

  // Send a message — fake-claude manager mode emits assistant + result per turn.
  // This exercises the actual handleEvent result→manager code path.
  engine.sendInput('run-result-mgr', 'hello');

  // Wait for the result event (emitted after the assistant echo)
  await waitForEvent(engine, 'run-result-mgr', e => e.type === 'result', 2000);

  // The result event arrived (is_error: false). For manager sessions,
  // handleEvent must NOT call updateRunStatus('completed') — only workers
  // transition to completed on non-error result.
  const completedUpdates = rs._statusUpdates.filter(
    u => u.runId === 'run-result-mgr' && u.status === 'completed'
  );
  assert.equal(completedUpdates.length, 0,
    'manager non-error result must not trigger updateRunStatus(completed)');

  // Verify the result event WAS recorded (proving we tested the right path)
  const resultEvents = engine.getEvents('run-result-mgr').filter(e => e.type === 'result');
  assert.ok(resultEvents.length >= 1, 'result event was received and recorded');
});

test('engine: onVendorEvent hook fires for each parsed event', async (t) => {
  process.env.CLAUDE_BIN = fakeClaudioPath;
  const { engine } = makeEngine();
  // worker exits naturally; kill is a no-op if already exited
  t.after(() => engine.kill('run-vendor'));

  const vendorEvents = [];
  engine.spawnAgent('run-vendor', {
    cwd: os.tmpdir(),
    isManager: false,
    onVendorEvent: (evt) => vendorEvents.push(evt),
  });

  await waitForEvent(engine, 'run-vendor', e => e.type === 'system', 1000);

  assert.ok(vendorEvents.length >= 1, 'onVendorEvent 최소 1회 호출됨');
  assert.equal(vendorEvents[0].type, 'system');
});

// ---------------------------------------------------------------------------
// 3. sendInput — 프로토콜 분기
// ---------------------------------------------------------------------------

test('engine: sendInput for manager wraps text in stream-json envelope', async (t) => {
  process.env.CLAUDE_BIN = fakeClaudioPath;
  const { engine } = makeEngine();
  t.after(() => engine.kill('run-send-mgr'));

  engine.spawnAgent('run-send-mgr', { cwd: os.tmpdir(), isManager: true });

  // init 대기
  await waitForEvent(engine, 'run-send-mgr', e => e.type === 'system');

  const ok = engine.sendInput('run-send-mgr', 'hello manager');
  assert.equal(ok, true, 'sendInput 성공');

  // fake-claude가 echo로 assistant 이벤트 emit → manager는 이것을 받아야 함
  await waitForEvent(engine, 'run-send-mgr', e => e.type === 'assistant');
  const events = engine.getEvents('run-send-mgr').filter(e => e.type === 'assistant');
  assert.ok(events.length >= 1, 'manager assistant 이벤트 수신');
});

test('engine: sendInput for worker returns false after process exits (single-shot)', async () => {
  // Workers are single-shot (-p flag). The fake-claude exits immediately after emitting result.
  // sendInput after process exit must return false because stdin.writable is false.
  process.env.CLAUDE_BIN = fakeClaudioPath;
  const { engine } = makeEngine();

  engine.spawnAgent('run-send-wkr', { cwd: os.tmpdir(), prompt: 'initial', isManager: false });

  // Wait for the worker to exit (result event)
  await waitForEvent(engine, 'run-send-wkr', e => e.type === 'result', 2000);

  // After exit, sendInput must return false (stdin is no longer writable)
  const ok = engine.sendInput('run-send-wkr', 'late input after exit');
  assert.equal(ok, false, 'worker exited → sendInput returns false');
});

test('engine: sendInput returns false for unknown runId', () => {
  process.env.CLAUDE_BIN = fakeClaudioPath;
  const { engine } = makeEngine();

  const ok = engine.sendInput('nonexistent-run', 'hello');
  assert.equal(ok, false);
});

test('engine: sendInput returns false for text longer than 50000 chars', async (t) => {
  process.env.CLAUDE_BIN = fakeClaudioPath;
  const { engine } = makeEngine();
  t.after(() => engine.kill('run-long-text'));

  engine.spawnAgent('run-long-text', { cwd: os.tmpdir(), isManager: true });
  await waitForEvent(engine, 'run-long-text', e => e.type === 'system');

  const longText = 'a'.repeat(50001);
  const ok = engine.sendInput('run-long-text', longText);
  assert.equal(ok, false, '50001자 초과 시 false 반환');
});

test('engine: sendInput with images records image metadata in user_input event', async (t) => {
  process.env.CLAUDE_BIN = fakeClaudioPath;
  const rs = makeRunService();
  const { engine } = makeEngine({ runService: rs });
  t.after(() => engine.kill('run-img-meta'));

  engine.spawnAgent('run-img-meta', { cwd: os.tmpdir(), isManager: true });
  await waitForEvent(engine, 'run-img-meta', e => e.type === 'system');

  const fakeBase64 = 'iVBORw0KGgoAAAANS'; // 17 chars
  const ok = engine.sendInput('run-img-meta', 'describe this image', [
    { media_type: 'image/png', data: fakeBase64 },
  ]);
  assert.equal(ok, true, 'sendInput with images succeeds');

  // Wait for echo to confirm message was sent
  await waitForEvent(engine, 'run-img-meta', e => e.type === 'assistant');

  const userInputEvts = rs._events.filter(e => e.type === 'user_input');
  assert.ok(userInputEvts.length >= 1, 'user_input event recorded');

  const payload = JSON.parse(userInputEvts[0].data);
  assert.equal(payload.text, 'describe this image');
  assert.ok(Array.isArray(payload.images), 'images array present in payload');
  assert.equal(payload.images.length, 1);
  assert.equal(payload.images[0].media_type, 'image/png');
  assert.equal(payload.images[0].size, fakeBase64.length);
});

test('engine: sendInput text-only does not include images field in user_input event', async (t) => {
  process.env.CLAUDE_BIN = fakeClaudioPath;
  const rs = makeRunService();
  const { engine } = makeEngine({ runService: rs });
  t.after(() => engine.kill('run-no-img'));

  engine.spawnAgent('run-no-img', { cwd: os.tmpdir(), isManager: true });
  await waitForEvent(engine, 'run-no-img', e => e.type === 'system');

  engine.sendInput('run-no-img', 'just text');
  await waitForEvent(engine, 'run-no-img', e => e.type === 'assistant');

  const userInputEvts = rs._events.filter(e => e.type === 'user_input');
  assert.ok(userInputEvts.length >= 1);

  const payload = JSON.parse(userInputEvts[0].data);
  assert.equal(payload.text, 'just text');
  assert.equal(payload.images, undefined, 'no images field when text-only');
});

test('engine: manager initial prompt is sent via stdin as stream-json after spawn', async (t) => {
  process.env.CLAUDE_BIN = fakeClaudioPath;
  const { engine } = makeEngine();
  t.after(() => engine.kill('run-init-prompt'));

  engine.spawnAgent('run-init-prompt', {
    prompt: 'manager initial',
    cwd: os.tmpdir(),
    isManager: true,
  });

  // manager는 spawn 직후 stdin에 initial prompt를 stream-json으로 전송.
  // fake-claude가 그것을 echo하면 assistant 이벤트가 와야 함.
  await waitForEvent(engine, 'run-init-prompt', e => e.type === 'assistant', 1000);
  const output = engine.getOutput('run-init-prompt');
  assert.ok(output && output.includes('echo:'), '초기 프롬프트가 echo됨 = stdin으로 전송됨 확인');
});

// ---------------------------------------------------------------------------
// 4. 프로세스 라이프사이클 — isAlive, detectExitCode, kill, hasProcess
// ---------------------------------------------------------------------------

test('engine: isAlive returns true before exit, false after natural exit (worker)', async () => {
  // Workers exit naturally (exit code 0) after emitting result.
  // isAlive checks proc.exitCode === null — set to 0 on natural exit → false.
  process.env.CLAUDE_BIN = fakeClaudioPath;
  const { engine } = makeEngine();

  engine.spawnAgent('run-lifecycle', { cwd: os.tmpdir(), prompt: 'x', isManager: false });

  assert.equal(engine.isAlive('run-lifecycle'), true, 'spawn 직후 alive');

  // Worker: fake-claude exits naturally with code 0 after emitting result.
  // Wait for the process to exit.
  const deadline = Date.now() + 2000;
  while (engine.isAlive('run-lifecycle') && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 20));
  }

  assert.equal(engine.isAlive('run-lifecycle'), false, '자연 종료 후 not alive');
});

test('engine: detectExitCode returns null while alive, 0 after natural exit (worker)', async () => {
  // Workers exit with code 0 naturally. SIGTERM exits with code=null (signal kill),
  // so we use a worker that exits naturally.
  process.env.CLAUDE_BIN = fakeClaudioPath;
  const { engine } = makeEngine();

  engine.spawnAgent('run-exitcode', { cwd: os.tmpdir(), prompt: 'x', isManager: false });
  assert.equal(engine.detectExitCode('run-exitcode'), null, 'exit 전 null');

  // Wait for natural exit
  const deadline = Date.now() + 2000;
  while (engine.isAlive('run-exitcode') && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 20));
  }

  const code = engine.detectExitCode('run-exitcode');
  assert.equal(code, 0, '자연 종료 exitCode = 0');
});

test('engine: kill returns true for alive process, false for unknown', async () => {
  process.env.CLAUDE_BIN = fakeClaudioPath;
  const { engine } = makeEngine();

  // Use a manager process so it stays alive long enough for us to kill it
  engine.spawnAgent('run-kill-ok', { cwd: os.tmpdir(), isManager: true });
  await waitForEvent(engine, 'run-kill-ok', e => e.type === 'system');
  assert.equal(engine.isAlive('run-kill-ok'), true);

  const killed = engine.kill('run-kill-ok');
  assert.equal(killed, true, 'kill 성공');

  const unknown = engine.kill('no-such-run');
  assert.equal(unknown, false, '알 수 없는 runId → false');
});

test('engine: hasProcess returns true after spawn, false for unknown', async () => {
  process.env.CLAUDE_BIN = fakeClaudioPath;
  const { engine } = makeEngine();

  engine.spawnAgent('run-has', { cwd: os.tmpdir(), isManager: false });

  assert.equal(engine.hasProcess('run-has'), true);
  assert.equal(engine.hasProcess('unknown-run-9999'), false);
});

// ---------------------------------------------------------------------------
// 5. getOutput / getEvents / getUsage / getSessionId / listSessions
// ---------------------------------------------------------------------------

test('engine: getOutput returns null for unknown runId', () => {
  process.env.CLAUDE_BIN = fakeClaudioPath;
  const { engine } = makeEngine();
  assert.equal(engine.getOutput('no-such'), null);
});

test('engine: getEvents returns empty array for unknown runId', () => {
  process.env.CLAUDE_BIN = fakeClaudioPath;
  const { engine } = makeEngine();
  assert.deepEqual(engine.getEvents('no-such'), []);
});

test('engine: getEvents afterIndex slices from that offset', async () => {
  process.env.CLAUDE_BIN = fakeClaudioPath;
  const { engine } = makeEngine();

  engine.spawnAgent('run-slice', { cwd: os.tmpdir(), isManager: false });

  // system:init 이벤트 대기
  await waitForEvent(engine, 'run-slice', e => e.type === 'system');

  const all = engine.getEvents('run-slice');
  assert.ok(all.length >= 1, '최소 1개 이벤트');

  const sliced = engine.getEvents('run-slice', 1);
  assert.equal(sliced.length, all.length - 1, 'afterIndex=1 → 첫 이벤트 제외');
});

test('engine: listSessions includes spawned processes with correct shape', async (t) => {
  process.env.CLAUDE_BIN = fakeClaudioPath;
  const { engine } = makeEngine();
  t.after(() => engine.kill('run-list-sess'));

  engine.spawnAgent('run-list-sess', { cwd: os.tmpdir(), isManager: true });
  await waitForEvent(engine, 'run-list-sess', e => e.type === 'system');

  const sessions = engine.listSessions();
  const s = sessions.find(x => x.name === 'claude-run-list-sess');
  assert.ok(s, 'listSessions에 run 포함');
  assert.ok(typeof s.pid === 'number', 'pid는 숫자');
  assert.equal(s.alive, true);
  assert.equal(s.isManager, true);
  assert.equal(s.isPalantir, true);
  assert.equal(s.sessionId, 'fake-sess', 'system:init에서 설정된 sessionId');
});

test('engine: getSessionId returns fake-sess after init event', async () => {
  process.env.CLAUDE_BIN = fakeClaudioPath;
  const { engine } = makeEngine();

  engine.spawnAgent('run-sessid', { cwd: os.tmpdir(), isManager: false });
  await waitForEvent(engine, 'run-sessid', e => e.type === 'system');

  assert.equal(engine.getSessionId('run-sessid'), 'fake-sess');
  assert.equal(engine.getSessionId('unknown'), null);
});

test('engine: isAlive returns false for unknown runId', () => {
  process.env.CLAUDE_BIN = fakeClaudioPath;
  const { engine } = makeEngine();
  assert.equal(engine.isAlive('ghost-run'), false);
});
