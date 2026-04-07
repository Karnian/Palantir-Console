const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');
const { createApp } = require('../app');

async function createTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createTestApp(t) {
  const storageRoot = await createTempDir('palantir-mgr-storage-');
  const fsRoot = await createTempDir('palantir-mgr-fs-');
  const app = createApp({ storageRoot, fsRoot, opencodeBin: 'opencode' });

  t.after(async () => {
    if (app.shutdown) app.shutdown();
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
  });

  return { app, storageRoot, fsRoot };
}

// --- Manager API Tests ---

test('GET /api/manager/status returns inactive when no session', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app).get('/api/manager/status');
  assert.equal(res.status, 200);
  assert.equal(res.body.active, false);
  assert.equal(res.body.run, null);
});

test('POST /api/manager/message returns 404 when no active session', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app)
    .post('/api/manager/message')
    .send({ text: 'hello' });
  assert.equal(res.status, 404);
});

test('POST /api/manager/stop returns no_active_session when no session', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app).post('/api/manager/stop');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'no_active_session');
});

test('GET /api/manager/events returns empty when no session', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app).get('/api/manager/events');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.events, []);
});

test('GET /api/manager/output returns null when no session', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app).get('/api/manager/output');
  assert.equal(res.status, 200);
  assert.equal(res.body.output, null);
});

// --- StreamJsonEngine Unit Tests ---

test('StreamJsonEngine module exports createStreamJsonEngine', async (t) => {
  const { createStreamJsonEngine } = require('../services/streamJsonEngine');
  assert.equal(typeof createStreamJsonEngine, 'function');

  const engine = createStreamJsonEngine({});
  assert.equal(engine.type, 'stream-json');
  assert.equal(typeof engine.spawnAgent, 'function');
  assert.equal(typeof engine.sendInput, 'function');
  assert.equal(typeof engine.getOutput, 'function');
  assert.equal(typeof engine.getEvents, 'function');
  assert.equal(typeof engine.getUsage, 'function');
  assert.equal(typeof engine.kill, 'function');
  assert.equal(typeof engine.isAlive, 'function');
  assert.equal(typeof engine.detectExitCode, 'function');
});

test('StreamJsonEngine.isAlive returns false for unknown runId', async (t) => {
  const { createStreamJsonEngine } = require('../services/streamJsonEngine');
  const engine = createStreamJsonEngine({});
  assert.equal(engine.isAlive('nonexistent'), false);
  assert.equal(engine.detectExitCode('nonexistent'), null);
  assert.equal(engine.getOutput('nonexistent'), null);
  assert.deepEqual(engine.getEvents('nonexistent'), []);
  assert.equal(engine.getUsage('nonexistent'), null);
  assert.equal(engine.getSessionId('nonexistent'), null);
  assert.equal(engine.kill('nonexistent'), false);
  assert.equal(engine.sendInput('nonexistent', 'test'), false);
});

test('StreamJsonEngine.listSessions returns empty array initially', async (t) => {
  const { createStreamJsonEngine } = require('../services/streamJsonEngine');
  const engine = createStreamJsonEngine({});
  assert.deepEqual(engine.listSessions(), []);
  assert.deepEqual(engine.discoverGhostSessions(), []);
});

// --- DB Migration Tests ---

test('002 migration adds manager columns to runs', async (t) => {
  const { createDatabase } = require('../db/database');
  const dbPath = path.join(os.tmpdir(), `palantir-mgr-test-${Date.now()}.db`);
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();

  t.after(async () => {
    close();
    await fs.unlink(dbPath).catch(() => {});
  });

  // Check that is_manager column exists
  const info = db.pragma('table_info(runs)');
  const columnNames = info.map(c => c.name);
  assert.ok(columnNames.includes('is_manager'), 'is_manager column should exist');
  assert.ok(columnNames.includes('parent_run_id'), 'parent_run_id column should exist');
  assert.ok(columnNames.includes('claude_session_id'), 'claude_session_id column should exist');

  // Insert a manager run
  db.prepare(`
    INSERT INTO runs (id, task_id, agent_profile_id, prompt, status, is_manager)
    VALUES ('run_mgr_test', NULL, NULL, 'test prompt', 'queued', 1)
  `).run();

  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get('run_mgr_test');
  assert.equal(run.is_manager, 1);
  assert.equal(run.task_id, null);
});

// --- RunService Manager Methods ---

test('runService.getActiveManager returns null when no manager', async (t) => {
  const { createDatabase } = require('../db/database');
  const { createRunService } = require('../services/runService');
  const dbPath = path.join(os.tmpdir(), `palantir-runsvc-test-${Date.now()}.db`);
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();

  t.after(async () => {
    close();
    await fs.unlink(dbPath).catch(() => {});
  });

  const runService = createRunService(db, null);
  const mgr = runService.getActiveManager();
  assert.equal(mgr, null);
});

// --- PR1b: ClaudeAdapter normalized event emission ---

test('claudeAdapter dual-emits normalized events alongside legacy ones', async (t) => {
  const { createClaudeAdapter } = require('../services/managerAdapters/claudeAdapter');
  const { NORMALIZED_EVENT_TYPES } = require('../services/managerAdapters/eventTypes');

  // Capture all addRunEvent calls.
  const captured = [];
  const fakeRunService = {
    addRunEvent(runId, eventType, payload) {
      captured.push({ runId, eventType, payload: payload ? JSON.parse(payload) : null });
      return captured.length;
    },
  };

  // Fake streamJsonEngine — only spawnAgent is invoked, and we just need to
  // capture the onVendorEvent hook so we can drive it manually.
  let capturedHook = null;
  const fakeEngine = {
    spawnAgent(runId, opts) {
      capturedHook = opts.onVendorEvent;
      return { pid: 1234 };
    },
    sendInput: () => true,
    isAlive: () => true,
    detectExitCode: () => null,
    getUsage: () => ({ inputTokens: 0, outputTokens: 0, costUsd: 0 }),
    getSessionId: () => 'sess_x',
    getOutput: () => '',
    kill: () => true,
  };

  const adapter = createClaudeAdapter({ streamJsonEngine: fakeEngine, runService: fakeRunService });
  adapter.startSession('run_mgr_test', { prompt: 'hi', cwd: process.cwd() });
  assert.ok(typeof capturedHook === 'function', 'onVendorEvent hook should be installed');

  const fakeProc = { usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 } };

  // Drive a synthetic Claude turn.
  capturedHook({ type: 'system', subtype: 'init', session_id: 'sess_x', model: 'sonnet', cwd: '/tmp' }, fakeProc);
  capturedHook({
    type: 'assistant',
    message: { content: [
      { type: 'text', text: 'hello world' },
      { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { cmd: 'ls' } },
    ] },
  }, fakeProc);
  capturedHook({
    type: 'user',
    message: { content: [
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'file1\nfile2', is_error: false },
    ] },
  }, fakeProc);
  capturedHook({
    type: 'result',
    is_error: false,
    stop_reason: 'end_turn',
    duration_ms: 1234,
    num_turns: 1,
  }, fakeProc);

  const types = captured.map(c => c.eventType);
  assert.ok(types.includes(NORMALIZED_EVENT_TYPES.SESSION_STARTED), 'session_started');
  assert.ok(types.includes(NORMALIZED_EVENT_TYPES.ASSISTANT_MESSAGE), 'assistant_message');
  assert.ok(types.includes(NORMALIZED_EVENT_TYPES.TOOL_CALL_STARTED), 'tool_call_started');
  assert.ok(types.includes(NORMALIZED_EVENT_TYPES.TOOL_CALL_FINISHED), 'tool_call_finished');
  assert.ok(types.includes(NORMALIZED_EVENT_TYPES.USAGE), 'usage');
  assert.ok(types.includes(NORMALIZED_EVENT_TYPES.TURN_COMPLETED), 'turn_completed');

  // Payload shape: every normalized payload has turnIndex, summaryText, hasRawStored, data
  for (const ev of captured) {
    if (!ev.eventType.startsWith('mgr.')) continue;
    assert.equal(typeof ev.payload.turnIndex, 'number');
    assert.equal(typeof ev.payload.summaryText, 'string');
    assert.equal(typeof ev.payload.hasRawStored, 'boolean');
    assert.equal(typeof ev.payload.data, 'object');
  }

  // turnIndex on assistant message should be 0; turn_completed advances state for next turn
  const am = captured.find(c => c.eventType === NORMALIZED_EVENT_TYPES.ASSISTANT_MESSAGE);
  assert.equal(am.payload.turnIndex, 0);

  // Drive a second turn — should now be turnIndex 1.
  capturedHook({ type: 'assistant', message: { content: [{ type: 'text', text: 'turn 2' }] } }, fakeProc);
  const am2 = captured.filter(c => c.eventType === NORMALIZED_EVENT_TYPES.ASSISTANT_MESSAGE).pop();
  assert.equal(am2.payload.turnIndex, 1);

  // disposeSession emits session_ended.
  adapter.disposeSession('run_mgr_test');
  const ended = captured.find(c => c.eventType === NORMALIZED_EVENT_TYPES.SESSION_ENDED);
  assert.ok(ended, 'session_ended emitted on dispose');
});

test('claudeAdapter does not emit raw_vendor_event by default', async (t) => {
  const { createClaudeAdapter } = require('../services/managerAdapters/claudeAdapter');
  const { NORMALIZED_EVENT_TYPES } = require('../services/managerAdapters/eventTypes');

  const captured = [];
  const fakeRunService = { addRunEvent(_r, t) { captured.push(t); return 1; } };
  let hook = null;
  const fakeEngine = {
    spawnAgent(_id, opts) { hook = opts.onVendorEvent; return { pid: 1 }; },
    sendInput: () => true, isAlive: () => true, detectExitCode: () => null,
    getUsage: () => null, getSessionId: () => null, getOutput: () => '', kill: () => true,
  };
  const adapter = createClaudeAdapter({ streamJsonEngine: fakeEngine, runService: fakeRunService });
  adapter.startSession('r1', { prompt: 'x', cwd: process.cwd() });
  hook({ type: 'system', subtype: 'init', session_id: 's' }, { usage: {} });
  assert.ok(!captured.includes(NORMALIZED_EVENT_TYPES.RAW_VENDOR_EVENT));
});

test('runService.createRun with is_manager allows null task_id', async (t) => {
  const { createDatabase } = require('../db/database');
  const { createRunService } = require('../services/runService');
  const dbPath = path.join(os.tmpdir(), `palantir-runsvc-mgr-${Date.now()}.db`);
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();

  t.after(async () => {
    close();
    await fs.unlink(dbPath).catch(() => {});
  });

  const runService = createRunService(db, null);
  const run = runService.createRun({
    is_manager: true,
    prompt: 'Manager test',
  });

  assert.ok(run.id.startsWith('run_mgr_'));
  assert.equal(run.status, 'queued');
  assert.equal(run.task_id, null);
});
