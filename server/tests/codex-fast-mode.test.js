// F-1 — Codex Fast Mode toggle.
//
// Covers the spec's required test list (docs/specs/codex-fast-mode-brief.md §4):
//   ① Top / fresh startSession emits `-c service_tier=...`
//   ② Operator fresh + resume paths both emit tier
//   ③ boot resume path emit (covered by the resume adapter test — the route
//      just forwards the same startOpts.serviceTier)
//   ④ codex worker pinned to "default"
//   ⑤ non-codex custom command gets NO `-c service_tier`
//   ⑥ auto-review source → "default" (overrides a fast session)
//   ⑦ per-instance fast_mode > env priority (resolveCodexServiceTier unit)
//   ⑧ PATCH cookie-only
//   ⑨ fast emit co-emits features.fast_mode=true
// plus: codex:fast_unavailable dedupe across exit/error, default when unset.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');

const {
  createCodexAdapter,
  resolveCodexServiceTier,
} = require('../services/managerAdapters/codexAdapter');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function createFakeDuplexChild() {
  const { EventEmitter } = require('node:events');
  const { PassThrough, Writable } = require('node:stream');
  const child = new EventEmitter();
  child.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => { child.killedWith = signal; };
  return child;
}

function makeRunService() {
  const events = [];
  const statuses = [];
  return {
    events,
    statuses,
    addRunEvent(runId, type, payload) { events.push({ runId, type, payload: payload ? JSON.parse(payload) : null }); },
    updateRunStatus(runId, status) { statuses.push({ runId, status }); },
    updateManagerThreadId() {},
    updateRunResult() {},
    eventsOfType(type) { return events.filter((e) => e.type === type); },
    cflags(runId) {
      // reconstruct the -c flags captured on the last spawn for this run
      return null;
    },
  };
}

function collectCflags(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' && i + 1 < args.length) out.push(args[i + 1]);
  }
  return out;
}

function waitImmediate() { return new Promise((r) => setImmediate(r)); }

// ---------------------------------------------------------------------------
// ⑦ resolveCodexServiceTier — priority
// ---------------------------------------------------------------------------

test('⑦ resolveCodexServiceTier: per-instance fast_mode overrides env', () => {
  // fast_mode=1 → fast even when env is unset/standard
  assert.equal(resolveCodexServiceTier(1, { env: {} }), 'fast');
  assert.equal(resolveCodexServiceTier(1, { env: { PALANTIR_CODEX_FAST: '0' } }), 'fast');
  // fast_mode=0 → standard even when env says fast
  assert.equal(resolveCodexServiceTier(0, { env: { PALANTIR_CODEX_FAST: '1' } }), 'default');
  // null/undefined → follow env (the Number(null)===0 trap must NOT pin standard)
  assert.equal(resolveCodexServiceTier(null, { env: { PALANTIR_CODEX_FAST: '1' } }), 'fast');
  assert.equal(resolveCodexServiceTier(undefined, { env: { PALANTIR_CODEX_FAST: '1' } }), 'fast');
  assert.equal(resolveCodexServiceTier(null, { env: {} }), 'default');
});

// ---------------------------------------------------------------------------
// ① fresh startSession emits service_tier
// ---------------------------------------------------------------------------

test('① fresh codex turn always emits -c service_tier (default when unset)', async () => {
  let captured = null;
  const fakeSpawn = (_bin, args) => { captured = args; const c = createFakeDuplexChild(); return c; };
  const rs = makeRunService();
  const adapter = createCodexAdapter({ runService: rs, spawnFn: fakeSpawn });
  adapter.startSession('run_fresh', { systemPrompt: 'x', cwd: os.tmpdir(), model: 'gpt' });
  const res = adapter.runTurn('run_fresh', { text: 'hi' });
  assert.equal(res.accepted, true);
  await waitImmediate();
  const cflags = collectCflags(captured);
  assert.ok(cflags.includes('service_tier="default"'), 'default tier emitted on fresh turn');
  assert.ok(!cflags.includes('features.fast_mode=true'), 'no fast feature flag when standard');
});

// ---------------------------------------------------------------------------
// ⑨ fast emit co-emits features.fast_mode
// ---------------------------------------------------------------------------

test('⑨ fast tier emits service_tier="fast" AND features.fast_mode=true', async () => {
  let captured = null;
  const fakeSpawn = (_bin, args) => { captured = args; return createFakeDuplexChild(); };
  const rs = makeRunService();
  const adapter = createCodexAdapter({ runService: rs, spawnFn: fakeSpawn });
  adapter.startSession('run_fast', { systemPrompt: 'x', cwd: os.tmpdir(), serviceTier: 'fast' });
  adapter.runTurn('run_fast', { text: 'go' });
  await waitImmediate();
  const cflags = collectCflags(captured);
  assert.ok(cflags.includes('service_tier="fast"'), 'fast tier emitted');
  assert.ok(cflags.includes('features.fast_mode=true'), 'fast feature flag co-emitted');
  // TURN_STARTED records the used tier
  const started = rs.eventsOfType('mgr.turn_started');
  assert.ok(started.length && started[0].payload && started[0].payload.data.tier === 'fast', 'turn_started records tier');
});

// ---------------------------------------------------------------------------
// ② resume path emits tier + function resolver
// ---------------------------------------------------------------------------

test('② resume turn emits tier, and a function resolver is read per turn (live toggle)', async () => {
  let captured = null;
  let lastChild = null;
  const fakeSpawn = (_bin, args) => { captured = args; lastChild = createFakeDuplexChild(); return lastChild; };
  const rs = makeRunService();
  const adapter = createCodexAdapter({ runService: rs, spawnFn: fakeSpawn });
  // Simulate an Operator whose fast_mode toggles between turns via a resolver.
  let fastMode = 0;
  adapter.startSession('run_resume', {
    systemPrompt: 'x', cwd: os.tmpdir(),
    resumeThreadId: 'thr_123', // forces the resume arg shape (codex exec resume ...)
    serviceTier: () => resolveCodexServiceTier(fastMode),
  });
  adapter.runTurn('run_resume', { text: 't1' });
  await waitImmediate();
  let cflags = collectCflags(captured);
  assert.ok(captured.includes('resume') && captured.includes('thr_123'), 'resume arg shape');
  assert.ok(cflags.includes('service_tier="default"'), 'resume turn emits tier (standard)');

  // Complete the first turn (clears currentChild) so the second turn is accepted.
  lastChild.emit('exit', 0, null);
  await waitImmediate();

  // Toggle fast ON — next turn must pick it up without a re-spawn.
  fastMode = 1;
  const res2 = adapter.runTurn('run_resume', { text: 't2' });
  assert.equal(res2.accepted, true, 'second turn accepted after first completed');
  await waitImmediate();
  cflags = collectCflags(captured);
  assert.ok(cflags.includes('service_tier="fast"'), 'resolver re-read → fast on next turn');
});

// ---------------------------------------------------------------------------
// ⑥ auto-review source forces standard even on a fast session
// ---------------------------------------------------------------------------

test('⑥ auto_review turn forces service_tier="default" even when session is fast', async () => {
  let captured = null;
  const fakeSpawn = (_bin, args) => { captured = args; return createFakeDuplexChild(); };
  const rs = makeRunService();
  const adapter = createCodexAdapter({ runService: rs, spawnFn: fakeSpawn });
  adapter.startSession('run_ar', { systemPrompt: 'x', cwd: os.tmpdir(), serviceTier: 'fast' });
  adapter.runTurn('run_ar', { text: 'review this', source: 'auto_review' });
  await waitImmediate();
  const cflags = collectCflags(captured);
  assert.ok(cflags.includes('service_tier="default"'), 'auto_review forced to standard');
  assert.ok(!cflags.includes('features.fast_mode=true'), 'no fast flag on forced-standard auto_review');
});

// ---------------------------------------------------------------------------
// codex:fast_unavailable — emitted once on a failed fast turn
// ---------------------------------------------------------------------------

test('codex:fast_unavailable emitted exactly once when a fast turn fails (exit+error dedupe)', async () => {
  let child = null;
  const fakeSpawn = () => { child = createFakeDuplexChild(); return child; };
  const rs = makeRunService();
  const adapter = createCodexAdapter({ runService: rs, spawnFn: fakeSpawn });
  adapter.startSession('run_fail', { systemPrompt: 'x', cwd: os.tmpdir(), serviceTier: 'fast' });
  adapter.runTurn('run_fail', { text: 'go' });
  await waitImmediate();
  // Simulate a nonzero exit AND a late error — must not double-emit.
  child.emit('exit', 1, null);
  child.emit('error', new Error('late'));
  await waitImmediate();
  const fu = rs.eventsOfType('codex:fast_unavailable');
  assert.equal(fu.length, 1, 'exactly one codex:fast_unavailable');
  assert.equal(fu[0].payload.tier, 'fast');
});

test('codex:fast_unavailable NOT emitted when a standard turn fails', async () => {
  let child = null;
  const fakeSpawn = () => { child = createFakeDuplexChild(); return child; };
  const rs = makeRunService();
  const adapter = createCodexAdapter({ runService: rs, spawnFn: fakeSpawn });
  adapter.startSession('run_std_fail', { systemPrompt: 'x', cwd: os.tmpdir() /* default tier */ });
  adapter.runTurn('run_std_fail', { text: 'go' });
  await waitImmediate();
  child.emit('exit', 1, null);
  await waitImmediate();
  assert.equal(rs.eventsOfType('codex:fast_unavailable').length, 0, 'no fast_unavailable on standard turn');
});

// ---------------------------------------------------------------------------
// ④ / ⑤ worker tier via lifecycleService
// ---------------------------------------------------------------------------

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createTaskService } = require('../services/taskService');
const { createProjectService } = require('../services/projectService');
const { createAgentProfileService } = require('../services/agentProfileService');
const { createLifecycleService } = require('../services/lifecycleService');

function stubExecEngine() {
  const spawned = [];
  return {
    spawned,
    spawnAgent(runId, opts) { spawned.push({ runId, opts }); return { sessionName: `s-${runId}` }; },
    isAlive() { return true; },
    detectExitCode() { return null; },
    getOutput() { return ''; },
    sendInput() { return true; },
    kill() {},
    discoverGhostSessions() { return []; },
    hasProcess() { return false; },
  };
}
function stubSJE() {
  const spawned = [];
  return {
    spawned,
    spawnAgent(runId, opts) { spawned.push({ runId, opts }); return { sessionName: null }; },
    isAlive() { return true; },
    detectExitCode() { return null; },
    getOutput() { return ''; },
    sendInput() { return true; },
    kill() {},
    discoverGhostSessions() { return []; },
    hasProcess() { return false; },
  };
}

async function mkWorkerHarness(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-f1-worker-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 'test.db'));
  migrate();
  t.after(async () => { close(); await fsp.rm(dir, { recursive: true, force: true }); });
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const exec = stubExecEngine();
  const sje = stubSJE();
  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: exec, streamJsonEngine: sje, worktreeService: null, eventBus: null,
  });
  return { db, rs, ts, ps, aps, exec, lc };
}

function seedProfile(db, command) {
  const id = `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO agent_profiles (id, name, type, command, args_template, capabilities_json, env_allowlist, max_concurrent)
     VALUES (?, ?, ?, ?, ?, ?, ?, 5)`
  ).run(id, 'Agent', command, command, '{prompt} {system_prompt_file}', '{}', '[]');
  return { id };
}

test('④ codex worker is pinned to -c service_tier="default" (even without a preset)', async (t) => {
  const { db, ts, ps, lc, exec } = await mkWorkerHarness(t);
  const project = ps.createProject({ name: 'P', directory: null });
  const task = ts.createTask({ project_id: project.id, title: 'T', description: 'd' });
  const profile = seedProfile(db, 'codex');
  await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'hi' });
  assert.equal(exec.spawned.length, 1);
  const cflags = collectCflags(exec.spawned[0].opts.args);
  assert.ok(cflags.includes('service_tier="default"'), 'codex worker pinned to standard tier');
});

test('⑤ non-codex custom command worker gets NO -c service_tier', async (t) => {
  const { db, ts, ps, lc, exec } = await mkWorkerHarness(t);
  const project = ps.createProject({ name: 'P', directory: null });
  const task = ts.createTask({ project_id: project.id, title: 'T', description: 'd' });
  const profile = seedProfile(db, 'echo'); // resolveAdapterName → 'other'
  await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'hi' });
  assert.equal(exec.spawned.length, 1);
  const cflags = collectCflags(exec.spawned[0].opts.args);
  assert.ok(!cflags.some((c) => /^service_tier=/.test(c)), 'no service_tier on non-codex command');
});

// ---------------------------------------------------------------------------
// ⑧ PATCH cookie-only + round-trip
// ---------------------------------------------------------------------------

const { createApp } = require('../app');

function setupApp(t, { authToken } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-f1-app-'));
  const app = createApp({
    storageRoot: tmp, fsRoot: tmp, dbPath: path.join(tmp, 'test.db'),
    authResolverOpts: { hasKeychain: () => false }, authToken: authToken ?? null,
  });
  t.after(() => { try { if (app.shutdown) app.shutdown(); else app.closeDb(); } catch { /* */ } fs.rmSync(tmp, { recursive: true, force: true }); });
  // Seed a project + operator instance directly.
  const db = app.services._rawDb;
  db.prepare("INSERT INTO projects (id, name, pm_enabled) VALUES ('p1', 'P', 1)").run();
  db.prepare("INSERT INTO operator_instances (id) VALUES ('oi_p1')").run();
  db.prepare("INSERT INTO operator_codebase_refs (instance_id, project_id, role) VALUES ('oi_p1', 'p1', 'primary')").run();
  return app;
}

test('⑧ PATCH /fast-mode requires human cookie auth (bearer + none rejected)', async (t) => {
  const app = setupApp(t, { authToken: 'secret-token' });
  // bearer (the Operator's own path) is rejected
  await request(app).patch('/api/operator-instances/oi_p1/fast-mode')
    .set('Authorization', 'Bearer secret-token').send({ fast_mode: 1 }).expect(403);
  // cookie (human) succeeds
  const ok = await request(app).patch('/api/operator-instances/oi_p1/fast-mode')
    .set('Cookie', 'palantir_token=secret-token').send({ fast_mode: 1 }).expect(200);
  assert.equal(ok.body.instance.fast_mode, 1);
});

test('⑧ PATCH /fast-mode validates the payload + round-trips via GET', async (t) => {
  const app = setupApp(t, { authToken: 'secret-token' });
  const COOKIE = ['Cookie', 'palantir_token=secret-token'];
  // invalid value → 400
  await request(app).patch('/api/operator-instances/oi_p1/fast-mode')
    .set(...COOKIE).send({ fast_mode: 'yes' }).expect(400);
  // set 1, then clear to null
  await request(app).patch('/api/operator-instances/oi_p1/fast-mode').set(...COOKIE).send({ fast_mode: 1 }).expect(200);
  let get = await request(app).get('/api/operator-instances/oi_p1').set(...COOKIE).expect(200);
  assert.equal(get.body.instance.fast_mode, 1, 'GET reflects fast_mode (same read the status snapshot uses)');
  await request(app).patch('/api/operator-instances/oi_p1/fast-mode').set(...COOKIE).send({ fast_mode: null }).expect(200);
  get = await request(app).get('/api/operator-instances/oi_p1').set(...COOKIE).expect(200);
  assert.equal(get.body.instance.fast_mode, null, 'null clears the toggle back to env-follow');
});

test('migration 053: operator_instances.fast_mode column exists', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-f1-mig-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 'test.db'));
  migrate();
  t.after(async () => { close(); await fsp.rm(dir, { recursive: true, force: true }); });
  const cols = db.prepare('PRAGMA table_info(operator_instances)').all().map((c) => c.name);
  assert.ok(cols.includes('fast_mode'), 'fast_mode column present');
});
