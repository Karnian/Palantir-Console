const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');

const EVENT_TYPES_PATH = require.resolve('../services/managerAdapters/eventTypes');
const CODEX_ADAPTER_PATH = require.resolve('../services/managerAdapters/codexAdapter');
const CLAUDE_ADAPTER_PATH = require.resolve('../services/managerAdapters/claudeAdapter');

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 123;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  child.kill = () => true;
  return child;
}

function captureRunService() {
  const events = [];
  return {
    events,
    addRunEvent(runId, type, payload) {
      events.push({ runId, type, payload: payload ? JSON.parse(payload) : null });
    },
    updateManagerThreadId() {},
    updateRunResult() {},
    updateRunStatus() {},
  };
}

test('vendorHandleFingerprint is stable, distinguishing, and rejects empty values', () => {
  const { vendorHandleFingerprint } = require(EVENT_TYPES_PATH);
  assert.equal(vendorHandleFingerprint('same-handle'), vendorHandleFingerprint('same-handle'));
  assert.notEqual(vendorHandleFingerprint('same-handle'), vendorHandleFingerprint('other-handle'));
  assert.equal(vendorHandleFingerprint('same-handle'), 'a1e09f85b641');
  assert.equal(vendorHandleFingerprint(''), null);
  assert.equal(vendorHandleFingerprint(null), null);
  assert.equal(vendorHandleFingerprint(123), null);
});

test('Codex producer redacts events while onThreadStarted persists the original operator thread', async () => {
  const handle = 'codex-resume-authority-secret';
  const child = fakeChild();
  const runService = captureRunService();
  const operatorInstance = { thread_id: null };
  const { createCodexAdapter } = require(CODEX_ADAPTER_PATH);
  const adapter = createCodexAdapter({ runService, spawnFn: () => child });

  adapter.startSession('codex-redaction', {
    systemPrompt: 'test',
    cwd: process.cwd(),
    onThreadStarted(threadId) { operatorInstance.thread_id = threadId; },
  });
  await adapter.runTurn('codex-redaction', { text: 'hello' });
  child.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: handle })}\n`);
  await new Promise((resolve) => setImmediate(resolve));

  const event = runService.events.find(({ type }) => type === 'mgr.session_started');
  assert.ok(event);
  assert.equal(JSON.stringify(event.payload).includes(handle), false);
  assert.equal(event.payload.summaryText.includes(handle), false);
  assert.equal(event.payload.data.threadId, undefined);
  assert.equal(event.payload.data.threadFingerprint, 'a94bb195b4b5');
  assert.equal(operatorInstance.thread_id, handle);
  await adapter.disposeSession('codex-redaction');
});

test('Claude adapter producer redacts events while onSessionStarted persists the original operator thread', () => {
  const handle = 'claude-operator-resume-secret';
  const runService = captureRunService();
  const operatorInstance = { thread_id: null };
  let vendorHook;
  const engine = {
    spawnAgent(_runId, options) { vendorHook = options.onVendorEvent; return { pid: 1 }; },
    sendInput: () => true,
    isAlive: () => true,
    detectExitCode: () => null,
    getUsage: () => null,
    getSessionId: () => null,
    getOutput: () => '',
    kill: () => true,
  };
  const { createClaudeAdapter } = require(CLAUDE_ADAPTER_PATH);
  const adapter = createClaudeAdapter({ streamJsonEngine: engine, runService });
  adapter.startSession('claude-redaction', {
    prompt: 'test',
    cwd: process.cwd(),
    onSessionStarted(sessionId) { operatorInstance.thread_id = sessionId; },
  });
  vendorHook({ type: 'system', subtype: 'init', session_id: handle, model: 'sonnet' }, { usage: {} });

  const event = runService.events.find(({ type }) => type === 'mgr.session_started');
  assert.ok(event);
  assert.equal(JSON.stringify(event.payload).includes(handle), false);
  assert.equal(event.payload.summaryText.includes(handle), false);
  assert.equal(event.payload.data.sessionId, undefined);
  assert.equal(event.payload.data.sessionFingerprint, 'b8de1411c924');
  assert.equal(operatorInstance.thread_id, handle);
});

test('stream-json init producer redacts stored and bus payloads while runs.claude_session_id keeps the original', async () => {
  const handle = 'claude-run-resume-secret';
  const child = fakeChild();
  const stored = [];
  const emitted = [];
  const runs = { 'stream-redaction': { claude_session_id: null } };
  const runService = {
    addRunEvent(runId, type, payload) { stored.push({ runId, type, payload: JSON.parse(payload) }); },
    updateClaudeSessionId(runId, sessionId) { runs[runId].claude_session_id = sessionId; },
  };
  const eventBus = { emit(type, payload) { emitted.push({ type, payload }); } };
  const executor = { spawnInteractive: () => child };
  const { createStreamJsonEngine } = require('../services/streamJsonEngine');
  const engine = createStreamJsonEngine({ runService, eventBus });
  engine.spawnAgent('stream-redaction', { cwd: process.cwd(), executor, isManager: true });
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({
    type: 'system', subtype: 'init', session_id: handle,
    model: 'sonnet', tools: ['Read'], cwd: process.cwd(),
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));

  const init = stored.find(({ type }) => type === 'init');
  const busInit = emitted.find(({ type }) => type === 'run:init');
  assert.ok(init);
  assert.ok(busInit);
  assert.equal(JSON.stringify(init.payload).includes(handle), false);
  assert.equal(JSON.stringify(busInit.payload).includes(handle), false);
  assert.equal(init.payload.session_id, undefined);
  assert.equal(init.payload.session_fingerprint, '535b658262a3');
  assert.equal(busInit.payload.sessionId, undefined);
  assert.equal(typeof busInit.payload.sessionFingerprint, 'string');
  assert.equal(runs['stream-redaction'].claude_session_id, handle);
  engine.kill('stream-redaction');
});

test('raw debug event persistence cuts cycles but revisits shared DAG references', (t) => {
  const previous = process.env.PALANTIR_DEBUG_RAW_EVENTS;
  process.env.PALANTIR_DEBUG_RAW_EVENTS = '1';
  delete require.cache[CLAUDE_ADAPTER_PATH];
  delete require.cache[EVENT_TYPES_PATH];
  t.after(() => {
    if (previous === undefined) delete process.env.PALANTIR_DEBUG_RAW_EVENTS;
    else process.env.PALANTIR_DEBUG_RAW_EVENTS = previous;
    delete require.cache[CLAUDE_ADAPTER_PATH];
    delete require.cache[EVENT_TYPES_PATH];
  });

  const events = [];
  const runService = {
    addRunEvent(runId, type, payload) {
      events.push({ runId, type, payload: JSON.parse(payload) });
    },
    updateManagerThreadId() {}, updateRunResult() {}, updateRunStatus() {},
  };
  let vendorHook;
  const engine = {
    spawnAgent(_runId, options) { vendorHook = options.onVendorEvent; return { pid: 1 }; },
    sendInput: () => true, isAlive: () => true, detectExitCode: () => null,
    getUsage: () => null, getSessionId: () => null, getOutput: () => '', kill: () => true,
  };
  const { createClaudeAdapter } = require(CLAUDE_ADAPTER_PATH);
  const adapter = createClaudeAdapter({ streamJsonEngine: engine, runService });
  adapter.startSession('raw-cycle', { prompt: 'test', cwd: process.cwd() });
  const shared = { value: 'visited' };
  const vendorEvent = { type: 'assistant', left: shared, right: shared };
  vendorEvent.self = vendorEvent;
  assert.doesNotThrow(() => vendorHook(vendorEvent, { usage: {} }));

  const raw = events.find(({ type }) => type === 'mgr.raw_vendor_event');
  assert.ok(raw);
  assert.equal(raw.payload.data.event.self, '[Circular]');
  assert.deepEqual(raw.payload.data.event.left, { value: 'visited' });
  assert.deepEqual(raw.payload.data.event.right, { value: 'visited' });
});

test('raw debug events recursively redact known nested vendor handle keys', (t) => {
  const previous = process.env.PALANTIR_DEBUG_RAW_EVENTS;
  process.env.PALANTIR_DEBUG_RAW_EVENTS = '1';
  delete require.cache[CLAUDE_ADAPTER_PATH];
  delete require.cache[EVENT_TYPES_PATH];
  t.after(() => {
    if (previous === undefined) delete process.env.PALANTIR_DEBUG_RAW_EVENTS;
    else process.env.PALANTIR_DEBUG_RAW_EVENTS = previous;
    delete require.cache[CLAUDE_ADAPTER_PATH];
    delete require.cache[EVENT_TYPES_PATH];
  });

  const handle = 'nested-raw-resume-secret';
  const runService = captureRunService();
  let vendorHook;
  const engine = {
    spawnAgent(_runId, options) { vendorHook = options.onVendorEvent; return { pid: 1 }; },
    sendInput: () => true, isAlive: () => true, detectExitCode: () => null,
    getUsage: () => null, getSessionId: () => null, getOutput: () => '', kill: () => true,
  };
  const { createClaudeAdapter } = require(CLAUDE_ADAPTER_PATH);
  const { vendorHandleFingerprint } = require(EVENT_TYPES_PATH);
  const adapter = createClaudeAdapter({ streamJsonEngine: engine, runService });
  adapter.startSession('raw-redaction', { prompt: 'test', cwd: process.cwd() });
  vendorHook({
    type: 'assistant',
    nested: { session_id: handle, array: [{ threadId: handle }] },
  }, { usage: {} });

  const raw = runService.events.find(({ type }) => type === 'mgr.raw_vendor_event');
  assert.ok(raw);
  assert.equal(JSON.stringify(raw.payload).includes(handle), false);
  assert.equal(raw.payload.data.event.nested.session_id, vendorHandleFingerprint(handle));
  assert.equal(raw.payload.data.event.nested.array[0].threadId, vendorHandleFingerprint(handle));
});
