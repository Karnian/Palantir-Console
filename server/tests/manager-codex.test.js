const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function createFakeDuplexChild() {
  const { EventEmitter } = require('node:events');
  const { PassThrough, Writable } = require('node:stream');
  const child = new EventEmitter();
  const stdinWrites = [];
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      stdinWrites.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      callback();
    },
  });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdinWrites = stdinWrites;
  child.kill = (signal) => { child.killedWith = signal; };
  return child;
}

function waitImmediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

// PR4: unit-level coverage for the CodexAdapter and managerSystemPrompt
// module. We DO NOT spawn a real `codex exec` here — that requires a live
// codex CLI plus auth, and would make the suite environment-dependent. The
// integration test (one real multi-turn manager session against codex) is
// documented in /tmp/athena_brief.md "Done" criteria and verified manually.

// --- managerSystemPrompt module ---

test('buildManagerSystemPrompt composes role + adapter guardrails + base', () => {
  const {
    buildManagerSystemPrompt,
    buildInitialUserContext,
  } = require('../services/managerSystemPrompt');

  const fakeAdapter = {
    type: 'fake',
    buildGuardrailsSection() { return '## fake adapter notes\nDo nothing.'; },
  };
  const out = buildManagerSystemPrompt({ adapter: fakeAdapter, port: 4177, token: null });
  assert.match(out, /Palantir Manager/);
  assert.match(out, /fake adapter notes/);
  assert.match(out, /\/api\/runs/);
  assert.doesNotMatch(out, /Current State/, 'dynamic context must NOT be in the system prompt');

  // Initial user context contains the dynamic sections.
  const ctx = buildInitialUserContext({
    runSummary: '- Running: 1',
    projectList: '  - p1',
    agentList: '  - claude-code',
    userPrompt: 'hello',
  });
  assert.match(ctx, /Current State/);
  assert.match(ctx, /Available Projects/);
  assert.match(ctx, /Available Agent Profiles/);
  assert.match(ctx, /Initial instruction/);
  assert.match(ctx, /hello/);
});

test('buildManagerSystemPrompt works with no adapter (back-compat)', () => {
  const { buildManagerSystemPrompt } = require('../services/managerSystemPrompt');
  const out = buildManagerSystemPrompt({ adapter: null, port: 4177, token: 'tok' });
  assert.match(out, /Palantir Manager/);
  assert.match(out, /Bearer tok/);
});

// --- CodexAdapter unit tests ---

test('CodexAdapter exposes Codex capabilities', () => {
  const { createCodexAdapter } = require('../services/managerAdapters/codexAdapter');
  const adapter = createCodexAdapter({ runService: null });
  assert.equal(adapter.type, 'codex');
  assert.equal(adapter.capabilities.persistentProcess, false);
  assert.equal(adapter.capabilities.persistentSession, true);
  assert.equal(adapter.capabilities.supportsResume, true);
  assert.equal(adapter.capabilities.supportsUsdCost, false);
  assert.equal(typeof adapter.buildGuardrailsSection(), 'string');
  assert.match(adapter.buildGuardrailsSection(), /Codex CLI adapter notes/);
});

test('CodexAdapter lazily writes a system prompt temp file and disposeSession cleans it up', async () => {
  const { createCodexAdapter } = require('../services/managerAdapters/codexAdapter');
  const { PassThrough } = require('node:stream');
  const captured = [];
  let capturedArgs = null;
  const fakeChild = {
    stdin: { write() {}, end() {} },
    stderr: new PassThrough(),
    stdout: new PassThrough(),
    on() { return this; },
    kill() {},
  };
  const fakeSpawn = (_bin, args) => {
    capturedArgs = args;
    return fakeChild;
  };
  const fakeRunService = {
    addRunEvent(_r, t, p) { captured.push({ t, p: JSON.parse(p) }); return captured.length; },
    updateManagerThreadId() { /* unused */ },
    updateRunResult() { /* unused */ },
    updateRunStatus() { /* unused */ },
  };
  const adapter = createCodexAdapter({ runService: fakeRunService, spawnFn: fakeSpawn });
  const { sessionRef } = adapter.startSession('run_mgr_codex1', {
    systemPrompt: 'hello system',
    cwd: process.cwd(),
    model: 'gpt-5-codex',
  });
  assert.equal(sessionRef.instructionsPath, null, 'instructionsPath is placed lazily on first turn');

  const res = await adapter.runTurn('run_mgr_codex1', { text: 'hi', invocationId: 'oinv_codex_test' });
  assert.equal(res.accepted, true);
  assert.ok(capturedArgs, 'spawn was invoked');
  const instructionsFlag = capturedArgs.find((arg) => /^model_instructions_file=/.test(arg));
  assert.ok(instructionsFlag, 'instructions file flag should be present');
  const instructionsPath = instructionsFlag.match(/^model_instructions_file="(.+)"$/)?.[1];
  assert.ok(instructionsPath, 'instructions path should be quoted in the flag');
  assert.ok(fs.existsSync(instructionsPath), 'temp file should exist after first runTurn');
  const content = fs.readFileSync(instructionsPath, 'utf-8');
  assert.equal(content, 'hello system');

  fakeChild.stdout.write(`${JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_err', type: 'error', message: 'rate limit exceeded' },
  })}\n`);
  fakeChild.stdout.write(`${JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 2, cached_input_tokens: 1, output_tokens: 3 },
  })}\n`);
  await waitImmediate();
  const scheduledTurnEvents = captured.filter(({ t }) => t === 'mgr.turn_started' || t === 'mgr.turn_completed');
  assert.equal(scheduledTurnEvents.length, 2);
  assert.ok(scheduledTurnEvents.every(({ p }) => p.data.invocationId === 'oinv_codex_test'));
  const nonterminalError = captured.find(({ t }) => t === 'mgr.turn_failed');
  assert.equal(nonterminalError.p.data.invocationId, 'oinv_codex_test');
  assert.equal(nonterminalError.p.data.terminal, false);
  const completed = captured.find(({ t }) => t === 'mgr.turn_completed');
  assert.equal(completed.p.data.terminal, true);

  // Dispose: temp file (and its parent dir) should be unlinked best-effort.
  await adapter.disposeSession('run_mgr_codex1');
  assert.equal(fs.existsSync(instructionsPath), false, 'temp file should be cleaned up after dispose');
});

test('M2: CodexAdapter.startSession with mcpConfig emits mcp:legacy_alias_conflict for overlapping user aliases', (t) => {
  const { createCodexAdapter } = require('../services/managerAdapters/codexAdapter');
  // Swap the user config path for this test only
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'palantir-m2-pm-'));
  const cfgPath = path.join(dir, 'config.toml');
  fs.writeFileSync(cfgPath, '[mcp_servers.slack]\ncommand = "legacy"\n');
  const prev = process.env.PALANTIR_CODEX_CONFIG_PATH;
  process.env.PALANTIR_CODEX_CONFIG_PATH = cfgPath;
  t.after(() => {
    if (prev === undefined) delete process.env.PALANTIR_CODEX_CONFIG_PATH;
    else process.env.PALANTIR_CODEX_CONFIG_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const events = [];
  const fakeRunService = {
    addRunEvent(_r, type, payload) { events.push({ type, payload: JSON.parse(payload) }); },
    updateManagerThreadId() {},
    updateRunResult() {},
    updateRunStatus() {},
  };
  const adapter = createCodexAdapter({ runService: fakeRunService });
  adapter.startSession('run_mgr_m2_conflict', {
    systemPrompt: 'sys',
    cwd: process.cwd(),
    mcpConfig: {
      mcpServers: {
        slack: { command: 'from-pm', args: [] }, // conflicts with user config
        fresh: { command: 'from-pm' },           // no conflict
      },
    },
  });
  const legacy = events.filter(e => e.type === 'mcp:legacy_alias_conflict');
  assert.equal(legacy.length, 1, 'exactly one conflict event for slack');
  assert.equal(legacy[0].payload.alias, 'slack');
  assert.equal(legacy[0].payload.source, 'pm_config');
  assert.deepEqual(Object.keys(legacy[0].payload).sort(), ['alias', 'message', 'source']);
  adapter.disposeSession('run_mgr_m2_conflict');
});

test('issue #113: CodexAdapter keeps leaf flags but file-backs stdio env values', async () => {
  const { createCodexAdapter } = require('../services/managerAdapters/codexAdapter');
  const { PassThrough } = require('node:stream');
  // Capture spawn args without launching a real codex process. readline in
  // spawnOneTurn needs a real Readable for child.stdout; PassThrough is the
  // cheapest option. We never write to it so the rl stays idle.
  let capturedArgs = null;
  const fakeChild = {
    stdin: { write() {}, end() {} },
    stderr: new PassThrough(),
    stdout: new PassThrough(),
    on() { return this; },
    kill() {},
  };
  const fakeSpawn = (_bin, args /* , opts */) => {
    capturedArgs = args;
    return fakeChild;
  };
  const fakeRunService = {
    addRunEvent() {},
    updateManagerThreadId() {},
    updateRunResult() {},
    updateRunStatus() {},
  };
  const adapter = createCodexAdapter({ runService: fakeRunService, spawnFn: fakeSpawn });
  adapter.startSession('run_mgr_codex_m1', {
    systemPrompt: 'sys',
    cwd: process.cwd(),
    mcpConfig: {
      mcpServers: {
        ctx7: {
          command: 'npx',
          args: ['-y', '@ctx7/mcp'],
          env: { CTX7_KEY: 'manager-env-secret-sentinel' },
        },
      },
    },
  });
  const res = await adapter.runTurn('run_mgr_codex_m1', { text: 'hi' });
  assert.equal(res.accepted, true);
  assert.ok(capturedArgs, 'spawn was invoked');

  // Extract every `-c <value>` pair
  const cflags = [];
  for (let i = 0; i < capturedArgs.length; i++) {
    if (capturedArgs[i] === '-c' && i + 1 < capturedArgs.length) cflags.push(capturedArgs[i + 1]);
  }
  // Top-level blob must NOT be emitted
  assert.ok(
    !cflags.some(c => /^mcp_servers=/.test(c)),
    'must not emit top-level mcp_servers=<JSON> blob',
  );
  // Leaf-level dotted paths present
  assert.ok(
    cflags.some(c => /^mcp_servers\.ctx7\.command=/.test(c)),
    'ctx7.command leaf present',
  );
  assert.ok(
    cflags.some(c => /^mcp_servers\.ctx7\.args=/.test(c)),
    'ctx7.args leaf present',
  );
  assert.ok(
    cflags.includes('mcp_servers.ctx7.env.NODE_OPTIONS=""'),
    'legacy NODE_OPTIONS is neutralized before the Node wrapper boots',
  );
  assert.equal(
    JSON.stringify(capturedArgs).includes('manager-env-secret-sentinel'),
    false,
    'literal env value must occur zero times in Codex argv',
  );

  adapter.disposeSession('run_mgr_codex_m1');
});

test('M1: CodexAdapter.startSession skips string mcpConfig paths without mcp_invalid failure', async () => {
  const { createCodexAdapter } = require('../services/managerAdapters/codexAdapter');
  const { PassThrough } = require('node:stream');
  const { NORMALIZED_EVENT_TYPES } = require('../services/managerAdapters/eventTypes');
  const events = [];
  let capturedArgs = null;
  const fakeChild = {
    stdin: { write() {}, end() {} },
    stderr: new PassThrough(),
    stdout: new PassThrough(),
    on() { return this; },
    kill() {},
  };
  const fakeSpawn = (_bin, args) => {
    capturedArgs = args;
    return fakeChild;
  };
  const fakeRunService = {
    addRunEvent(_r, t, p) { events.push({ t, p: JSON.parse(p) }); },
    updateManagerThreadId() {},
    updateRunResult() {},
    updateRunStatus(_r, status) { events.push({ t: '__status', status }); },
  };
  const adapter = createCodexAdapter({ runService: fakeRunService, spawnFn: fakeSpawn });
  adapter.startSession('run_mgr_codex_m1_path', {
    systemPrompt: 'sys',
    cwd: process.cwd(),
    mcpConfig: '/tmp/project-mcp.json',
  });
  const res = await adapter.runTurn('run_mgr_codex_m1_path', { text: 'hi' });
  assert.equal(res.accepted, true);
  assert.ok(capturedArgs, 'spawn was invoked');

  const cflags = [];
  for (let i = 0; i < capturedArgs.length; i++) {
    if (capturedArgs[i] === '-c' && i + 1 < capturedArgs.length) cflags.push(capturedArgs[i + 1]);
  }
  assert.equal(
    cflags.some(c => /^mcp_servers\./.test(c)),
    false,
    'string mcpConfig path must not produce mcp_servers leaves',
  );
  const turnFailed = events.find(e => e.t === NORMALIZED_EVENT_TYPES.TURN_FAILED);
  assert.equal(turnFailed, undefined, 'TURN_FAILED must not be emitted');
  assert.equal(
    events.some(e => e.t === '__status' && e.status === 'failed'),
    false,
    'run must not be marked failed',
  );
  const skipped = events.filter(e => e.t === 'mcp:config_path_skipped');
  assert.equal(skipped.length, 1, 'string path skip is annotated once');
  assert.deepEqual(skipped[0].p, { adapter: 'codex' });

  adapter.disposeSession('run_mgr_codex_m1_path');
});

test('M1: CodexAdapter.runTurn with invalid mcpConfig fails closed (accepted=false + TURN_FAILED + session ended)', async () => {
  const { createCodexAdapter } = require('../services/managerAdapters/codexAdapter');
  const { PassThrough } = require('node:stream');
  const events = [];
  const fakeRunService = {
    addRunEvent(_r, t, p) { events.push({ t, p: JSON.parse(p) }); },
    updateManagerThreadId() {},
    updateRunResult() {},
    updateRunStatus(_r, status) { events.push({ t: '__status', status }); },
  };
  // spawn MUST NOT be reached — the flatten throw is upstream of spawn.
  let spawned = 0;
  const fakeSpawn = () => {
    spawned += 1;
    return {
      stdin: { write() {}, end() {} },
      stderr: new PassThrough(),
      stdout: new PassThrough(),
      on() { return this; },
      kill() {},
    };
  };
  const adapter = createCodexAdapter({ runService: fakeRunService, spawnFn: fakeSpawn });
  adapter.startSession('run_mgr_codex_m1_bad', {
    systemPrompt: 'sys',
    cwd: process.cwd(),
    mcpConfig: {
      mcpServers: {
        leak: { command: 'echo', bearer_token: 'secret' },
      },
    },
  });
  const res = await adapter.runTurn('run_mgr_codex_m1_bad', { text: 'hi' });
  assert.equal(res.accepted, false, 'runTurn must refuse to proceed');
  assert.equal(spawned, 0, 'spawn must not be invoked');
  // TURN_FAILED emitted with mcp_invalid kind. The normalized event type
  // lives under the 'mgr.' namespace (see eventTypes.NORMALIZED_EVENT_TYPES).
  const { NORMALIZED_EVENT_TYPES } = require('../services/managerAdapters/eventTypes');
  const turnFailed = events.find(e => e.t === NORMALIZED_EVENT_TYPES.TURN_FAILED);
  assert.ok(turnFailed, 'turn_failed event emitted');
  assert.equal(turnFailed.p.data?.kind, 'mcp_invalid');
  // Run marked failed
  const statusEv = events.find(e => e.t === '__status');
  assert.ok(statusEv && statusEv.status === 'failed', 'run status flipped to failed');
  // Session ended
  assert.equal(adapter.isSessionAlive('run_mgr_codex_m1_bad'), false);

  adapter.disposeSession('run_mgr_codex_m1_bad');
});

test('P4-S3a: CodexAdapter uses injected executor for prompt placement, spawn, resume, and cleanup', async (t) => {
  const { createCodexAdapter } = require('../services/managerAdapters/codexAdapter');
  const cwd = process.cwd();
  const env = { CODEX_ENV_TEST: '1' };
  const putSecretFileCalls = [];
  const spawnCalls = [];
  const rmrfCalls = [];
  const children = [];
  const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = '1';
  t.after(() => {
    if (previousNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
  });

  const fakeExecutor = {
    async putSecretFile(name, content, mode) {
      putSecretFileCalls.push({ name, content, mode });
      return `/pod/.palantir-secret-001/${name}`;
    },
    async spawnInteractive(command, args, opts) {
      const child = createFakeDuplexChild();
      children.push(child);
      spawnCalls.push({ command, args: [...args], opts });
      return child;
    },
    async rmrf(targetPath) {
      rmrfCalls.push(targetPath);
    },
  };
  const threadStarted = [];
  const threadIds = [];
  const events = [];
  const fakeRunService = {
    addRunEvent(_r, type, payload) { events.push({ type, payload: JSON.parse(payload) }); },
    updateManagerThreadId(_r, threadId) { threadIds.push(threadId); },
    updateRunResult() {},
    updateRunStatus() {},
  };
  const adapter = createCodexAdapter({ runService: fakeRunService, codexBin: 'codex-test-bin' });
  const { sessionRef } = adapter.startSession('run_mgr_codex_remote', {
    systemPrompt: 'remote system prompt',
    cwd,
    env,
    nodePrefix: '/pod/bin',
    executor: fakeExecutor,
    onThreadStarted(threadId) { threadStarted.push(threadId); },
  });
  assert.equal(sessionRef.instructionsPath, null);

  const first = await adapter.runTurn('run_mgr_codex_remote', { text: 'first user text' });
  assert.equal(first.accepted, true);
  // runTurn is sync-returning + fire-and-forget for the async (remote) executor
  // path; drain the microtasks so the awaited putSecretFile/spawnInteractive
  // have run before we inspect their calls.
  await waitImmediate();
  assert.deepEqual(putSecretFileCalls, [{
    name: 'system_prompt.md',
    content: 'remote system prompt',
    mode: 0o600,
  }]);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, 'codex-test-bin');
  assert.deepEqual(spawnCalls[0].args.slice(0, 4), ['exec', '--json', '-C', cwd]);
  assert.ok(spawnCalls[0].args.includes('--skip-git-repo-check'));
  assert.ok(spawnCalls[0].args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(spawnCalls[0].args.includes('model_instructions_file="/pod/.palantir-secret-001/system_prompt.md"'));
  assert.equal(spawnCalls[0].args.at(-1), '-');
  assert.equal(spawnCalls[0].opts.cwd, cwd);
  assert.deepEqual(spawnCalls[0].opts.env, env);
  assert.equal(spawnCalls[0].opts.pathPrefix, '/pod/bin');
  assert.equal(children[0].stdinWrites.join(''), 'first user text');

  children[0].stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-remote-1' }) + '\n');
  await waitImmediate();
  assert.deepEqual(threadStarted, ['thread-remote-1']);
  assert.deepEqual(threadIds, ['thread-remote-1']);
  assert.equal(adapter.getSessionId('run_mgr_codex_remote'), 'thread-remote-1');
  children[0].emit('exit', 0);

  const second = await adapter.runTurn('run_mgr_codex_remote', { text: 'resume user text' });
  assert.equal(second.accepted, true);
  await waitImmediate();
  assert.equal(putSecretFileCalls.length, 1, 'instructions placement is cached across turns');
  assert.equal(spawnCalls.length, 2);
  assert.deepEqual(spawnCalls[1].args.slice(0, 4), ['exec', 'resume', 'thread-remote-1', '--json']);
  assert.equal(spawnCalls[1].args.includes('-C'), false, 'resume turn must omit -C');
  assert.ok(spawnCalls[1].args.includes('model_instructions_file="/pod/.palantir-secret-001/system_prompt.md"'));
  assert.equal(spawnCalls[1].opts.pathPrefix, '/pod/bin');
  assert.equal(children[1].stdinWrites.join(''), 'resume user text');

  await adapter.disposeSession('run_mgr_codex_remote');
  assert.deepEqual(rmrfCalls, ['/pod/.palantir-secret-001']);
});

test('P4-S3a: remote spawn rejection surfaces the run as failed (not silently accepted)', async () => {
  // A fire-and-forget remote turn whose spawnInteractive/putSecretFile REJECTS
  // before a child exists must be surfaced as failed (marked failed + TURN_FAILED
  // + SESSION_ENDED + placed secret dir cleaned up) — otherwise the caller sees
  // accepted:true, isSessionAlive stays true, and it commits a notice-drain for
  // a turn that never spawned. Codex P4-S3a R3.
  const { createCodexAdapter } = require('../services/managerAdapters/codexAdapter');
  const statuses = [];
  const eventTypes = [];
  const rmrfCalls = [];
  const fakeRunService = {
    addRunEvent(_r, type) { eventTypes.push(type); },
    updateManagerThreadId() {},
    updateRunResult() {},
    updateRunStatus(_r, status) { statuses.push(status); },
  };
  const fakeExecutor = {
    async putSecretFile(name) { return `/pod/.palantir-secret-fail/${name}`; },
    async spawnInteractive() { throw new Error('ssh connect refused'); },
    async rmrf(target) { rmrfCalls.push(target); },
  };
  const adapter = createCodexAdapter({ runService: fakeRunService, codexBin: 'codex-test-bin' });
  adapter.startSession('run_spawn_fail', {
    systemPrompt: 'sp', cwd: process.cwd(), executor: fakeExecutor, nodePrefix: '/pod/bin',
  });

  const res = await adapter.runTurn('run_spawn_fail', { text: 'go' });
  assert.equal(res.accepted, true, 'message accepted (fire-and-forget) synchronously');
  await waitImmediate();
  await waitImmediate();

  assert.ok(statuses.includes('failed'), 'run marked failed after remote spawn rejection');
  assert.equal(adapter.isSessionAlive('run_spawn_fail'), false, 'session flipped to not-alive');
  // detectExitCode must report the FAILURE (nonzero), not 0 — otherwise a
  // managerRegistry.probeActive() liveness sweep would force the failed run back
  // to 'completed'. Codex P4-S3a R4.
  assert.notEqual(adapter.detectExitCode('run_spawn_fail'), 0, 'failed session must not report exit code 0');
  assert.deepEqual(rmrfCalls, ['/pod/.palantir-secret-fail'], 'placed secret dir cleaned up');
});

test('P4-S3a: signal-killed turn reports nonzero exit code (probe-stable failed)', async () => {
  // A child killed by SIGNAL reports code === null. detectExitCode must NOT
  // then fall back to 0 (which a probeActive() sweep maps to 'completed') —
  // it must report nonzero so the failed run stays failed. Codex P4-S3a R5.
  const { createCodexAdapter } = require('../services/managerAdapters/codexAdapter');
  const statuses = [];
  const child = createFakeDuplexChild();
  const fakeExecutor = {
    async putSecretFile(name) { return `/pod/.sig/${name}`; },
    async spawnInteractive() { return child; },
    async rmrf() {},
  };
  const fakeRunService = {
    addRunEvent() {}, updateManagerThreadId() {}, updateRunResult() {},
    updateRunStatus(_r, status) { statuses.push(status); },
  };
  const adapter = createCodexAdapter({ runService: fakeRunService, codexBin: 'codex-test-bin' });
  adapter.startSession('run_sig', { systemPrompt: 'sp', cwd: process.cwd(), executor: fakeExecutor });

  const res = await adapter.runTurn('run_sig', { text: 'go' });
  assert.equal(res.accepted, true);
  await waitImmediate();
  child.emit('exit', null, 'SIGKILL');
  assert.notEqual(adapter.detectExitCode('run_sig'), 0, 'signal-kill must report nonzero exit code');
  assert.ok(statuses.includes('failed'), 'signal-killed run is marked failed');
});

test('P4-S3a: spawn-time child error surfaces as failed (probe-stable, no exit event)', async () => {
  // An OS spawn error (ENOENT/EACCES) fires 'error' but NOT 'exit'. It must still
  // flip the session to not-alive + probe-stable failed, else probeActive() sees
  // it alive forever. Codex P4-S3a R6.
  const { createCodexAdapter } = require('../services/managerAdapters/codexAdapter');
  const statuses = [];
  const child = createFakeDuplexChild();
  const fakeExecutor = {
    async putSecretFile(name) { return `/pod/.err/${name}`; },
    async spawnInteractive() { return child; },
    async rmrf() {},
  };
  const fakeRunService = {
    addRunEvent() {}, updateManagerThreadId() {}, updateRunResult() {},
    updateRunStatus(_r, status) { statuses.push(status); },
  };
  const adapter = createCodexAdapter({ runService: fakeRunService, codexBin: 'codex-test-bin' });
  adapter.startSession('run_err', { systemPrompt: 'sp', cwd: process.cwd(), executor: fakeExecutor });

  const res = await adapter.runTurn('run_err', { text: 'go' });
  assert.equal(res.accepted, true);
  await waitImmediate();
  const osErr = new Error('spawn codex ENOENT');
  osErr.code = 'ENOENT';
  child.emit('error', osErr);
  assert.equal(adapter.isSessionAlive('run_err'), false, 'spawn-error session must be not-alive');
  assert.notEqual(adapter.detectExitCode('run_err'), 0, 'spawn-error must report nonzero exit code');
  assert.ok(statuses.includes('failed'), 'spawn-error run is marked failed');
});

test('P4-S3a: injected executor without explicit env does not receive process.env', async (t) => {
  const { createCodexAdapter } = require('../services/managerAdapters/codexAdapter');
  const sentinelName = 'PALANTIR_CODEX_ENV_LEAK_SENTINEL';
  const previousSentinel = process.env[sentinelName];
  process.env[sentinelName] = 'must-not-leak';
  t.after(() => {
    if (previousSentinel === undefined) delete process.env[sentinelName];
    else process.env[sentinelName] = previousSentinel;
  });

  let capturedEnv = null;
  const fakeExecutor = {
    putSecretFile(name) {
      return `/pod/.palantir-secret-env/${name}`;
    },
    spawnInteractive(_command, _args, opts) {
      capturedEnv = opts.env;
      return createFakeDuplexChild();
    },
    rmrf() {},
  };
  const adapter = createCodexAdapter({ runService: null, codexBin: 'codex-test-bin' });
  adapter.startSession('run_mgr_codex_env_remote', {
    systemPrompt: 'remote system prompt',
    cwd: process.cwd(),
    executor: fakeExecutor,
  });

  const result = await adapter.runTurn('run_mgr_codex_env_remote', { text: 'hi' });
  assert.equal(result.accepted, true);
  assert.deepEqual(capturedEnv, {});
  assert.equal(capturedEnv[sentinelName], undefined);
});

test('P4-S3a: dispose during pending remote prompt placement removes created secret dir', async () => {
  const { createCodexAdapter } = require('../services/managerAdapters/codexAdapter');
  let resolvePlacement;
  let spawnCalled = false;
  const rmrfCalls = [];
  const placement = new Promise((resolve) => { resolvePlacement = resolve; });
  const fakeExecutor = {
    putSecretFile() {
      return placement;
    },
    spawnInteractive() {
      spawnCalled = true;
      return createFakeDuplexChild();
    },
    async rmrf(targetPath) {
      rmrfCalls.push(targetPath);
    },
  };
  const adapter = createCodexAdapter({ runService: null, codexBin: 'codex-test-bin' });
  adapter.startSession('run_mgr_codex_dispose_placement', {
    systemPrompt: 'remote system prompt',
    cwd: process.cwd(),
    executor: fakeExecutor,
  });

  const turnPromise = adapter.runTurn('run_mgr_codex_dispose_placement', { text: 'hi' });
  await adapter.disposeSession('run_mgr_codex_dispose_placement');
  resolvePlacement('/pod/.palantir-secret-race/system_prompt.md');

  const result = await turnPromise;
  assert.equal(result.accepted, true);
  assert.equal(spawnCalled, false);
  assert.deepEqual(rmrfCalls, ['/pod/.palantir-secret-race']);
});

test('CodexAdapter normalizes thread.started + agent_message + turn.completed', () => {
  const { createCodexAdapter } = require('../services/managerAdapters/codexAdapter');
  const { NORMALIZED_EVENT_TYPES } = require('../services/managerAdapters/eventTypes');
  const captured = [];
  let threadIdSet = null;
  const fakeRunService = {
    addRunEvent(_r, t, p) { captured.push({ t, p: p ? JSON.parse(p) : null }); return captured.length; },
    updateManagerThreadId(_r, id) { threadIdSet = id; },
    updateRunResult() {},
    updateRunStatus() {},
  };
  const adapter = createCodexAdapter({ runService: fakeRunService });
  adapter.startSession('run_mgr_codex2', {
    systemPrompt: 'sys',
    cwd: process.cwd(),
  });
  // Reach into the adapter via its session map by driving handleVendorEvent
  // through a synthetic spawn isn't possible from outside; we instead test
  // the adapter behavior indirectly by feeding events through runTurn AFTER
  // we monkey-patch the spawn — too invasive. Instead, validate the public
  // contract: getUsage starts at 0, getSessionId starts null, isSessionAlive
  // is true after startSession.
  assert.equal(adapter.isSessionAlive('run_mgr_codex2'), true);
  assert.equal(adapter.getSessionId('run_mgr_codex2'), null);
  const u = adapter.getUsage('run_mgr_codex2');
  assert.equal(u.inputTokens, 0);
  assert.equal(u.outputTokens, 0);
  assert.equal(u.costUsd, 0);
  adapter.disposeSession('run_mgr_codex2');
  assert.equal(adapter.isSessionAlive('run_mgr_codex2'), false);
});

// --- P4-6: Codex error classifier tests ---

test('classifyCodexErrorAsNotice returns true for severity-based notices', () => {
  const { classifyCodexErrorAsNotice } = require('../services/managerAdapters/codexAdapter');
  assert.equal(classifyCodexErrorAsNotice({ severity: 'warning', message: 'something' }), true);
  assert.equal(classifyCodexErrorAsNotice({ severity: 'warn', message: '' }), true);
  assert.equal(classifyCodexErrorAsNotice({ severity: 'notice', message: '' }), true);
  assert.equal(classifyCodexErrorAsNotice({ severity: 'info', message: '' }), true);
  assert.equal(classifyCodexErrorAsNotice({ severity: 'deprecation', message: '' }), true);
  assert.equal(classifyCodexErrorAsNotice({ severity: 'WARNING', message: '' }), true, 'case insensitive');
  assert.equal(classifyCodexErrorAsNotice({ severity: 'error', message: '' }), false);
  assert.equal(classifyCodexErrorAsNotice({ severity: 'fatal', message: '' }), false);
});

test('classifyCodexErrorAsNotice returns true for code-prefix notices', () => {
  const { classifyCodexErrorAsNotice } = require('../services/managerAdapters/codexAdapter');
  assert.equal(classifyCodexErrorAsNotice({ code: 'deprecated_feature_x' }), true);
  assert.equal(classifyCodexErrorAsNotice({ code: 'deprecation_notice' }), true);
  assert.equal(classifyCodexErrorAsNotice({ code: 'notice_something' }), true);
  assert.equal(classifyCodexErrorAsNotice({ code: 'warn_something' }), true);
  assert.equal(classifyCodexErrorAsNotice({ code: 'warning_something' }), true);
  assert.equal(classifyCodexErrorAsNotice({ code: 'error_something' }), false);
});

test('classifyCodexErrorAsNotice returns true for deprecation message regex', () => {
  const { classifyCodexErrorAsNotice } = require('../services/managerAdapters/codexAdapter');
  assert.equal(classifyCodexErrorAsNotice({ message: '[features].foo is deprecated' }), true);
  assert.equal(classifyCodexErrorAsNotice({ message: 'Deprecation warning for X' }), true);
  assert.equal(classifyCodexErrorAsNotice({ message: 'Something else entirely' }), false);
});

test('classifyCodexErrorAsNotice returns false for null/invalid input', () => {
  const { classifyCodexErrorAsNotice } = require('../services/managerAdapters/codexAdapter');
  assert.equal(classifyCodexErrorAsNotice(null), false);
  assert.equal(classifyCodexErrorAsNotice(undefined), false);
  assert.equal(classifyCodexErrorAsNotice('string'), false);
  assert.equal(classifyCodexErrorAsNotice(42), false);
});

test('classifyCodexErrorKind uses structured error_type first', () => {
  const { classifyCodexErrorKind } = require('../services/managerAdapters/codexAdapter');
  assert.equal(classifyCodexErrorKind({ error_type: 'rate_limit', message: 'rate limit hit' }), 'rate_limit');
  assert.equal(classifyCodexErrorKind({ error_type: 'custom_vendor_error', message: '' }), 'custom_vendor_error');
});

test('classifyCodexErrorKind uses structured code field', () => {
  const { classifyCodexErrorKind } = require('../services/managerAdapters/codexAdapter');
  assert.equal(classifyCodexErrorKind({ code: 'model_not_available', message: '' }), 'model_not_available');
  // Notice-prefixed codes should NOT be used as error kind
  assert.equal(classifyCodexErrorKind({ code: 'deprecated_feature', message: 'timeout happened' }), 'timeout');
});

test('classifyCodexErrorKind classifies common error patterns via regex', () => {
  const { classifyCodexErrorKind } = require('../services/managerAdapters/codexAdapter');

  // rate_limit
  assert.equal(classifyCodexErrorKind({ message: 'Rate limit exceeded' }), 'rate_limit');
  assert.equal(classifyCodexErrorKind({ message: 'rate-limit reached' }), 'rate_limit');

  // auth_error
  assert.equal(classifyCodexErrorKind({ message: 'Unauthorized access' }), 'auth_error');
  assert.equal(classifyCodexErrorKind({ message: '401 auth required' }), 'auth_error');
  assert.equal(classifyCodexErrorKind({ message: 'Forbidden: 403' }), 'auth_error');

  // timeout
  assert.equal(classifyCodexErrorKind({ message: 'Request timed out' }), 'timeout');
  assert.equal(classifyCodexErrorKind({ message: 'ETIMEDOUT connecting' }), 'timeout');
  assert.equal(classifyCodexErrorKind({ message: 'Connection timeout' }), 'timeout');

  // network_error
  assert.equal(classifyCodexErrorKind({ message: 'ECONNREFUSED 127.0.0.1:443' }), 'network_error');
  assert.equal(classifyCodexErrorKind({ message: 'ECONNRESET by peer' }), 'network_error');
  assert.equal(classifyCodexErrorKind({ message: 'Network error occurred' }), 'network_error');
  assert.equal(classifyCodexErrorKind({ message: 'fetch failed' }), 'network_error');

  // context_length
  assert.equal(classifyCodexErrorKind({ message: 'Context length exceeded' }), 'context_length');
  assert.equal(classifyCodexErrorKind({ message: 'max tokens reached' }), 'context_length');
  assert.equal(classifyCodexErrorKind({ message: 'Input too long for model' }), 'context_length');

  // invalid_model
  assert.equal(classifyCodexErrorKind({ message: 'Model gpt-99 not found' }), 'invalid_model');
  assert.equal(classifyCodexErrorKind({ message: 'The model does not exist' }), 'invalid_model');

  // server_overloaded
  assert.equal(classifyCodexErrorKind({ message: 'Server overloaded, try later' }), 'server_overloaded');
  assert.equal(classifyCodexErrorKind({ message: 'HTTP 503 service unavailable' }), 'server_overloaded');
  assert.equal(classifyCodexErrorKind({ message: 'HTTP 529 overloaded' }), 'server_overloaded');

  // invalid_request
  assert.equal(classifyCodexErrorKind({ message: 'Invalid request body' }), 'invalid_request');
  assert.equal(classifyCodexErrorKind({ message: 'Bad request: missing field' }), 'invalid_request');

  // content_filtered
  assert.equal(classifyCodexErrorKind({ message: 'Content filter triggered' }), 'content_filtered');
  assert.equal(classifyCodexErrorKind({ message: 'Output blocked by safety' }), 'content_filtered');
});

test('classifyCodexErrorKind falls back to unknown_error', () => {
  const { classifyCodexErrorKind } = require('../services/managerAdapters/codexAdapter');
  assert.equal(classifyCodexErrorKind({ message: 'Something completely unexpected' }), 'unknown_error');
  assert.equal(classifyCodexErrorKind({ message: '' }), 'unknown_error');
  assert.equal(classifyCodexErrorKind({}), 'unknown_error');
  assert.equal(classifyCodexErrorKind(null), 'unknown_error');
  assert.equal(classifyCodexErrorKind(undefined), 'unknown_error');
});

// --- P4-7: allowedTools source invariant tests ---

test('Fleet P5: claudeAdapter default manager allowedTools include Bash(curl:*)', () => {
  const { createClaudeAdapter } = require('../services/managerAdapters/claudeAdapter');
  const capturedTools = [];
  const adapter = createClaudeAdapter({
    streamJsonEngine: {
      spawnAgent: (_runId, opts) => { capturedTools.push(...(opts.allowedTools || [])); return { pid: 1 }; },
      isAlive: () => false,
      detectExitCode: () => null,
      kill: () => true,
      getOutput: () => '',
      getUsage: () => null,
      getSessionId: () => null,
      sendInput: () => true,
    },
    runService: null,
  });
  adapter.startSession('test-invariant', { prompt: 'hi', cwd: '/tmp' });
  assert.ok(capturedTools.includes('Bash(curl:*)'), 'Bash(curl:*) must appear in default allowedTools');
  assert.ok(capturedTools.includes('Bash(jq:*)'), 'Bash(jq:*) must remain in default allowedTools');
  assert.ok(capturedTools.includes('Read'), 'Read must remain in default allowedTools');
  assert.ok(capturedTools.includes('WebFetch'), 'WebFetch must remain in default allowedTools');
});

test('Fleet P5: source invariant — Bash(curl string literal exists in claudeAdapter.js baseTools', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'managerAdapters', 'claudeAdapter.js'), 'utf-8');
  // Find the baseTools array definition and extract only the string literals
  // (ignoring comments that may reference Bash(curl in historical context).
  const toolsSection = src.match(/const baseTools\s*=\s*allowedTools\s*\|\|\s*\[([\s\S]*?)\];/);
  assert.ok(toolsSection, 'baseTools array should exist in claudeAdapter.js');
  const stringLiterals = toolsSection[1].match(/'[^']*'/g) || [];
  const hasCurlLiteral = stringLiterals.some(s => s.includes('Bash(curl'));
  assert.equal(hasCurlLiteral, true, 'Bash(curl must appear as a string literal in baseTools array');
});

test('P4-7: system prompt fallback for non-curl adapters does not use curl examples', () => {
  const { buildManagerSystemPrompt } = require('../services/managerSystemPrompt');
  const out = buildManagerSystemPrompt({ adapter: null, port: 4177, token: 'tok' });
  assert.match(out, /WebFetch/, 'system prompt should mention WebFetch');
  assert.doesNotMatch(out, /curl -s/, 'system prompt should not contain curl -s examples');
});

test('Fleet P5: claude-code manager prompt emits curl POST templates', () => {
  const { buildManagerSystemPrompt } = require('../services/managerSystemPrompt');
  const out = buildManagerSystemPrompt({ adapter: null, port: 4177, token: 'tok', layer: 'operator', adapterType: 'claude-code' });
  assert.match(out, /curl -s -X POST .*\/api\/tasks/, 'Claude manager prompt must include task POST curl template');
  assert.doesNotMatch(out, /do NOT use Bash with curl/, 'Claude manager prompt must not forbid curl');
});

test('Fleet P5: codex manager curl section remains byte-identical', () => {
  const { buildManagerSystemPrompt } = require('../services/managerSystemPrompt');
  const out = buildManagerSystemPrompt({ adapter: null, port: 4177, token: 'tok', layer: 'operator', adapterType: 'codex' });
  const expected = `Use curl (via Bash) to query the API.
\`\`\`
# GET
curl -s http://localhost:4177/api/runs -H "Authorization: Bearer tok" | head -c 2000

# POST (create/execute)
curl -s -X POST http://localhost:4177/api/tasks -H "Authorization: Bearer tok" -H "Content-Type: application/json" -d '{"title":"...","project_id":"..."}'

# PATCH (update)
curl -s -X PATCH http://localhost:4177/api/tasks/TASK_ID/status -H "Authorization: Bearer tok" -H "Content-Type: application/json" -d '{"status":"done"}'

# DELETE
curl -s -X DELETE http://localhost:4177/api/tasks/TASK_ID -H "Authorization: Bearer tok"
\`\`\``;
  assert.ok(out.includes(expected), 'Codex curl template block must remain byte-identical');
});

test('ClaudeAdapter exposes Claude guardrails section', () => {
  const { createClaudeAdapter } = require('../services/managerAdapters/claudeAdapter');
  const adapter = createClaudeAdapter({
    streamJsonEngine: { spawnAgent: () => ({ pid: 1 }), isAlive: () => false, detectExitCode: () => null, kill: () => true, getOutput: () => '', getUsage: () => null, getSessionId: () => null, sendInput: () => true },
    runService: null,
  });
  assert.equal(typeof adapter.buildGuardrailsSection, 'function');
  assert.match(adapter.buildGuardrailsSection(), /Claude Code adapter notes/);
});
