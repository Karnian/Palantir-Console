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
  // PR18: inject hasKeychain=false so this test is deterministic on dev
  // machines that have a real Claude Code keychain item. The original
  // 'envAllowlist: ["NOPE"]' trick was sufficient pre-PR18 because the
  // resolver only checked env vars, but now keychain is a separate path
  // that allowlist filtering does NOT cover (Claude CLI reads keychain
  // itself, the resolver doesn't materialize the token into env).
  const r = resolveClaudeAuth({ envAllowlist: ['NOPE'], hasKeychain: () => false });
  assert.equal(r.canAuth, false);
  assert.ok(r.diagnostics.length > 0);
});

// PR18: regression for the on-demand .claude-auth.json re-read. Pre-PR18 the
// file existed only as an informational `sources` entry; canAuth was decided
// purely from process.env, so dropping a fresh file in did NOT flip canAuth
// without a server restart. Now the resolver re-reads the file every call and
// merges allowed keys into the local env, which both flips canAuth and makes
// the token available for forwarding to the spawned subprocess.
test('resolveClaudeAuth re-reads .claude-auth.json on demand', async (t) => {
  const { resolveClaudeAuth, CLAUDE_AUTH_FILE } = require('../services/authResolver');
  const fsMod = require('node:fs');
  const saved = {};
  for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // Stash any pre-existing file so the test is hermetic and we don't clobber
  // a real cred file on the dev box.
  let savedFile = null;
  try {
    if (fsMod.existsSync(CLAUDE_AUTH_FILE)) {
      savedFile = fsMod.readFileSync(CLAUDE_AUTH_FILE, 'utf-8');
      fsMod.unlinkSync(CLAUDE_AUTH_FILE);
    }
  } catch { /* ignore */ }
  t.after(() => {
    try { fsMod.unlinkSync(CLAUDE_AUTH_FILE); } catch { /* ignore */ }
    if (savedFile != null) {
      try { fsMod.writeFileSync(CLAUDE_AUTH_FILE, savedFile, { mode: 0o600 }); } catch { /* ignore */ }
    }
    for (const k of Object.keys(saved)) {
      if (saved[k] != null) process.env[k] = saved[k];
    }
  });

  // Step 1 — no env, no keychain, no file → canAuth false
  let r = resolveClaudeAuth({ hasKeychain: () => false });
  assert.equal(r.canAuth, false);

  // Step 2 — drop a file in WITHOUT restarting the resolver
  fsMod.writeFileSync(
    CLAUDE_AUTH_FILE,
    JSON.stringify({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-test-from-file' }),
    { mode: 0o600 }
  );

  // Step 3 — resolver picks it up on the next call
  r = resolveClaudeAuth({ hasKeychain: () => false });
  assert.equal(r.canAuth, true);
  assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-test-from-file');
  assert.ok(r.sources.includes('file:.claude-auth.json'));
});

// PR18: companion positive case at the resolver unit level. Establishes
// the contract that "keychain present, env empty, file absent" → canAuth=true
// AND env stays empty (no token leakage into the spawned subprocess env).
test('resolveClaudeAuth flips canAuth true on keychain only and does not leak token to env', async (t) => {
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
  const r = resolveClaudeAuth({ hasKeychain: () => true });
  assert.equal(r.canAuth, true);
  assert.ok(
    r.sources.includes('keychain:Claude Code-credentials'),
    `expected keychain source, got: ${JSON.stringify(r.sources)}`
  );
  // Critical: keychain entries must NOT be materialized into env. Claude CLI
  // reads keychain at spawn time; forwarding the secret would just leak it.
  assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(r.env.ANTHROPIC_API_KEY, undefined);
  assert.deepEqual(r.diagnostics, []);
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

test('buildManagerSpawnEnv strips cross-vendor credentials not on allowlist', async (t) => {
  const { buildManagerSpawnEnv } = require('../services/authResolver');
  const base = {
    PATH: '/usr/bin',
    HOME: '/home/test',
    CLAUDE_CODE_OAUTH_TOKEN: 'claude-token',
    ANTHROPIC_API_KEY: 'anth-key',
    CODEX_API_KEY: 'codex-key',
    OPENAI_API_KEY: 'openai-key',
    UNRELATED: 'keep-me',
  };
  // Claude profile allowlist excludes Codex + OpenAI keys.
  const env = buildManagerSpawnEnv({
    baseEnv: base,
    envAllowlist: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'],
    authEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'claude-token' },
  });
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'claude-token');
  assert.equal(env.ANTHROPIC_API_KEY, 'anth-key');
  assert.equal(env.CODEX_API_KEY, undefined, 'CODEX_API_KEY must be stripped');
  assert.equal(env.OPENAI_API_KEY, undefined, 'OPENAI_API_KEY must be stripped');
  assert.equal(env.PATH, '/usr/bin', 'PATH must be preserved');
  assert.equal(env.UNRELATED, 'keep-me', 'unrelated vars must be preserved');
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

// --- PR3: migration 005 + manager_adapter columns ---

test('migration 005 adds manager_adapter and manager_thread_id columns', async (t) => {
  const { createDatabase } = require('../db/database');
  const dbPath = path.join(os.tmpdir(), `palantir-mgr-005-${Date.now()}.db`);
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    close();
    await fs.unlink(dbPath).catch(() => {});
  });

  const cols = db.pragma('table_info(runs)').map(c => c.name);
  assert.ok(cols.includes('manager_adapter'), 'manager_adapter column should exist');
  assert.ok(cols.includes('manager_thread_id'), 'manager_thread_id column should exist');

  // Index exists
  const idx = db.pragma('index_list(runs)').map(i => i.name);
  assert.ok(idx.includes('idx_runs_manager_adapter'), 'idx_runs_manager_adapter should exist');

  // Seed update applied
  const claude = db.prepare('SELECT env_allowlist FROM agent_profiles WHERE id = ?').get('claude-code');
  assert.ok(JSON.parse(claude.env_allowlist).includes('CLAUDE_CODE_OAUTH_TOKEN'));
  const codex = db.prepare('SELECT env_allowlist FROM agent_profiles WHERE id = ?').get('codex');
  assert.ok(JSON.parse(codex.env_allowlist).includes('CODEX_API_KEY'));
});

test('runService.createRun accepts manager_adapter + manager_thread_id', async (t) => {
  const { createDatabase } = require('../db/database');
  const { createRunService } = require('../services/runService');
  const dbPath = path.join(os.tmpdir(), `palantir-mgr-cols-${Date.now()}.db`);
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    close();
    await fs.unlink(dbPath).catch(() => {});
  });

  const rs = createRunService(db, null);
  const run = rs.createRun({
    is_manager: true,
    prompt: 'codex test',
    agent_profile_id: 'codex',
    manager_adapter: 'codex',
    manager_thread_id: 'thr_xyz',
  });
  assert.equal(run.manager_adapter, 'codex');
  assert.equal(run.manager_thread_id, 'thr_xyz');

  // updateManagerThreadId
  const updated = rs.updateManagerThreadId(run.id, 'thr_new');
  assert.equal(updated.manager_thread_id, 'thr_new');
});

test('managerAdapterFactory.getAdapter dispatches by type (PR3+PR4)', async (t) => {
  const { createManagerAdapterFactory } = require('../services/managerAdapters');
  const { createStreamJsonEngine } = require('../services/streamJsonEngine');
  const f = createManagerAdapterFactory({ streamJsonEngine: createStreamJsonEngine({}), runService: null });
  // null/undefined → claude (backward compat for boot cleanup of pre-005 rows)
  assert.equal(f.getAdapter(null).type, 'claude-code');
  assert.equal(f.getAdapter(undefined).type, 'claude-code');
  assert.equal(f.getAdapter('claude-code').type, 'claude-code');
  // PR4: codex now resolves to a real adapter
  assert.equal(f.getAdapter('codex').type, 'codex');
  // Unknown types still throw
  assert.throws(() => f.getAdapter('whatever'), /Unknown manager adapter type/);
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

// ─────────────────────────────────────────────────────────────────────────
// v3 Phase 0: Capability Diet regression tests
// ─────────────────────────────────────────────────────────────────────────

test('v3 Phase 0: managerSystemPrompt top layer excludes worker intervention APIs', async () => {
  const { buildManagerSystemPrompt } = require('../services/managerSystemPrompt');
  const prompt = buildManagerSystemPrompt({
    adapter: null, port: 4177, token: null, layer: 'top',
  });
  // Worker intervention APIs MUST NOT appear in top layer prompt
  assert.ok(!prompt.includes('/api/runs/RUN_ID/input'),
    'top layer must not document /api/runs/:id/input');
  assert.ok(!prompt.includes('/api/runs/RUN_ID/cancel'),
    'top layer must not document /api/runs/:id/cancel');
  assert.ok(!prompt.includes('PATCH ${base}/api/tasks/TASK_ID/status') &&
            !prompt.includes('PATCH http://localhost:4177/api/tasks/TASK_ID/status'),
    'top layer must not document PATCH /api/tasks/:id/status');
  // Dispatch API MUST appear
  assert.ok(prompt.includes('/api/tasks/TASK_ID/execute'),
    'top layer must document /execute');
  // Capability diet explanation MUST appear
  assert.ok(prompt.includes('You do NOT have Write or Edit tools'),
    'top layer must explain Write/Edit absence');
});

test('v3 Phase 0: managerSystemPrompt pm layer includes worker intervention APIs', async () => {
  const { buildManagerSystemPrompt } = require('../services/managerSystemPrompt');
  const prompt = buildManagerSystemPrompt({
    adapter: null, port: 4177, token: null, layer: 'pm',
  });
  assert.ok(prompt.includes('/api/runs/RUN_ID/input'),
    'pm layer must document /api/runs/:id/input');
  assert.ok(prompt.includes('/api/runs/RUN_ID/cancel'),
    'pm layer must document /api/runs/:id/cancel');
  assert.ok(prompt.includes('/api/tasks/TASK_ID/status'),
    'pm layer must document PATCH /api/tasks/:id/status');
  assert.ok(prompt.includes('project-scoped PM'),
    'pm layer must identify itself as project-scoped PM');
});

test('v3 Phase 0: routes/manager.js passes role=manager to adapter.startSession', async () => {
  // Verify the route passes role='manager' explicitly (belt-and-suspenders,
  // since codexAdapter defaults to 'manager' anyway).
  const src = await fs.readFile(
    path.join(__dirname, '..', 'routes', 'manager.js'),
    'utf8'
  );
  // Match startSession call and verify role: 'manager' is inside the options object
  const startSessionCall = src.match(/adapter\.startSession\(runId,\s*\{[\s\S]*?\}\)/);
  assert.ok(startSessionCall, 'adapter.startSession call must exist');
  assert.ok(startSessionCall[0].includes("role: 'manager'"),
    "adapter.startSession options must include role: 'manager'");
});

test('v3 Phase 0: codexAdapter escape hatch honors PALANTIR_CODEX_MANAGER_BYPASS=1', async () => {
  // Source-level verification that the env var is read and OR'd with worker-role branch.
  const src = await fs.readFile(
    path.join(__dirname, '..', 'services', 'managerAdapters', 'codexAdapter.js'),
    'utf8'
  );
  // Pattern: shouldBypass = role === 'worker' || managerBypassOverride
  const shouldBypassPattern = /shouldBypass\s*=\s*role\s*===\s*['"]worker['"]\s*\|\|\s*managerBypassOverride/;
  assert.ok(shouldBypassPattern.test(src),
    'shouldBypass must OR role===worker with managerBypassOverride');
  const envReadPattern = /managerBypassOverride\s*=\s*process\.env\.PALANTIR_CODEX_MANAGER_BYPASS\s*===\s*['"]1['"]/;
  assert.ok(envReadPattern.test(src),
    'managerBypassOverride must read PALANTIR_CODEX_MANAGER_BYPASS === "1"');
});

test('v3 Phase 0: codexAdapter stores role in session state for resume turns', async () => {
  // Verify role is persisted so resume turns (spawnOneTurn called after thread_id
  // is captured) retain the role policy.
  const src = await fs.readFile(
    path.join(__dirname, '..', 'services', 'managerAdapters', 'codexAdapter.js'),
    'utf8'
  );
  // sessions.set(runId, { ... role: role || 'manager', ... })
  assert.ok(/role:\s*role\s*\|\|\s*['"]manager['"]/.test(src),
    'sessions.set must store role with manager default');
  // spawnOneTurn reads state.role
  assert.ok(/const\s+role\s*=\s*state\.role\s*\|\|\s*['"]manager['"]/.test(src),
    'spawnOneTurn must read role from state');
});

// ─────────────────────────────────────────────────────────────────────────
// v3 Phase 0: Behavior tests (runtime, not source-level)
// ─────────────────────────────────────────────────────────────────────────

test('v3 Phase 0 behavior: claudeAdapter.startSession passes restricted Bash allowlist to engine', () => {
  const { createClaudeAdapter } = require('../services/managerAdapters/claudeAdapter');
  let capturedArgs = null;
  const fakeEngine = {
    spawnAgent(runId, args) {
      capturedArgs = args;
      return { pid: 12345, engine: 'fake', isManager: true };
    },
  };
  const adapter = createClaudeAdapter({ streamJsonEngine: fakeEngine, runService: null });
  adapter.startSession('run_mgr_test', {
    prompt: 'test',
    cwd: process.cwd(),
    systemPrompt: 'test',
  });
  assert.ok(capturedArgs, 'spawnAgent must be called');
  const tools = capturedArgs.allowedTools;
  assert.ok(Array.isArray(tools), 'allowedTools must be an array');
  // Verify no plain Bash or redirection-exploitable patterns
  assert.equal(tools.indexOf('Bash'), -1, 'must not include bare Bash');
  assert.equal(tools.indexOf('Bash(cat:*)'), -1, 'must not include Bash(cat:*) — redirection vulnerable');
  assert.equal(tools.indexOf('Bash(echo:*)'), -1, 'must not include Bash(echo:*) — redirection vulnerable');
  assert.equal(tools.indexOf('Write'), -1, 'must not include Write');
  assert.equal(tools.indexOf('Edit'), -1, 'must not include Edit');
  // Verify core dispatcher tools present
  assert.ok(tools.includes('Bash(curl:*)'), 'must include Bash(curl:*)');
  assert.ok(tools.includes('Read'), 'must include Read');
  assert.equal(capturedArgs.isManager, true, 'must spawn as manager');
});

test('v3 Phase 0 behavior: codexAdapter role=manager spawn args OMIT sandbox bypass flag', () => {
  const { createCodexAdapter } = require('../services/managerAdapters/codexAdapter');

  // Minimal fake child process — enough for spawnOneTurn to not throw
  function makeFakeChild() {
    const { EventEmitter } = require('node:events');
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const stdin = { write: () => {}, end: () => {} };
    const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin, kill: () => {} });
    return child;
  }

  let capturedArgs = null;
  let capturedOpts = null;
  const fakeSpawn = (bin, args, opts) => {
    capturedArgs = args;
    capturedOpts = opts;
    return makeFakeChild();
  };

  const adapter = createCodexAdapter({
    runService: null,
    codexBin: '/bin/true',
    spawnFn: fakeSpawn,
  });

  adapter.startSession('run_codex_mgr', {
    systemPrompt: 'test',
    cwd: process.cwd(),
    role: 'manager',
  });
  adapter.runTurn('run_codex_mgr', { text: 'hello' });

  assert.ok(capturedArgs, 'fake spawn must have been called');
  assert.ok(!capturedArgs.includes('--dangerously-bypass-approvals-and-sandbox'),
    'manager role must NOT pass sandbox bypass flag');
  assert.ok(capturedArgs.includes('--skip-git-repo-check'),
    'manager role should still pass --skip-git-repo-check');
  assert.ok(capturedArgs.includes('exec'), 'should invoke codex exec subcommand');
  assert.ok(capturedArgs.includes('--json'), 'should request JSON output');

  adapter.disposeSession('run_codex_mgr');
});

test('v3 Phase 0 behavior: codexAdapter role=worker spawn args INCLUDE sandbox bypass flag', () => {
  const { createCodexAdapter } = require('../services/managerAdapters/codexAdapter');
  const { EventEmitter } = require('node:events');
  function makeFakeChild() {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const stdin = { write: () => {}, end: () => {} };
    return Object.assign(new EventEmitter(), { stdout, stderr, stdin, kill: () => {} });
  }
  let capturedArgs = null;
  const adapter = createCodexAdapter({
    runService: null,
    codexBin: '/bin/true',
    spawnFn: (bin, args) => { capturedArgs = args; return makeFakeChild(); },
  });
  adapter.startSession('run_codex_wkr', {
    systemPrompt: 'test',
    cwd: process.cwd(),
    role: 'worker',
  });
  adapter.runTurn('run_codex_wkr', { text: 'hello' });
  assert.ok(capturedArgs.includes('--dangerously-bypass-approvals-and-sandbox'),
    'worker role MUST pass sandbox bypass flag');
  adapter.disposeSession('run_codex_wkr');
});

test('v3 Phase 0 behavior: codexAdapter PALANTIR_CODEX_MANAGER_BYPASS=1 re-enables bypass for manager', () => {
  const { createCodexAdapter } = require('../services/managerAdapters/codexAdapter');
  const { EventEmitter } = require('node:events');
  function makeFakeChild() {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const stdin = { write: () => {}, end: () => {} };
    return Object.assign(new EventEmitter(), { stdout, stderr, stdin, kill: () => {} });
  }
  const prev = process.env.PALANTIR_CODEX_MANAGER_BYPASS;
  process.env.PALANTIR_CODEX_MANAGER_BYPASS = '1';
  try {
    let capturedArgs = null;
    const adapter = createCodexAdapter({
      runService: null,
      codexBin: '/bin/true',
      spawnFn: (bin, args) => { capturedArgs = args; return makeFakeChild(); },
    });
    adapter.startSession('run_codex_bypass', {
      systemPrompt: 'test',
      cwd: process.cwd(),
      role: 'manager',
    });
    adapter.runTurn('run_codex_bypass', { text: 'hello' });
    assert.ok(capturedArgs.includes('--dangerously-bypass-approvals-and-sandbox'),
      'PALANTIR_CODEX_MANAGER_BYPASS=1 must re-enable bypass for manager role');
    adapter.disposeSession('run_codex_bypass');
  } finally {
    if (prev === undefined) delete process.env.PALANTIR_CODEX_MANAGER_BYPASS;
    else process.env.PALANTIR_CODEX_MANAGER_BYPASS = prev;
  }
});

test('v3 Phase 0: managerSystemPrompt default layer is top', async () => {
  const { buildManagerSystemPrompt } = require('../services/managerSystemPrompt');
  const promptDefault = buildManagerSystemPrompt({
    adapter: null, port: 4177, token: null,
  });
  const promptTop = buildManagerSystemPrompt({
    adapter: null, port: 4177, token: null, layer: 'top',
  });
  assert.equal(promptDefault, promptTop, 'default layer must equal top');
});

test('v3 Phase 0: claudeAdapter default allowedTools excludes Write/Edit and restricts Bash', async () => {
  // Verify the capability diet is applied at adapter level, not just prompt.
  // We inspect the source file because mocking streamJsonEngine is heavier.
  const src = await fs.readFile(
    path.join(__dirname, '..', 'services', 'managerAdapters', 'claudeAdapter.js'),
    'utf8'
  );
  // Find the default allowedTools array literal (may span multiple lines)
  const match = src.match(/allowedTools:\s*allowedTools\s*\|\|\s*(\[[\s\S]*?\])/);
  assert.ok(match, 'default allowedTools literal must exist');
  const defaultTools = match[1];
  // Write/Edit must be absent entirely
  assert.ok(!defaultTools.includes("'Write'") && !defaultTools.includes('"Write"'),
    'default allowedTools must not include Write');
  assert.ok(!defaultTools.includes("'Edit'") && !defaultTools.includes('"Edit"'),
    'default allowedTools must not include Edit');
  // Plain 'Bash' (no pattern restriction) must NOT appear — would be an escape hatch
  // Match 'Bash' or "Bash" as a bare element (not Bash(...))
  const bareBashMatch = defaultTools.match(/['"]Bash['"](?![\w\(])/);
  assert.equal(bareBashMatch, null,
    'default allowedTools must not contain bare "Bash" (only Bash(pattern:*) restrictions allowed)');
  // Bash(curl:*) pattern MUST exist — primary dispatcher operation
  assert.ok(defaultTools.includes("'Bash(curl:*)'"),
    'default allowedTools must include Bash(curl:*) for API calls');
  // Read must exist
  assert.ok(defaultTools.includes("'Read'"), 'default allowedTools must include Read');
});

test('v3 Phase 0: codexAdapter omits sandbox bypass flag for manager role', async () => {
  // Inspect source to verify role-aware branching is present.
  const src = await fs.readFile(
    path.join(__dirname, '..', 'services', 'managerAdapters', 'codexAdapter.js'),
    'utf8'
  );
  // The role-aware branch must exist
  assert.ok(src.includes("role === 'worker'"),
    'codexAdapter must branch bypass flag on role');
  assert.ok(src.includes('PALANTIR_CODEX_MANAGER_BYPASS'),
    'codexAdapter must provide env escape hatch');
  // The bypass flag push must be guarded by `if (shouldBypass)` — i.e., the
  // line `args.push('--dangerously-bypass-approvals-and-sandbox');` must
  // appear inside a shouldBypass conditional, not at top level.
  const guarded = /if\s*\(\s*shouldBypass\s*\)\s*\{\s*args\.push\('--dangerously-bypass-approvals-and-sandbox'\)/;
  assert.ok(guarded.test(src),
    'bypass push must be guarded by if (shouldBypass) { ... }');
  // And the count of bypass pushes should be exactly 1 (the guarded one)
  const pushMatches = src.match(/args\.push\('--dangerously-bypass-approvals-and-sandbox'\)/g);
  assert.equal(pushMatches && pushMatches.length, 1,
    'exactly one bypass push should exist, and it should be the guarded one');
});
