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
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PassThrough } = require('node:stream');

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

// The fake binary must live under server/tests/fixtures/ so spawnGuard can
// allow it while blocking real Claude/Codex CLIs during node --test.
const fakeClaudioPath = path.join(__dirname, 'fixtures', 'bin', 'fake-claude-stream-json.js');

// ---------------------------------------------------------------------------
// 헬퍼: 엔진 생성 (매 테스트마다 독립 인스턴스)
// ---------------------------------------------------------------------------

function makeRunService() {
  const events = [];
  const statusUpdates = [];
  const claudeSessionUpdates = [];
  const runs = new Map();
  return {
    _events: events,
    _statusUpdates: statusUpdates,
    _claudeSessionUpdates: claudeSessionUpdates,
    addRunEvent(runId, type, data) { events.push({ runId, type, data }); },
    updateRunStatus(runId, status) { statusUpdates.push({ runId, status }); },
    updateRunResult(runId, result) {},
    updateClaudeSessionId(runId, sessionId) { claudeSessionUpdates.push({ runId, sessionId }); },
    getRun(runId) { return runs.get(runId) || null; },
    _setRun(runId, run) { runs.set(runId, run); },
  };
}

function createFakeRemoteChild() {
  const child = new EventEmitter();
  const stdin = {
    writes: [],
    endCalls: 0,
    destroyed: false,
    writable: true,
    writableEnded: false,
    write(chunk) {
      this.writes.push(String(chunk));
      return true;
    },
    end() {
      this.endCalls += 1;
      this.writableEnded = true;
      this.writable = false;
    },
  };
  child.pid = 424242;
  child.stdin = stdin;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killSignal = null;
  child.kill = (signal) => {
    child.killSignal = signal;
    child.emit('exit', null, signal);
    return true;
  };
  return child;
}

function writeGeneratedFixtureExecutable(source) {
  const file = path.join(
    __dirname,
    'fixtures',
    'bin',
    `generated-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.js`
  );
  fs.writeFileSync(file, source);
  fs.chmodSync(file, 0o755);
  return file;
}

async function spawnFakeRemoteManager(engine, runId, child, opts = {}) {
  const executor = {
    spawnInteractive() {
      return child;
    },
  };
  engine.spawnAgent(runId, {
    cwd: '/pod/ws',
    isManager: true,
    executor,
    nodePrefix: '/pod/bin',
    ...opts,
  });
  await new Promise((r) => setImmediate(r));
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
async function spawnAndCaptureArgs(engine, runId, opts, timeoutMs = 2500) {
  // Phase Test-Stabilize (2026-04-27): bumped from 1000ms → 2500ms.
  // Under parallel test pressure (CI / sequential `npm test` with
  // sibling tests doing tmp-dir work) the fakeClaude child sometimes
  // took >1s to flush its args file, surfacing as
  // 'args file not written within 1000ms' on shared disks.
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

test('engine: remote executor uses pod cwd/env/pathPrefix and preserves stream-json stdin', async () => {
  const { createStreamJsonEngine } = require('../services/streamJsonEngine');
  const rs = makeRunService();
  const child = createFakeRemoteChild();
  const spawnCalls = [];
  const executor = {
    spawnInteractive(command, args, options) {
      spawnCalls.push({ command, args, options });
      return child;
    },
  };
  const engine = createStreamJsonEngine({ runService: rs });
  const systemPrompt = 'Use the remote pod auth and tools.';

  const result = engine.spawnAgent('run-remote-executor', {
    cwd: '/pod/ws',
    systemPrompt,
    isManager: true,
    executor,
    nodePrefix: '/pod/bin',
  });

  // Remote spawnInteractive is async (a remote realpath guard) — spawnAgent
  // returns synchronously with pid:null (fire-and-forget); the ssh duplex child
  // attaches on a later microtask. Drain it before inspecting the spawn call.
  assert.equal(result.pid, null);
  await new Promise((r) => setImmediate(r));

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, 'claude');
  assert.deepEqual(spawnCalls[0].options, {
    cwd: '/pod/ws',
    env: {},
    pathPrefix: '/pod/bin',
  });
  assert.ok(spawnCalls[0].args.includes('--input-format'));
  assert.ok(spawnCalls[0].args.includes('stream-json'));
  const systemPromptIndex = spawnCalls[0].args.indexOf('--append-system-prompt');
  assert.notEqual(systemPromptIndex, -1);
  assert.equal(spawnCalls[0].args[systemPromptIndex + 1], systemPrompt);

  child.stdout.write(JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 'remote-sess',
    model: 'claude-remote',
    tools: ['Read'],
    cwd: '/pod/ws',
  }) + '\n');

  await waitForEvent(engine, 'run-remote-executor', e => e.type === 'system');
  assert.equal(engine.getSessionId('run-remote-executor'), 'remote-sess');
  assert.deepEqual(rs._claudeSessionUpdates, [
    { runId: 'run-remote-executor', sessionId: 'remote-sess' },
  ]);

  const ok = engine.sendInput('run-remote-executor', 'hello remote');
  assert.equal(ok, true);
  assert.equal(child.stdin.endCalls, 0);
  assert.equal(child.stdin.writableEnded, false);
  assert.equal(child.stdin.writes.length, 1);
  assert.deepEqual(JSON.parse(child.stdin.writes[0].trim()), {
    type: 'user',
    message: { role: 'user', content: 'hello remote' },
  });

  assert.equal(engine.kill('run-remote-executor'), true);
  assert.equal(child.killSignal, 'SIGTERM');
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

  // Phase Test-Stabilize (2026-04-27): the `result` event fires while
  // the child process is still in the middle of teardown — its stdin
  // is technically still `writable` for a few event-loop ticks after
  // the event drains. Poll engine.isAlive() until it returns false
  // (the child's `exit` listener flips proc.exitCode away from null)
  // so `sendInput` reliably observes the closed stdin instead of
  // racing the exit.
  const exitDeadline = Date.now() + 2000;
  while (Date.now() < exitDeadline) {
    if (!engine.isAlive('run-send-wkr')) break;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(engine.isAlive('run-send-wkr'), false,
    'engine should mark the run as not-alive once the worker exits');

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

test('engine: remote ssh transport drop becomes unreachable without finalizing failed', async () => {
  const { createStreamJsonEngine } = require('../services/streamJsonEngine');
  const rs = makeRunService();
  rs._setRun('run-remote-drop', { status: 'running' });
  const child = createFakeRemoteChild();
  const engine = createStreamJsonEngine({ runService: rs });

  await spawnFakeRemoteManager(engine, 'run-remote-drop', child);
  child.stdout.write(JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 'remote-drop-sess',
    model: 'claude-remote',
    tools: [],
    cwd: '/pod/ws',
  }) + '\n');
  await waitForEvent(engine, 'run-remote-drop', e => e.type === 'system');

  child.emit('exit', 255, null);

  assert.equal(engine.isAlive('run-remote-drop'), false);
  assert.equal(engine.detectExitCode('run-remote-drop'), null);
  assert.equal(engine.isUnreachable('run-remote-drop'), true);
  assert.equal(engine.getSessionId('run-remote-drop'), 'remote-drop-sess');

  const failedUpdates = rs._statusUpdates.filter(
    u => u.runId === 'run-remote-drop' && u.status === 'failed'
  );
  assert.equal(failedUpdates.length, 0, 'transport drop must not finalize failed');

  const transportEvents = rs._events.filter(
    e => e.runId === 'run-remote-drop' && e.type === 'transport_lost'
  );
  assert.equal(transportEvents.length, 1);
  assert.deepEqual(JSON.parse(transportEvents[0].data), {
    node: 'remote',
    reason: 'ssh_transport_drop',
    code: 255,
  });
  assert.equal(
    rs._events.some(e => e.runId === 'run-remote-drop' && e.type === 'exit'),
    false,
    'transport drop must not be reported as a definitive exit'
  );

  // Codex P5-S2 R2: sendInput must reject a write to an unreachable proc even
  // though exitCode is still null (would otherwise write to a dead ssh child).
  assert.equal(engine.sendInput('run-remote-drop', 'hi'), false);
  // listSessions must not report an unreachable proc as alive (old two-state
  // check was exitCode===null && !spawnError, which stayed true here).
  const droppedSession = engine.listSessions().find(s => s.sessionId === 'remote-drop-sess');
  assert.ok(droppedSession && droppedSession.alive === false, 'unreachable session not listed alive');
});

test('engine: remote ssh transport drop records concrete node id when provided', async () => {
  const { createStreamJsonEngine } = require('../services/streamJsonEngine');
  const rs = makeRunService();
  const child = createFakeRemoteChild();
  const engine = createStreamJsonEngine({ runService: rs });
  const executor = {
    spawnInteractive() {
      return Promise.resolve(child);
    },
  };

  engine.spawnAgent('run-remote-drop-node', {
    cwd: '/pod/ws',
    systemPrompt: 'sp',
    isManager: true,
    executor,
    nodePrefix: '/pod/bin',
    nodeId: 'pod-a',
  });
  await new Promise((resolve) => setImmediate(resolve));

  child.emit('exit', 255, null);

  const transportEvents = rs._events.filter(
    e => e.runId === 'run-remote-drop-node' && e.type === 'transport_lost'
  );
  assert.equal(transportEvents.length, 1);
  assert.deepEqual(JSON.parse(transportEvents[0].data), {
    node: 'pod-a',
    reason: 'ssh_transport_drop',
    code: 255,
  });
});

test('engine: remote natural exit finalizes completed with real exit code', async () => {
  const { createStreamJsonEngine } = require('../services/streamJsonEngine');
  const rs = makeRunService();
  rs._setRun('run-remote-natural', { status: 'running' });
  const child = createFakeRemoteChild();
  const engine = createStreamJsonEngine({ runService: rs });

  await spawnFakeRemoteManager(engine, 'run-remote-natural', child);
  child.emit('exit', 0, null);

  assert.equal(engine.isAlive('run-remote-natural'), false);
  assert.equal(engine.detectExitCode('run-remote-natural'), 0);
  assert.equal(engine.isUnreachable('run-remote-natural'), false);
  assert.ok(
    rs._statusUpdates.some(u => u.runId === 'run-remote-natural' && u.status === 'completed'),
    'natural remote exit must finalize completed'
  );
});

test('engine: signal-only exit marks process not alive without unreachable state', async () => {
  const { createStreamJsonEngine } = require('../services/streamJsonEngine');
  const child = createFakeRemoteChild();
  const engine = createStreamJsonEngine();

  await spawnFakeRemoteManager(engine, 'run-signal-exit', child);
  child.emit('exit', null, 'SIGTERM');

  assert.equal(engine.isAlive('run-signal-exit'), false);
  assert.equal(engine.detectExitCode('run-signal-exit'), null);
  assert.equal(engine.isUnreachable('run-signal-exit'), false);
});

test('engine: local nonzero exit behavior is unchanged', async (t) => {
  const { createStreamJsonEngine } = require('../services/streamJsonEngine');
  const rs = makeRunService();
  rs._setRun('run-local-exit-1', { status: 'running' });
  const exitOneBin = writeGeneratedFixtureExecutable(`#!/usr/bin/env node
'use strict';
process.exit(1);
`);
  t.after(() => {
    try { fs.unlinkSync(exitOneBin); } catch { /* ignore */ }
  });

  const prev = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = exitOneBin;
  const engine = createStreamJsonEngine({ runService: rs });
  _allEngines.push(engine);
  try {
    engine.spawnAgent('run-local-exit-1', {
      cwd: os.tmpdir(),
      prompt: 'x',
      isManager: false,
    });
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = prev;
  }

  const deadline = Date.now() + 2000;
  while (engine.isAlive('run-local-exit-1') && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 20));
  }

  assert.equal(engine.isAlive('run-local-exit-1'), false);
  assert.equal(engine.detectExitCode('run-local-exit-1'), 1);
  assert.equal(engine.isUnreachable('run-local-exit-1'), false);
  assert.ok(
    rs._statusUpdates.some(u => u.runId === 'run-local-exit-1' && u.status === 'failed'),
    'local exit(1) must still finalize failed'
  );
});

test('engine: remote kill before child attaches signals the resolved child (no orphan)', async () => {
  // A dispose/kill that lands while the async remote spawn is still resolving
  // must not leave the later-attached ssh child alive and unowned. Codex P5-S0.
  const { createStreamJsonEngine } = require('../services/streamJsonEngine');
  const rs = makeRunService();
  const child = createFakeRemoteChild();
  let resolveSpawn;
  const executor = {
    spawnInteractive() { return new Promise((r) => { resolveSpawn = () => r(child); }); },
  };
  const engine = createStreamJsonEngine({ runService: rs });
  engine.spawnAgent('run-kill-race', {
    cwd: '/pod/ws', systemPrompt: 'x', isManager: true, prompt: 'hi', executor, nodePrefix: '/pod/bin',
  });
  await new Promise((r) => setImmediate(r)); // let the fire-and-forget call spawnInteractive (still pending)
  assert.equal(engine.isAlive('run-kill-race'), true); // child not attached yet, but proc exists
  assert.equal(engine.kill('run-kill-race'), true);    // dispose while child still pending → killPending
  resolveSpawn();                                       // now the ssh child lands
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  // The core BLOCKER fix: the freshly-landed ssh child is OWNED and SIGNALLED
  // (not left alive & unowned). It never received the initial prompt.
  assert.equal(child.killSignal, 'SIGTERM');            // freshly-attached child was signalled
  assert.equal(child.stdin.writes.length, 0);           // initial prompt skipped
  assert.equal(engine.isAlive('run-kill-race'), false);  // signal-only exit is terminal
  assert.equal(engine.isUnreachable('run-kill-race'), false);
});

test('engine: local sync spawn throw leaves no phantom process', () => {
  // The proc record is inserted up-front (so a remote async spawn can attach
  // later); a LOCAL sync throw must remove it — byte-equivalent to before, which
  // only inserted the record after a successful spawn. Codex P5-S0.
  const { createStreamJsonEngine } = require('../services/streamJsonEngine');
  const rs = makeRunService();
  const engine = createStreamJsonEngine({ runService: rs });
  const prev = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = '/nonexistent/disallowed/claude'; // spawnGuard rejects → sync throw
  try {
    assert.throws(() => engine.spawnAgent('run-local-throw', {
      cwd: process.cwd(), systemPrompt: 'x', isManager: true, prompt: 'hi',
    }));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = prev;
  }
  assert.equal(engine.isAlive('run-local-throw'), false);
  assert.equal(engine.getSessionId('run-local-throw'), null);
});

test('P5-S4b: sendInput before a remote child attaches is buffered and flushed on attach', async () => {
  // A REMOTE manager spawn is async (fire-and-forget) — a message sent right
  // after startSession lands before the ssh child resolves. sendInput must
  // buffer it (accepted:true) and attachChild must flush it in order. Real-Pi
  // caught this (local sync spawn never hits it).
  const { createStreamJsonEngine } = require('../services/streamJsonEngine');
  const rs = makeRunService();
  const child = createFakeRemoteChild();
  let resolveSpawn;
  const executor = {
    spawnInteractive() { return new Promise((r) => { resolveSpawn = () => r(child); }); },
  };
  const engine = createStreamJsonEngine({ runService: rs });
  engine.spawnAgent('run-buf', {
    cwd: '/pod/ws', systemPrompt: 'sp', isManager: true, executor, nodePrefix: '/pod/bin',
  });
  await new Promise((r) => setImmediate(r)); // spawnInteractive called; child still pending

  assert.equal(engine.sendInput('run-buf', 'first message'), true, 'buffered send is accepted');
  assert.equal(child.stdin.writes.length, 0, 'nothing written before the child attaches');

  resolveSpawn();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(child.stdin.writes.length, 1, 'buffered message flushed on attach');
  assert.deepEqual(JSON.parse(child.stdin.writes[0].trim()), {
    type: 'user', message: { role: 'user', content: 'first message' },
  });
});

test('P5-S4b: dispose before a remote child attaches drops buffered input (killPending terminal)', async () => {
  const { createStreamJsonEngine } = require('../services/streamJsonEngine');
  const rs = makeRunService();
  const child = createFakeRemoteChild();
  let resolveSpawn;
  const executor = { spawnInteractive() { return new Promise((r) => { resolveSpawn = () => r(child); }); } };
  const engine = createStreamJsonEngine({ runService: rs });
  engine.spawnAgent('run-kill-buf', { cwd: '/pod/ws', systemPrompt: 'sp', isManager: true, executor, nodePrefix: '/pod/bin' });
  await new Promise((r) => setImmediate(r));
  assert.equal(engine.sendInput('run-kill-buf', 'buffered'), true);       // buffered pre-attach
  assert.equal(engine.kill('run-kill-buf'), true);                        // dispose → killPending + clears buffer
  assert.equal(engine.sendInput('run-kill-buf', 'after kill'), false);    // killPending is terminal
  resolveSpawn();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(child.killSignal, 'SIGTERM');       // freshly-attached child signalled
  assert.equal(child.stdin.writes.length, 0);      // NO buffered input flushed to a disposed operator
});

test('P5-S4b: pending input buffer is bounded on a hung remote spawn', async () => {
  const { createStreamJsonEngine } = require('../services/streamJsonEngine');
  const rs = makeRunService();
  const executor = { spawnInteractive() { return new Promise(() => {}); } }; // never resolves (hung node)
  const engine = createStreamJsonEngine({ runService: rs });
  engine.spawnAgent('run-cap', { cwd: '/pod/ws', systemPrompt: 'sp', isManager: true, executor, nodePrefix: '/pod/bin' });
  await new Promise((r) => setImmediate(r));
  let accepted = 0;
  for (let i = 0; i < 40; i += 1) { if (engine.sendInput('run-cap', `msg ${i}`)) accepted += 1; }
  assert.ok(accepted > 0 && accepted <= 32, `pending buffer capped at 32 (accepted ${accepted})`);
  assert.equal(engine.sendInput('run-cap', 'overflow'), false, 'beyond cap → rejected');
});
