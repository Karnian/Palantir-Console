// v3 Phase 3a — pmSpawnService (lazy PM spawn) + pmCleanupService
// (single-owner teardown). These tests inject a fake adapter factory so
// no real Codex subprocess is spawned — the service contracts are
// verified end-to-end on the in-memory registry + SQLite.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createProjectService } = require('../services/projectService');
const { createProjectBriefService } = require('../services/projectBriefService');
const { createManagerRegistry } = require('../services/managerRegistry');
const { createConversationService } = require('../services/conversationService');
const { createPmSpawnService } = require('../services/pmSpawnService');
const { createPmCleanupService } = require('../services/pmCleanupService');
const { createApp } = require('../app');

async function mkdb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-pm3a-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return db;
}

// Minimal codex-adapter-shaped fake. Tracks calls for assertions and
// supports onThreadStarted persistence. Every instance has its own set
// of sessions so several "PMs" can coexist in one test.
function makeFakeCodexAdapter({ resumeSupport = true } = {}) {
  const sessions = new Map();
  const runTurnCalls = [];
  const disposeCalls = [];
  return {
    type: 'codex',
    capabilities: { persistentProcess: false, supportsResume: resumeSupport },
    startSession(runId, opts) {
      sessions.set(runId, {
        systemPrompt: opts.systemPrompt,
        cwd: opts.cwd,
        threadId: opts.resumeThreadId || null,
        onThreadStarted: opts.onThreadStarted || null,
        ended: false,
      });
      // Mirror codexAdapter behavior: if resuming, fire callback sync.
      if (opts.resumeThreadId && typeof opts.onThreadStarted === 'function') {
        try { opts.onThreadStarted(opts.resumeThreadId); } catch { /* ignore */ }
      }
      return { sessionRef: { resumedThreadId: opts.resumeThreadId || null } };
    },
    runTurn(runId, payload) {
      const s = sessions.get(runId);
      if (!s || s.ended) return { accepted: false };
      runTurnCalls.push({ runId, payload });
      // Fresh-spawn path: simulate thread.started after the first turn.
      if (!s.threadId) {
        s.threadId = `thread_${runId}`;
        if (typeof s.onThreadStarted === 'function') {
          try { s.onThreadStarted(s.threadId); } catch { /* ignore */ }
        }
      }
      return { accepted: true };
    },
    isSessionAlive(runId) {
      const s = sessions.get(runId);
      return !!s && !s.ended;
    },
    detectExitCode() { return null; },
    emitSessionEndedIfNeeded() {},
    getUsage() { return null; },
    getSessionId(runId) { return sessions.get(runId)?.threadId || null; },
    getOutput() { return null; },
    disposeSession(runId) {
      const s = sessions.get(runId);
      if (s) s.ended = true;
      disposeCalls.push(runId);
    },
    buildGuardrailsSection() { return ''; },
    // Introspection for tests
    _sessions: sessions,
    _runTurnCalls: runTurnCalls,
    _disposeCalls: disposeCalls,
  };
}

function seedTop({ rs, registry, adapter }) {
  const run = rs.createRun({ is_manager: true, manager_adapter: 'claude-code', prompt: 'top' });
  rs.updateRunStatus(run.id, 'running', { force: true });
  registry.setActive('top', run.id, adapter);
  return run;
}

function wireFactory(adapter) {
  return { getAdapter: () => adapter };
}

// ---------------------------------------------------------------------------
// pmSpawnService — lazy spawn
// ---------------------------------------------------------------------------

test('Phase 3a: lazy spawn creates a PM run when none exists', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService: rs });
  const fakePm = makeFakeCodexAdapter();
  const topAdapter = makeFakeCodexAdapter();

  const spawn = createPmSpawnService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm),
    projectService,
    projectBriefService,
    agentProfileService: null,
    authResolverOpts: { hasKeychain: true }, // avoid touching real keychain
  });

  const project = projectService.createProject({ name: 'alpha' });
  seedTop({ rs, registry, adapter: topAdapter });

  // First call: no PM live → spawn fresh
  const result1 = spawn.ensureLivePm({ projectId: project.id });
  assert.equal(result1.spawned, true);
  assert.equal(result1.resumed, false);
  assert.equal(result1.run.manager_layer, 'pm');
  assert.equal(result1.run.conversation_id, `pm:${project.id}`);
  assert.equal(result1.run.is_manager, 1);
  assert.ok(result1.run.parent_run_id, 'parent_run_id should be set to active Top');

  // Registry now has the PM slot
  assert.equal(registry.getActiveRunId(`pm:${project.id}`), result1.run.id);

  // Phase 3a R1 fix: the brief is injected into the SYSTEM prompt, not
  // via a seed runTurn. No adapter.runTurn should fire before the user's
  // own first message lands.
  assert.equal(fakePm._runTurnCalls.length, 0, 'no seed runTurn in spawn path (R1 fix)');

  // The system prompt stored in the adapter session must contain the
  // project section so subsequent turns get cached brief context.
  const sessionState = fakePm._sessions.get(result1.run.id);
  assert.match(sessionState.systemPrompt, /Project Scope/);
  assert.match(sessionState.systemPrompt, /PM Role/);

  // Thread id has NOT been captured yet because no turn has run. It will
  // appear when the first user message triggers runTurn (tested below in
  // the conversationService integration test).
  const briefAfter = projectBriefService.getBrief(project.id);
  assert.equal(briefAfter.pm_thread_id, null, 'thread id only persists after first real turn');

  // Second call: already live → fast path, no new run
  const result2 = spawn.ensureLivePm({ projectId: project.id });
  assert.equal(result2.spawned, false);
  assert.equal(result2.run.id, result1.run.id);
});

test('P2-1: fresh PM spawn leaves run in queued until first turn emits thread.started', async (t) => {
  // Regression guard for the P2-1 fix: pmSpawnService used to call
  // markRunStarted unconditionally right after adapter.startSession
  // returned. For Codex (stateless — no subprocess until the first
  // runTurn) that advertised the PM as 'running' before any execution
  // had actually started, which made the UI pmRunActive badge flip to
  // "Active" pre-flight. The fix moves markRunStarted into the
  // onThreadStarted callback so the transition only happens when the
  // adapter really has a live execution context.
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService: rs });
  const fakePm = makeFakeCodexAdapter();
  const topAdapter = makeFakeCodexAdapter();

  const spawn = createPmSpawnService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm),
    projectService, projectBriefService,
    authResolverOpts: { hasKeychain: true },
  });
  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm),
    lifecycleService: { sendAgentInput: () => true },
    pmSpawnService: spawn,
  });
  const project = projectService.createProject({ name: 'alpha' });
  seedTop({ rs, registry, adapter: topAdapter });

  // Fresh spawn — no resumeThreadId, no runTurn yet.
  const result = spawn.ensureLivePm({ projectId: project.id });
  assert.equal(result.spawned, true);
  assert.equal(result.resumed, false);

  // Pre-P2-1 behavior: run.status would already be 'running'. Post-fix:
  // still 'queued' because thread.started has not fired.
  const runBefore = rs.getRun(result.run.id);
  assert.equal(runBefore.status, 'queued', 'PM run must stay queued until first turn');

  // Trigger the first real user turn via conversationService. The fake
  // adapter's runTurn synthesizes thread.started on first call, which
  // invokes onThreadStarted → markRunStarted.
  conv.sendMessage(`pm:${project.id}`, { text: 'hello' });

  const runAfter = rs.getRun(result.run.id);
  assert.equal(runAfter.status, 'running', 'PM run flips to running after first turn / thread.started');
  // started_at should now be populated (markRunStarted path).
  assert.ok(runAfter.started_at, 'started_at populated by markRunStarted');
});

test('P2-1: resumed PM spawn is marked running synchronously inside startSession', async (t) => {
  // For the resume path the fake adapter fires onThreadStarted
  // synchronously inside startSession, so ensureLivePm should return a
  // run that is already 'running' — no pre-turn 'queued' window is
  // possible because the adapter semantically already has a live thread
  // as soon as resume is wired up.
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService: rs });
  const fakePm = makeFakeCodexAdapter();

  const spawn = createPmSpawnService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm),
    projectService, projectBriefService,
    authResolverOpts: { hasKeychain: true },
  });
  const project = projectService.createProject({ name: 'alpha' });
  seedTop({ rs, registry, adapter: fakePm });

  projectBriefService.ensureBrief(project.id);
  projectBriefService.setPmThread(project.id, {
    pm_thread_id: 'thread_persisted',
    pm_adapter: 'codex',
  });

  const result = spawn.ensureLivePm({ projectId: project.id });
  assert.equal(result.resumed, true);
  const run = rs.getRun(result.run.id);
  assert.equal(run.status, 'running', 'resumed PM must be running immediately');
});

test('Phase 3a: lazy spawn resumes a persisted pm_thread_id', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService: rs });
  const fakePm = makeFakeCodexAdapter();

  const spawn = createPmSpawnService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm),
    projectService,
    projectBriefService,
    authResolverOpts: { hasKeychain: true },
  });

  const project = projectService.createProject({ name: 'alpha' });
  seedTop({ rs, registry, adapter: fakePm });

  // Pre-seed a persisted thread id in the brief
  projectBriefService.ensureBrief(project.id);
  projectBriefService.setPmThread(project.id, {
    pm_thread_id: 'thread_persisted',
    pm_adapter: 'codex',
  });

  const result = spawn.ensureLivePm({ projectId: project.id });
  assert.equal(result.resumed, true);
  // The adapter state has threadId pre-seeded via resumeThreadId
  const sessionState = fakePm._sessions.get(result.run.id);
  assert.equal(sessionState.threadId, 'thread_persisted');
  // Brief should NOT have been overwritten (same id)
  const brief = projectBriefService.getBrief(project.id);
  assert.equal(brief.pm_thread_id, 'thread_persisted');
});

test('Phase 3a: lazy spawn refuses when no active Top', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService: rs });
  const fakePm = makeFakeCodexAdapter();
  const spawn = createPmSpawnService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm),
    projectService,
    projectBriefService,
    authResolverOpts: { hasKeychain: true },
  });
  const project = projectService.createProject({ name: 'alpha' });
  assert.throws(
    () => spawn.ensureLivePm({ projectId: project.id }),
    /no active Top manager/
  );
});

test('Phase 3a: lazy spawn refuses when pm_enabled=0', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService: rs });
  const fakePm = makeFakeCodexAdapter();
  const spawn = createPmSpawnService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm),
    projectService,
    projectBriefService,
    authResolverOpts: { hasKeychain: true },
  });
  const project = projectService.createProject({ name: 'alpha', pm_enabled: false });
  seedTop({ rs, registry, adapter: fakePm });
  assert.throws(
    () => spawn.ensureLivePm({ projectId: project.id }),
    /PM is disabled/
  );
});

test('Phase 3a: conversationService integrates lazy PM spawn on first message', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService: rs });
  const fakePm = makeFakeCodexAdapter();
  const topAdapter = makeFakeCodexAdapter();

  const spawn = createPmSpawnService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm),
    projectService,
    projectBriefService,
    authResolverOpts: { hasKeychain: true },
  });
  const conv = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm),
    lifecycleService: { sendAgentInput: () => true },
    pmSpawnService: spawn,
  });

  const project = projectService.createProject({ name: 'alpha' });
  seedTop({ rs, registry, adapter: topAdapter });

  // First call: no PM → conversationService should lazy-spawn and deliver
  const sendResult = conv.sendMessage(`pm:${project.id}`, { text: '시작' });
  assert.equal(sendResult.status, 'sent');
  assert.equal(sendResult.target.kind, 'pm');

  // Phase 3a R1 fix: exactly ONE runTurn — the user's own first message.
  // No seed turn was made by pmSpawnService.
  assert.equal(fakePm._runTurnCalls.length, 1, 'exactly one runTurn = the user message');
  assert.match(fakePm._runTurnCalls[0].payload.text, /시작/);

  // After the user's message, the fake adapter's mocked thread.started
  // handler should have fired and persisted the id into the brief.
  const brief = projectBriefService.getBrief(project.id);
  assert.ok(brief.pm_thread_id, 'thread id persisted after first real turn');
  assert.equal(brief.pm_adapter, 'codex');

  // Second call: PM already live → direct delivery (no re-spawn)
  conv.sendMessage(`pm:${project.id}`, { text: '두번째' });
  assert.equal(fakePm._runTurnCalls.length, 2);
});

test('Phase 3a: R1 fix — no back-to-back runTurn race on cold PM spawn', async (t) => {
  // Regression: the original implementation called runTurn inside
  // pmSpawnService as a "seed" turn, then conversationService called
  // runTurn again with the user's message on the same runId. Real Codex
  // rejects the second call with "previous turn still running". A fake
  // adapter that enforces the single-turn guard must accept the flow.
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService: rs });
  // Strict adapter: rejects any runTurn while a previous call is "in flight".
  // Since the fake is synchronous we simulate that by checking call count
  // against a matching completion marker — every runTurn must resolve
  // before the next starts. In the FIXED code path we expect exactly one
  // runTurn (the user message) so this guard should never fire.
  let inFlight = false;
  const strictPm = {
    type: 'codex',
    capabilities: { persistentProcess: false },
    _sessions: new Map(),
    calls: [],
    startSession(runId, opts) {
      strictPm._sessions.set(runId, { threadId: opts.resumeThreadId || null, onThreadStarted: opts.onThreadStarted, ended: false });
      if (opts.resumeThreadId && opts.onThreadStarted) opts.onThreadStarted(opts.resumeThreadId);
      return { sessionRef: {} };
    },
    runTurn(runId, payload) {
      if (inFlight) throw new Error('previous turn still running');
      inFlight = true;
      strictPm.calls.push({ runId, payload });
      const s = strictPm._sessions.get(runId);
      if (s && !s.threadId && s.onThreadStarted) {
        s.threadId = `thread_${runId}`;
        s.onThreadStarted(s.threadId);
      }
      inFlight = false;
      return { accepted: true };
    },
    isSessionAlive: (id) => !!strictPm._sessions.get(id) && !strictPm._sessions.get(id).ended,
    detectExitCode: () => null,
    emitSessionEndedIfNeeded: () => {},
    getUsage: () => null,
    getSessionId: () => null,
    getOutput: () => null,
    disposeSession: (id) => { const s = strictPm._sessions.get(id); if (s) s.ended = true; },
    buildGuardrailsSection: () => '',
  };
  const spawn = createPmSpawnService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: wireFactory(strictPm),
    projectService, projectBriefService,
    authResolverOpts: { hasKeychain: true },
  });
  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: wireFactory(strictPm),
    lifecycleService: { sendAgentInput: () => true },
    pmSpawnService: spawn,
  });

  const project = projectService.createProject({ name: 'alpha' });
  seedTop({ rs, registry, adapter: strictPm });

  // If the seed-runTurn race existed, this would throw.
  const result = conv.sendMessage(`pm:${project.id}`, { text: 'cold start' });
  assert.equal(result.status, 'sent');
  assert.equal(strictPm.calls.length, 1, 'exactly one runTurn — the user message');
});

// ---------------------------------------------------------------------------
// pmCleanupService
// ---------------------------------------------------------------------------

test('Phase 3a: pmCleanupService.reset disposes live PM and clears brief', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService: rs });
  const fakePm = makeFakeCodexAdapter();
  const topAdapter = makeFakeCodexAdapter();
  const conv = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm),
    lifecycleService: { sendAgentInput: () => true },
  });
  // Slot-clear hook so reset also drops any queued notices
  registry.onSlotCleared(({ runId }) => { conv.clearParentNotices(runId); });

  const spawn = createPmSpawnService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm),
    projectService,
    projectBriefService,
    authResolverOpts: { hasKeychain: true },
  });
  const cleanup = createPmCleanupService({
    projectService,
    projectBriefService,
    managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm),
    runService: rs,
  });

  const project = projectService.createProject({ name: 'alpha' });
  seedTop({ rs, registry, adapter: topAdapter });
  const spawnResult = spawn.ensureLivePm({ projectId: project.id });
  const pmRunId = spawnResult.run.id;

  // The thread id only materializes on the first real turn (R1 fix —
  // no seed runTurn inside pmSpawnService). Trigger it via conv.
  conv.sendMessage(`pm:${project.id}`, { text: 'first' });

  // Pre-reset: slot is live, brief has thread id
  assert.ok(registry.getActiveRunId(`pm:${project.id}`));
  assert.ok(projectBriefService.getBrief(project.id).pm_thread_id);

  const result = cleanup.reset(project.id);
  assert.equal(result.disposed, true);
  assert.equal(result.clearedBrief, true);
  assert.equal(result.cancelledRunId, pmRunId);

  // Post-reset: slot cleared, brief thread id null, adapter disposeSession called
  assert.equal(registry.getActiveRunId(`pm:${project.id}`), null);
  assert.equal(projectBriefService.getBrief(project.id).pm_thread_id, null);
  assert.ok(fakePm._disposeCalls.includes(pmRunId));

  // Run row is marked cancelled
  const run = rs.getRun(pmRunId);
  assert.equal(run.status, 'cancelled');
});

test('Phase 3a: pmCleanupService.reset is idempotent when no PM is live', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService: rs });
  const fakePm = makeFakeCodexAdapter();
  const cleanup = createPmCleanupService({
    projectService, projectBriefService, managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm), runService: rs,
  });
  const project = projectService.createProject({ name: 'alpha' });
  const result = cleanup.reset(project.id);
  assert.equal(result.disposed, false);
  assert.equal(result.clearedBrief, false);
  assert.equal(result.cancelledRunId, null);
});

test('Phase 3a: lazy spawn after reset starts a fresh thread', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService: rs });
  const fakePm = makeFakeCodexAdapter();
  const topAdapter = makeFakeCodexAdapter();
  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm),
    lifecycleService: { sendAgentInput: () => true },
  });
  registry.onSlotCleared(({ runId }) => { conv.clearParentNotices(runId); });

  const spawn = createPmSpawnService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm),
    projectService, projectBriefService,
    authResolverOpts: { hasKeychain: true },
  });
  const cleanup = createPmCleanupService({
    projectService, projectBriefService, managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm), runService: rs,
  });

  const project = projectService.createProject({ name: 'alpha' });
  seedTop({ rs, registry, adapter: topAdapter });

  // First spawn + first turn → thread id persisted (R1 fix: no seed turn,
  // thread id only appears after the first real runTurn).
  const first = spawn.ensureLivePm({ projectId: project.id });
  conv.sendMessage(`pm:${project.id}`, { text: 'first message' });
  const firstThreadId = projectBriefService.getBrief(project.id).pm_thread_id;
  assert.ok(firstThreadId);

  // Reset
  cleanup.reset(project.id);

  // Second spawn + turn — should be a new run with a new thread id
  const second = spawn.ensureLivePm({ projectId: project.id });
  assert.notEqual(second.run.id, first.run.id);
  assert.equal(second.resumed, false, 'second spawn is a fresh thread, not a resume');
  conv.sendMessage(`pm:${project.id}`, { text: 'after reset' });
  const secondThreadId = projectBriefService.getBrief(project.id).pm_thread_id;
  assert.notEqual(secondThreadId, firstThreadId);
});

// ---------------------------------------------------------------------------
// HTTP wiring: /api/manager/pm/:projectId/reset + project delete cascade
// ---------------------------------------------------------------------------

async function createTestApp(t) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-pm3a-storage-'));
  const fsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-pm3a-fs-'));
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-pm3a-db-'));
  const dbPath = path.join(dbDir, 'test.db');
  const app = createApp({
    storageRoot,
    fsRoot,
    dbPath,
    authResolverOpts: { hasKeychain: true },
  });
  t.after(async () => {
    if (app.shutdown) app.shutdown();
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
    await fs.rm(dbDir, { recursive: true, force: true });
  });
  return app;
}

test('Phase 3a: POST /api/manager/pm/:projectId/reset on missing PM returns idempotent ok', async (t) => {
  const app = await createTestApp(t);
  // Create a project so we have something to reset against
  const createRes = await request(app).post('/api/projects').send({ name: 'alpha' });
  assert.equal(createRes.status, 201);
  const projectId = createRes.body.project.id;

  const res = await request(app).post(`/api/manager/pm/${projectId}/reset`).send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'reset');
  assert.equal(res.body.disposed, false);
});

test('Phase 3a: DELETE /api/projects/:id runs pmCleanupService.dispose before deleting', async (t) => {
  // Can't fully exercise without a real Codex, but we can verify the
  // route doesn't crash and the project is deleted.
  const app = await createTestApp(t);
  const createRes = await request(app).post('/api/projects').send({ name: 'alpha' });
  const projectId = createRes.body.project.id;

  const delRes = await request(app).delete(`/api/projects/${projectId}`);
  assert.equal(delRes.status, 200);

  const getRes = await request(app).get(`/api/projects/${projectId}`);
  assert.equal(getRes.status, 404);
});

test('Phase 3a: R2 fix — pmCleanupService.reset rethrows disposeSession failures and leaves state intact', async (t) => {
  // Regression for codex R2: _terminate used to swallow disposeSession
  // errors, mark the run cancelled, clear the registry, and clear the
  // brief — returning success to the caller. That made both /reset and
  // DELETE /api/projects/:id silently drop in-memory PM state even when
  // the adapter hadn't actually torn down. Now a dispose failure must:
  //   (a) throw with httpStatus 502
  //   (b) leave managerRegistry slot intact (so retry can address it)
  //   (c) leave project_briefs.pm_thread_id intact
  //   (d) NOT mark the run as cancelled
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService: rs });

  // Adapter that accepts startSession / runTurn normally but throws on disposeSession
  const flakyDispose = makeFakeCodexAdapter();
  const realDispose = flakyDispose.disposeSession.bind(flakyDispose);
  flakyDispose.disposeSession = () => { throw new Error('disk full'); };

  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: wireFactory(flakyDispose),
    lifecycleService: { sendAgentInput: () => true },
  });
  const spawn = createPmSpawnService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: wireFactory(flakyDispose),
    projectService, projectBriefService,
    authResolverOpts: { hasKeychain: true },
  });
  const cleanup = createPmCleanupService({
    projectService, projectBriefService, managerRegistry: registry,
    managerAdapterFactory: wireFactory(flakyDispose), runService: rs,
  });

  const project = projectService.createProject({ name: 'alpha' });
  seedTop({ rs, registry, adapter: flakyDispose });
  spawn.ensureLivePm({ projectId: project.id });
  conv.sendMessage(`pm:${project.id}`, { text: 'first' });
  const pmRunIdBefore = registry.getActiveRunId(`pm:${project.id}`);
  const threadIdBefore = projectBriefService.getBrief(project.id).pm_thread_id;
  assert.ok(pmRunIdBefore);
  assert.ok(threadIdBefore);
  const statusBefore = rs.getRun(pmRunIdBefore).status;

  // Reset must throw, and no state must have changed.
  assert.throws(() => cleanup.reset(project.id), /disposeSession failed/);
  assert.equal(registry.getActiveRunId(`pm:${project.id}`), pmRunIdBefore, 'registry slot must remain');
  assert.equal(projectBriefService.getBrief(project.id).pm_thread_id, threadIdBefore, 'brief must remain');
  assert.equal(rs.getRun(pmRunIdBefore).status, statusBefore, 'run status must remain (not cancelled)');

  // Restore and retry — reset now succeeds end-to-end.
  flakyDispose.disposeSession = realDispose;
  const result = cleanup.reset(project.id);
  assert.equal(result.disposed, true);
  assert.equal(registry.getActiveRunId(`pm:${project.id}`), null);
});

test('Phase 3a: R1 fix — DELETE /api/projects/:id refuses on pmCleanupService failure', async (t) => {
  // Regression for codex R1 finding #2: delete must NOT proceed if
  // cleanup throws, otherwise orphaned in-memory PM state is unreachable.
  // Use a direct express mount so we can inject a failing cleanup stub.
  const express = require('express');
  const { createProjectsRouter } = require('../routes/projects');
  const stubProjectService = {
    getProject: () => ({ id: 'p1', name: 'alpha' }),
    deleteProject: () => { throw new Error('deleteProject should not be called'); },
  };
  const failingCleanup = {
    dispose: () => { throw new Error('adapter exploded'); },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/projects', createProjectsRouter({
    projectService: stubProjectService,
    taskService: { listTasks: () => [] },
    projectBriefService: null,
    pmCleanupService: failingCleanup,
  }));
  const res = await request(app).delete('/api/projects/p1');
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'pm_dispose_failed');
  assert.match(res.body.message, /adapter exploded/);
});

test('Phase 3a: PM system prompt uses layer=pm variant', () => {
  const { buildManagerSystemPrompt } = require('../services/managerSystemPrompt');
  const fakeAdapter = {
    buildGuardrailsSection: () => '## Adapter Guardrails\nTest.',
  };
  const topPrompt = buildManagerSystemPrompt({ adapter: fakeAdapter, port: 4177, layer: 'top' });
  const pmPrompt = buildManagerSystemPrompt({ adapter: fakeAdapter, port: 4177, layer: 'pm' });
  assert.match(topPrompt, /top-level dispatcher/);
  assert.match(pmPrompt, /project-scoped PM/);
  // PM gets worker intervention APIs, Top does not
  assert.match(pmPrompt, /Worker Plan Modification/);
  assert.doesNotMatch(topPrompt, /Worker Plan Modification/);
});
