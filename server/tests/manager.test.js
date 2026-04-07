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

test('runService.getRunEvents honors ?after= cursor (PR1c)', async (t) => {
  // Direct service-level test for the cursor that the frontend now uses
  // for incremental polling. Route-level coverage of /api/manager/events
  // requires an active manager run id (the route only serves the in-memory
  // active session) which we cannot fake without spawning a real subprocess.
  const fs2 = require('node:fs/promises');
  const path2 = require('node:path');
  const os2 = require('node:os');
  const dbPath = path2.join(await fs2.mkdtemp(path2.join(os2.tmpdir(), 'palantir-mgr-cursor-')), 'test.db');
  const { createDatabase } = require('../db/database');
  const { createRunService } = require('../services/runService');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(() => { close(); });
  const rs = createRunService(db, null);
  const run = rs.createRun({ is_manager: true, prompt: 'cursor test' });
  const id1 = rs.addRunEvent(run.id, 'mgr.assistant_message', JSON.stringify({ turnIndex: 0, summaryText: 'a', hasRawStored: false, data: { text: 'a' } }));
  const id2 = rs.addRunEvent(run.id, 'mgr.assistant_message', JSON.stringify({ turnIndex: 0, summaryText: 'b', hasRawStored: false, data: { text: 'b' } }));
  const id3 = rs.addRunEvent(run.id, 'mgr.assistant_message', JSON.stringify({ turnIndex: 1, summaryText: 'c', hasRawStored: false, data: { text: 'c' } }));

  const all = rs.getRunEvents(run.id);
  // The createRun + addRunEvent calls also write a 'status:queued' status row,
  // so we filter to the rows we explicitly created.
  const mgrRows = all.filter(e => e.event_type === 'mgr.assistant_message');
  assert.equal(mgrRows.length, 3);
  const after1 = rs.getRunEvents(run.id, id1).filter(e => e.event_type === 'mgr.assistant_message');
  assert.equal(after1.length, 2);
  assert.equal(after1[0].id, id2);
  assert.equal(after1[1].id, id3);
  const afterLast = rs.getRunEvents(run.id, id3).filter(e => e.event_type === 'mgr.assistant_message');
  assert.equal(afterLast.length, 0);
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

// --- PR2: authResolver ---

test('resolveClaudeAuth returns canAuth=true when CLAUDE_CODE_OAUTH_TOKEN is set', async (t) => {
  const { resolveClaudeAuth } = require('../services/authResolver');
  const orig = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const origKey = process.env.ANTHROPIC_API_KEY;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-oauth-fake';
  delete process.env.ANTHROPIC_API_KEY;
  t.after(() => {
    if (orig != null) process.env.CLAUDE_CODE_OAUTH_TOKEN = orig;
    else delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (origKey != null) process.env.ANTHROPIC_API_KEY = origKey;
  });
  const r = resolveClaudeAuth();
  assert.equal(r.canAuth, true);
  assert.ok(r.sources.includes('env:CLAUDE_CODE_OAUTH_TOKEN'));
  assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-oauth-fake');
  assert.deepEqual(r.diagnostics, []);
});

test('resolveClaudeAuth returns canAuth=false with diagnostics when no creds', async (t) => {
  const { resolveClaudeAuth } = require('../services/authResolver');
  const saved = {};
  for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  t.after(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] != null) process.env[k] = saved[k];
    }
  });
  // Force the auth file path to a nonexistent location for this test by
  // jest-style intercept isn't available; rely on the path not existing in
  // the test temp environment. Even if the file exists in the dev workspace,
  // canAuth checks env first — without env vars and an envAllowlist that
  // limits to a non-existent var we still get canAuth=false.
  const r = resolveClaudeAuth({ envAllowlist: ['NOPE'] });
  assert.equal(r.canAuth, false);
  assert.ok(r.diagnostics.length > 0);
});

test('resolveCodexAuth honors env_allowlist diagnostics', async (t) => {
  // Deterministic: stub fs.existsSync so the test outcome doesn't depend on
  // whether the dev box happens to have ~/.codex/auth.json.
  const fsMod = require('node:fs');
  const origExists = fsMod.existsSync;
  const { CODEX_AUTH_FILE } = require('../services/authResolver');
  fsMod.existsSync = (p) => (p === CODEX_AUTH_FILE ? false : origExists.call(fsMod, p));

  const saved = process.env.CODEX_API_KEY;
  const savedOpenAI = process.env.OPENAI_API_KEY;
  process.env.CODEX_API_KEY = 'codex-fake';
  delete process.env.OPENAI_API_KEY;
  t.after(() => {
    fsMod.existsSync = origExists;
    if (saved != null) process.env.CODEX_API_KEY = saved;
    else delete process.env.CODEX_API_KEY;
    if (savedOpenAI != null) process.env.OPENAI_API_KEY = savedOpenAI;
  });

  // Re-require so the resolver picks up the stubbed existsSync. require cache
  // means the function reference is the same; the module-level fs require is
  // shared, so the stub above is enough — no re-require needed.
  const { resolveCodexAuth } = require('../services/authResolver');

  // Allowlist excludes CODEX_API_KEY so resolveCodexAuth must report it as blocked.
  const r = resolveCodexAuth({ envAllowlist: ['SOMETHING_ELSE'] });
  assert.equal(r.canAuth, false, 'canAuth must be false: env var blocked, file stubbed missing');
  assert.ok(r.diagnostics.some(d => /env_allowlist/.test(d)),
    'diagnostics should mention the env_allowlist exclusion');
});

test('resolveCodexAuth canAuth=true when CODEX_API_KEY set and allowed', async (t) => {
  const fsMod = require('node:fs');
  const origExists = fsMod.existsSync;
  const { CODEX_AUTH_FILE } = require('../services/authResolver');
  fsMod.existsSync = (p) => (p === CODEX_AUTH_FILE ? false : origExists.call(fsMod, p));

  const saved = process.env.CODEX_API_KEY;
  process.env.CODEX_API_KEY = 'codex-fake-2';
  t.after(() => {
    fsMod.existsSync = origExists;
    if (saved != null) process.env.CODEX_API_KEY = saved;
    else delete process.env.CODEX_API_KEY;
  });

  const { resolveCodexAuth } = require('../services/authResolver');
  const r = resolveCodexAuth();
  assert.equal(r.canAuth, true);
  assert.ok(r.sources.includes('env:CODEX_API_KEY'));
  assert.equal(r.env.CODEX_API_KEY, 'codex-fake-2');
});

test('resolveManagerAuth dispatches by type', async (t) => {
  const { resolveManagerAuth } = require('../services/authResolver');
  const claude = resolveManagerAuth('claude-code', { envAllowlist: ['NOPE'] });
  assert.equal(typeof claude.canAuth, 'boolean');
  const codex = resolveManagerAuth('codex', { envAllowlist: ['NOPE'] });
  assert.equal(typeof codex.canAuth, 'boolean');
  // Default falls through to claude.
  const def = resolveManagerAuth(undefined, { envAllowlist: ['NOPE'] });
  assert.equal(def.canAuth, claude.canAuth);
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
