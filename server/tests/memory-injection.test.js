// ML PR1 — conversationService user-payload injection + GET route + the
// CRITICAL system-prompt invariance regression (fresh-spawn + boot-resume).
//
// No real CLI is spawned: a codex-adapter-shaped fake captures runTurn
// payloads so we can assert the `## Learned Memory` block lands in the
// USER payload (never the system prompt) and respects the ledger gate.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createProjectService } = require('../services/projectService');
const { createProjectBriefService } = require('../services/projectBriefService');
const { createManagerRegistry } = require('../services/managerRegistry');
const { createConversationService } = require('../services/conversationService');
const { createOperatorSpawnService } = require('../services/operatorSpawnService');
const { createMemoryService } = require('../services/memoryService');
const { createMasterMemoryService } = require('../services/masterMemoryService');
const { createCompositionLedger } = require('../services/compositionLedger');
const { createMemoryComposer, buildWorkspaceAdapter, buildUserAdapter } = require('../services/memoryComposer');
const { buildManagerSystemPrompt } = require('../services/managerSystemPrompt');
const { createEventBus } = require('../services/eventBus');
const { createApp } = require('../app');
const { invokeApp } = require('./helpers/invokeApp');

async function mkdb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-mem-inj-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    try { close(); } catch { /* */ }
    await fs.rm(dir, { recursive: true, force: true });
  });
  return db;
}

// codex-adapter-shaped fake (mirrors pm-phase3a.test.js) capturing runTurn.
function makeFakeCodexAdapter() {
  const sessions = new Map();
  const runTurnCalls = [];
  return {
    type: 'codex',
    capabilities: { persistentProcess: false, supportsResume: true },
    startSession(runId, opts) {
      sessions.set(runId, {
        systemPrompt: opts.systemPrompt,
        threadId: opts.resumeThreadId || null,
        onThreadStarted: opts.onThreadStarted || null,
        ended: false,
      });
      if (opts.resumeThreadId && typeof opts.onThreadStarted === 'function') {
        try { opts.onThreadStarted(opts.resumeThreadId); } catch { /* ignore */ }
      }
      return { sessionRef: { resumedThreadId: opts.resumeThreadId || null } };
    },
    runTurn(runId, payload) {
      const s = sessions.get(runId);
      if (!s || s.ended) return { accepted: false };
      // Test knob: reject exactly one turn while keeping the session alive
      // (so probeActive does NOT clear/respawn the slot). Lets a test drive
      // the "send failed -> 502" path deterministically.
      if (s.rejectNext) {
        s.rejectNext = false;
        return { accepted: false };
      }
      runTurnCalls.push({ runId, payload });
      if (!s.threadId) {
        s.threadId = `thread_${runId}`;
        if (typeof s.onThreadStarted === 'function') {
          try { s.onThreadStarted(s.threadId); } catch { /* ignore */ }
        }
      }
      return { accepted: true };
    },
    isSessionAlive(runId) { const s = sessions.get(runId); return !!s && !s.ended; },
    detectExitCode() { return null; },
    emitSessionEndedIfNeeded() {},
    getUsage() { return null; },
    getSessionId(runId) { return sessions.get(runId)?.threadId || null; },
    getOutput() { return null; },
    disposeSession(runId) { const s = sessions.get(runId); if (s) s.ended = true; },
    buildGuardrailsSection() { return ''; },
    _sessions: sessions,
    _runTurnCalls: runTurnCalls,
  };
}

function seedTop({ rs, registry, adapter }) {
  const run = rs.createRun({ is_manager: true, manager_adapter: 'claude-code', prompt: 'top' });
  rs.updateRunStatus(run.id, 'running', { force: true });
  // Give the fake adapter a live session for this run so probeActive()'s
  // isSessionAlive() check passes when a test actually SENDS to 'top'.
  adapter.startSession(run.id, { systemPrompt: 'top', cwd: process.cwd() });
  registry.setActive('top', run.id, adapter);
  return run;
}

function wireFactory(adapter) { return { getAdapter: () => adapter }; }

// ---------------------------------------------------------------------------
// GET /api/projects/:id/memory
// ---------------------------------------------------------------------------

async function createTestApp(t) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-storage-'));
  const fsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-fs-'));
  const dbPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-db-')), 'test.db');
  const app = createApp({
    storageRoot, fsRoot, opencodeBin: 'opencode', dbPath,
    authResolverOpts: { hasKeychain: () => false }, authToken: null,
  });
  t.after(async () => {
    if (app.shutdown) app.shutdown(); else app.closeDb();
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
    await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  });
  return app;
}

test('GET /api/projects/:id/memory returns the seeded memory', async (t) => {
  const app = await createTestApp(t);

  const create = await invokeApp(app, { method: 'POST', path: '/api/projects', body: { name: 'Mem Project' } });
  assert.equal(create.status, 201);
  const projectId = create.body.project.id;

  // Empty initially.
  const empty = await invokeApp(app, { path: `/api/projects/${projectId}/memory` });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.memory, []);

  // Seed via the app's OWN wired memoryService (test seam app.services).
  // There is no external write API in PR1, so this is the supported path to
  // place rows behind the GET endpoint without a second db connection.
  const svc = app.services.memoryService;
  svc.createMemoryItem({ projectId, kind: 'convention', content: 'use tabs', origin: 'human', importance: 7 });
  svc.createMemoryItem({ projectId, kind: 'pitfall', content: 'never double runTurn', origin: 'human', importance: 9 });

  const res = await invokeApp(app, { path: `/api/projects/${projectId}/memory` });
  assert.equal(res.status, 200);
  assert.equal(res.body.memory.length, 2);
  // importance DESC
  assert.equal(res.body.memory[0].content, 'never double runTurn');
  assert.ok(res.body.memory.every((m) => m.project_id === projectId));
});

// ---------------------------------------------------------------------------
// CRITICAL REGRESSION — system-prompt invariance w.r.t. memory state.
//
// The deep invariant: the PM system prompt depends only on
// (project brief, skill packs, pm_run_id, layer) — NEVER on memory_items /
// revision / ledger. We prove this by exercising the REAL assembly paths
// (NOT re-implemented helpers) and capturing the ACTUAL systemPrompt that
// the adapter receives via startSession:
//   * fresh-spawn  : operatorSpawnService.ensureLiveOperator()  (services/operatorSpawnService.js)
//   * boot-resume  : the resume block in createManagerRouter()
//                    (routes/manager.js:184-204), run at router construction.
// If either real path ever baked memory rows into the system prompt, the
// captured string would contain a `## Learned Memory` block and/or the
// seeded memory content, and these tests would fail.
// ---------------------------------------------------------------------------

const { createManagerRouter } = require('../routes/manager');

// Per-run varying tokens (run id, project id) are normalized so two spawns
// that differ ONLY in memory state can be compared byte-for-byte.
function normalizeVolatile(prompt, { runId, projectId }) {
  let out = prompt;
  if (runId) out = out.split(runId).join('<RUN_ID>');
  if (projectId) out = out.split(projectId).join('<PROJECT_ID>');
  return out;
}

// Drive the REAL fresh-spawn path and return the actual systemPrompt the
// adapter was handed. memoryFixture(memoryService, projectId) seeds memory
// (or not) BEFORE the spawn so we can prove the spawn ignores it.
function realFreshSpawnSystemPrompt(t, db, { projectName, conventions, knownPitfalls, seedMemory }) {
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService: rs });
  const memoryService = createMemoryService(db);
  const fakePm = makeFakeCodexAdapter();
  const topAdapter = makeFakeCodexAdapter();

  const project = projectService.createProject({ name: projectName, directory: '/tmp/fixedcwd' });
  projectBriefService.updateBrief(project.id, { conventions, known_pitfalls: knownPitfalls });
  if (seedMemory) seedMemory(memoryService, project.id);

  const spawn = createOperatorSpawnService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm),
    projectService, projectBriefService,
    authResolverOpts: { hasKeychain: true },
  });
  seedTop({ rs, registry, adapter: topAdapter });

  const { run } = spawn.ensureLiveOperator({ projectId: project.id });
  const captured = fakePm._sessions.get(run.id).systemPrompt;
  return { systemPrompt: captured, runId: run.id, projectId: project.id, memoryService };
}

// Drive the REAL boot-resume path (createManagerRouter constructor) and
// return the actual systemPrompt handed to the adapter on resume.
function realBootResumeSystemPrompt(t, db, { projectName, conventions, knownPitfalls, seedMemory }) {
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService: rs });
  const memoryService = createMemoryService(db);
  const fakePm = makeFakeCodexAdapter();
  const topAdapter = makeFakeCodexAdapter();

  const project = projectService.createProject({ name: projectName, directory: '/tmp/fixedcwd' });
  projectBriefService.updateBrief(project.id, { conventions, known_pitfalls: knownPitfalls });
  // A persisted PM thread is the precondition for resume.
  projectBriefService.setPmThread(project.id, { pm_thread_id: 'thread_resume_fixed', pm_adapter: 'codex' });
  if (seedMemory) seedMemory(memoryService, project.id);

  // Active Top is required for PM resume (parent-notice routing).
  seedTop({ rs, registry, adapter: topAdapter });

  // Create the stale PM run that boot-resume will pick up.
  const pmRun = rs.createRun({
    is_manager: true, manager_layer: 'operator', manager_adapter: 'codex',
    conversation_id: `operator:${project.id}`, prompt: `PM ${projectName}`,
  });
  rs.updateRunStatus(pmRun.id, 'running', { force: true });

  // Constructing the router runs the REAL resume block synchronously.
  createManagerRouter({
    runService: rs,
    managerAdapterFactory: wireFactory(fakePm),
    managerRegistry: registry,
    projectService,
    projectBriefService,
    authResolverOpts: { hasKeychain: true },
  });

  const session = fakePm._sessions.get(pmRun.id);
  assert.ok(session, 'boot-resume actually started the PM session (resume path executed)');
  return { systemPrompt: session.systemPrompt, runId: pmRun.id, projectId: project.id, memoryService };
}

const SEED_THREE = (memoryService, projectId) => {
  memoryService.createMemoryItem({ projectId, kind: 'convention', content: 'always use tabs in go files', origin: 'human' });
  memoryService.createMemoryItem({ projectId, kind: 'pitfall', content: 'never call runTurn twice on codex', origin: 'human' });
  memoryService.createMemoryItem({ projectId, kind: 'heuristic', content: 'prefer small focused PRs', origin: 'human' });
};

test('REGRESSION: REAL fresh-spawn PM system prompt is INVARIANT w.r.t. memory state', async (t) => {
  // Two identical projects (same brief), differing ONLY in memory state.
  const dbEmpty = await mkdb(t);
  const empty = realFreshSpawnSystemPrompt(t, dbEmpty, {
    projectName: 'alpha', conventions: 'tabs only', knownPitfalls: 'no double runTurn',
  });

  const dbSeeded = await mkdb(t);
  const seeded = realFreshSpawnSystemPrompt(t, dbSeeded, {
    projectName: 'alpha', conventions: 'tabs only', knownPitfalls: 'no double runTurn',
    seedMemory: SEED_THREE,
  });
  assert.equal(seeded.memoryService.getRevision(seeded.projectId), 3, 'memory state really changed in the seeded case');

  // The captured prompt must carry the brief (proves we captured the real thing)...
  assert.match(empty.systemPrompt, /## Project Scope/);
  assert.match(empty.systemPrompt, /no double runTurn/);
  // ...but NEVER a memory content block, and none of the seeded memory content.
  assert.doesNotMatch(seeded.systemPrompt, /## Learned Memory/, 'real fresh-spawn must NOT bake a memory block');
  assert.doesNotMatch(seeded.systemPrompt, /never call runTurn twice on codex/, 'no memory row content in system prompt');
  assert.doesNotMatch(seeded.systemPrompt, /prefer small focused PRs/);

  // And the two real prompts are byte-identical after normalizing the only
  // legitimately-varying tokens (run id + project id). => output depends on
  // brief, NOT on memory.
  const a = normalizeVolatile(empty.systemPrompt, empty);
  const b = normalizeVolatile(seeded.systemPrompt, seeded);
  assert.equal(b, a, 'memory state must not change the real fresh-spawn PM system prompt');
});

test('REGRESSION: REAL boot-resume PM system prompt is INVARIANT w.r.t. memory state', async (t) => {
  const dbEmpty = await mkdb(t);
  const empty = realBootResumeSystemPrompt(t, dbEmpty, {
    projectName: 'beta', conventions: 'spaces', knownPitfalls: 'watch races',
  });

  const dbSeeded = await mkdb(t);
  const seeded = realBootResumeSystemPrompt(t, dbSeeded, {
    projectName: 'beta', conventions: 'spaces', knownPitfalls: 'watch races',
    seedMemory: SEED_THREE,
  });
  assert.equal(seeded.memoryService.getRevision(seeded.projectId), 3, 'memory state really changed in the seeded case');

  assert.match(empty.systemPrompt, /## Project Scope/);
  assert.match(empty.systemPrompt, /watch races/);
  assert.doesNotMatch(seeded.systemPrompt, /## Learned Memory/, 'real boot-resume must NOT bake a memory block');
  assert.doesNotMatch(seeded.systemPrompt, /never call runTurn twice on codex/, 'no memory row content in resumed system prompt');

  const a = normalizeVolatile(empty.systemPrompt, empty);
  const b = normalizeVolatile(seeded.systemPrompt, seeded);
  assert.equal(b, a, 'memory state must not change the real boot-resume PM system prompt');
});

test('REGRESSION: REAL fresh-spawn and boot-resume produce the SAME PM prompt for identical inputs', async (t) => {
  // Same brief + same memory (none) -> the two real assembly paths must agree
  // (the brief-bake is duplicated across operatorSpawnService and routes/manager.js;
  // this pins them together so they cannot drift, with or without the Part D line).
  const db1 = await mkdb(t);
  const fresh = realFreshSpawnSystemPrompt(t, db1, {
    projectName: 'gamma', conventions: 'c-line', knownPitfalls: 'p-line',
  });
  const db2 = await mkdb(t);
  const resume = realBootResumeSystemPrompt(t, db2, {
    projectName: 'gamma', conventions: 'c-line', knownPitfalls: 'p-line',
  });
  const a = normalizeVolatile(fresh.systemPrompt, fresh);
  const b = normalizeVolatile(resume.systemPrompt, resume);
  assert.equal(b, a, 'fresh-spawn and boot-resume real assemblies must be identical');
  // Both real PM prompts carry the Part D pointer line.
  assert.match(fresh.systemPrompt, /학습된 프로젝트 메모리/);
  assert.match(resume.systemPrompt, /학습된 프로젝트 메모리/);
});

test('Part D: fixed Learned Memory pointer line present in PM base, ABSENT from top base, content-free', (t) => {
  const adapter = makeFakeCodexAdapter();
  const pmBase = buildManagerSystemPrompt({ adapter, port: 4177, token: null, layer: 'operator', adapterType: 'codex' });
  const topBase = buildManagerSystemPrompt({ adapter, port: 4177, token: null, layer: 'top', adapterType: 'codex' });

  // The fixed informational line landed in pm.
  assert.match(pmBase, /Learned Memory/, 'pm base mentions Learned Memory');
  assert.match(pmBase, /\/api\/projects\/<projectId>\/memory/, 'pm base points at the GET endpoint');
  // Top layer must NOT carry the line.
  assert.doesNotMatch(topBase, /Learned Memory/, 'top base must not mention Learned Memory');

  // Content-free: the line carries no per-turn memory data — only the static
  // base URL placeholder. It must not contain any markdown memory block.
  assert.doesNotMatch(pmBase, /## Learned Memory/, 'pm base must not contain an actual memory block (caching safety)');
});

// ---------------------------------------------------------------------------
// INTEGRATION — runTurn payload carries the memory block, gated by the ledger.
// ---------------------------------------------------------------------------

function wirePmStack(db, { memoryMultiOwner = false } = {}) {
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService: rs });
  const memoryService = createMemoryService(db);
  const masterMemoryService = createMasterMemoryService(db);
  const compositionLedger = createCompositionLedger(db);
  const memoryComposer = createMemoryComposer({
    retrievers: {
      workspace: buildWorkspaceAdapter(memoryService),
      user: buildUserAdapter(masterMemoryService),
    },
  });
  const fakePm = makeFakeCodexAdapter();
  const topAdapter = makeFakeCodexAdapter();
  const eventBus = createEventBus();

  const spawn = createOperatorSpawnService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm),
    projectService, projectBriefService,
    authResolverOpts: { hasKeychain: true },
  });
  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm),
    lifecycleService: { sendAgentInput: () => true },
    operatorSpawnService: spawn,
    projectService, // A2b-2: enables the ## Turn Codebase block (name/directory)
    projectBriefService, // A2b-2: brief summary in the block
    memoryService,
    masterMemoryService,
    memoryMultiOwner,
    memoryComposer,
    compositionLedger,
    eventBus,
  });
  return {
    rs, projectService, projectBriefService, registry,
    memoryService, masterMemoryService, compositionLedger,
    fakePm, topAdapter, eventBus, spawn, conv,
  };
}

  test('INTEGRATION: PM user payload contains ## Learned Memory on first send, NOT on second (composition ledger), again after revision bump', async (t) => {
  const db = await mkdb(t);
  const stack = wirePmStack(db);
  const { rs, projectService, registry, memoryService, fakePm, topAdapter, conv } = stack;

  const project = projectService.createProject({ name: 'alpha' });
  seedTop({ rs, registry, adapter: topAdapter });

  // Seed project memory BEFORE the first PM turn.
  memoryService.createMemoryItem({ projectId: project.id, kind: 'pitfall', content: 'never call runTurn twice on codex', origin: 'human', importance: 8 });
  memoryService.createMemoryItem({ projectId: project.id, kind: 'convention', content: 'use tabs in go', origin: 'human', importance: 5 });

  // First send -> lazy spawn + inject.
  conv.sendMessage(`operator:${project.id}`, { text: 'please work on the codex resume bug' });
  assert.equal(fakePm._runTurnCalls.length, 1, 'one runTurn so far');
  const first = fakePm._runTurnCalls[0].payload.text;
  assert.match(first, /## Learned Memory/, 'first send injects the Learned Memory block');
  assert.match(first, /runTurn twice/, 'block carries the retrieved memory content');
  // Original user text survives, memory is the OUTERMOST prepend.
  assert.match(first, /please work on the codex resume bug/);
  assert.ok(
    first.indexOf('## Learned Memory') < first.indexOf('please work on the codex resume bug'),
    'memory block precedes the original user text'
  );

  // Second send (same session, same revision) -> ledger suppresses re-inject.
  conv.sendMessage(`operator:${project.id}`, { text: 'any update?' });
  assert.equal(fakePm._runTurnCalls.length, 2);
  const second = fakePm._runTurnCalls[1].payload.text;
  assert.doesNotMatch(second, /## Learned Memory/, 'second send within the same revision does NOT re-inject');
  assert.match(second, /any update\?/);

  // New active memory bumps the revision -> next send injects again. The
  // send text overlaps the new memory so FTS narrowing surfaces it (a
  // non-matching context would correctly retrieve nothing — narrowing is
  // by design, exercised separately in the unit suite).
  memoryService.createMemoryItem({ projectId: project.id, kind: 'heuristic', content: 'split big diffs into small commits', origin: 'human' });
  conv.sendMessage(`operator:${project.id}`, { text: 'how should I split big diffs?' });
  assert.equal(fakePm._runTurnCalls.length, 3);
  const third = fakePm._runTurnCalls[2].payload.text;
  assert.match(third, /## Learned Memory/, 're-injects after a revision change');
  assert.match(third, /split big diffs/, 'retrieved the newly-added memory');
});

  test('INTEGRATION: Top slot is NEVER L1 memory-injected; composition ledger untouched for top', async (t) => {
  const db = await mkdb(t);
  const stack = wirePmStack(db);
  const { rs, projectService, registry, memoryService, topAdapter, conv } = stack;

  // Make 'top' a real, sendable slot backed by the topAdapter.
  const topRun = seedTop({ rs, registry, adapter: topAdapter });
  // Seed memory for a project — but top has no projectId, so injection is N/A.
  const project = projectService.createProject({ name: 'alpha' });
  memoryService.createMemoryItem({ projectId: project.id, kind: 'convention', content: 'top must not see this', origin: 'human' });

  conv.sendMessage('top', { text: 'status please' });
  assert.equal(topAdapter._runTurnCalls.length, 1);
  const payload = topAdapter._runTurnCalls[0].payload.text;
  assert.doesNotMatch(payload, /## Learned Memory/, 'top slot never gets a memory block');
  assert.match(payload, /status please/);
    // No L1 composition row should have been written for the top run.
    const topCompositions = db.prepare(
      "SELECT COUNT(*) AS c FROM memory_composition_events WHERE run_id = ? AND slot_kind = 'top'"
    ).get(topRun.id).c;
    assert.equal(topCompositions, 0, 'top run has no L1 composition ledger entry');
  });

  test('INTEGRATION: a failed send does NOT record the composition ledger (re-injects next time)', async (t) => {
  const db = await mkdb(t);
  const stack = wirePmStack(db);
  const { rs, projectService, registry, memoryService, fakePm, topAdapter, spawn, conv } = stack;

  const project = projectService.createProject({ name: 'alpha' });
  seedTop({ rs, registry, adapter: topAdapter });
  memoryService.createMemoryItem({ projectId: project.id, kind: 'pitfall', content: 'do not regress the parser', origin: 'human' });

  // Spawn the PM, then force the adapter to reject the next turn WITHOUT
  // killing the session (so the slot is not cleared/respawned).
  const { run } = spawn.ensureLiveOperator({ projectId: project.id });
  const session = fakePm._sessions.get(run.id);
  session.rejectNext = true; // runTurn returns { accepted: false } -> 502

  // Use a context that overlaps the memory so retrieve would yield a block.
  assert.throws(() => conv.sendMessage(`operator:${project.id}`, { text: 'fix the parser regress' }), /Failed to deliver/);
    // Ledger must be empty because the send failed before the commit half.
    const beforeCount = db.prepare(
      "SELECT COUNT(*) AS c FROM memory_composition_events WHERE run_id = ? AND slot_kind = 'operator'"
    ).get(run.id).c;
    assert.equal(beforeCount, 0, 'no composition ledger write on failed send');

  // Resend -> injection happens now (rejectNext was consumed).
  conv.sendMessage(`operator:${project.id}`, { text: 'fix the parser regress' });
  const calls = fakePm._runTurnCalls;
    const last = calls[calls.length - 1].payload.text;
    assert.match(last, /## Learned Memory/, 're-injects after the earlier failed send');
    const afterCount = db.prepare(
      "SELECT COUNT(*) AS c FROM memory_composition_events WHERE run_id = ? AND slot_kind = 'operator' AND status = 'accepted'"
    ).get(run.id).c;
    assert.equal(afterCount, 1, 'composition ledger recorded after a successful send');
  });

test('INTEGRATION: memoryService failure degrades to no-injection (message still delivered)', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService: rs });
  const fakePm = makeFakeCodexAdapter();
  const topAdapter = makeFakeCodexAdapter();

    // A memoryService whose revision read throws must NOT break delivery.
    const explodingMemory = {
      getRevision() { throw new Error('boom'); },
    };

  const spawn = createOperatorSpawnService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm),
    projectService, projectBriefService,
    authResolverOpts: { hasKeychain: true },
  });
  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm),
    lifecycleService: { sendAgentInput: () => true },
    operatorSpawnService: spawn,
    memoryService: explodingMemory,
  });

  const project = projectService.createProject({ name: 'alpha' });
  seedTop({ rs, registry, adapter: topAdapter });

  const res = conv.sendMessage(`operator:${project.id}`, { text: 'hello' });
  assert.equal(res.status, 'sent');
  assert.equal(fakePm._runTurnCalls.length, 1, 'message delivered despite memory failure');
  assert.doesNotMatch(fakePm._runTurnCalls[0].payload.text, /## Learned Memory/, 'no block when memory failed');
  assert.match(fakePm._runTurnCalls[0].payload.text, /hello/);
});

test('W-P6b: primaryless operator turn injects User memory only and records only injected owners', async (t) => {
  const db = await mkdb(t);
  const stack = wirePmStack(db);
  const {
    rs, projectService, registry, memoryService, masterMemoryService, fakePm, conv,
  } = stack;

  const referenceProject = projectService.createProject({ name: 'reference-only' });
  db.prepare("INSERT INTO operator_profiles (id, name, is_private) VALUES ('op_priv_oi_generic', 'Private: oi_generic', 1)").run();
  db.prepare("INSERT INTO operator_instances (id, profile_id) VALUES ('oi_generic', 'op_priv_oi_generic')").run();
  db.prepare(`
    INSERT INTO operator_codebase_refs (instance_id, project_id, role)
    VALUES ('oi_generic', ?, 'reference')
  `).run(referenceProject.id);

  memoryService.createMemoryItem({
    projectId: referenceProject.id,
    kind: 'convention',
    content: 'reference raw workspace must not leak into a generic turn',
    origin: 'human',
  });
  masterMemoryService.createMemoryItem({
    scope: 'user',
    kind: 'constraint',
    content: 'generic turns include user memory only',
    origin: 'human',
  });

  const run = rs.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: 'operator:oi_generic',
    operator_instance_id: 'oi_generic',
    manager_adapter: 'codex',
    prompt: 'generic operator',
  });
  rs.updateRunStatus(run.id, 'running', { force: true });
  fakePm.startSession(run.id, { systemPrompt: 'pm', cwd: process.cwd() });
  registry.setActive('operator:oi_generic', run.id, fakePm);

  conv.sendMessage('operator:oi_generic', { text: 'generic guidance?' });

  assert.equal(fakePm._runTurnCalls.length, 1);
  const payload = fakePm._runTurnCalls[0].payload.text;
  assert.match(payload, /## User Memory/, 'primaryless turn still injects User memory');
  assert.match(payload, /generic turns include user memory only/);
  assert.doesNotMatch(payload, /## Learned Memory/, 'primaryless generic turn must not inject workspace memory');
  assert.doesNotMatch(payload, /reference raw workspace must not leak/);

  const owners = db.prepare(`
    SELECT os.owner_type, os.owner_id, COALESCE(os.provenance_key, '') AS provenance_key
    FROM memory_composition_owner_state os
    JOIN memory_composition_events e ON e.id = os.composition_id
    WHERE e.run_id = ? AND e.slot_kind = 'operator' AND e.status = 'accepted'
    ORDER BY os.rowid
  `).all(run.id);
  assert.deepEqual(owners, [
    { owner_type: 'user', owner_id: 'user', provenance_key: 'user' },
  ]);
});

// --- A2b-2: per-turn ## Turn Codebase block ---------------------------------

test('A2b-2: a turn directed at a NON-primary codebase gets a ## Turn Codebase block', async (t) => {
  const db = await mkdb(t);
  const stack = wirePmStack(db);
  const { rs, projectService, registry, topAdapter, fakePm, conv } = stack;

  const primary = projectService.createProject({ name: 'alpha', directory: '/tmp/alpha' });
  const other = projectService.createProject({ name: 'beta', directory: '/tmp/beta' });
  seedTop({ rs, registry, adapter: topAdapter });

  conv.sendMessage(`operator:${primary.id}`, {
    text: 'work on the shared beta repo',
    codebaseProjectId: other.id,
    turnMode: 'codebase',
  });
  const txt = fakePm._runTurnCalls[0].payload.text;
  assert.match(txt, /## Turn Codebase/);
  assert.match(txt, /beta \(id: /);
  assert.match(txt, /directory: \/tmp\/beta/);
  assert.match(txt, /work on the shared beta repo/);
  // block precedes the original user text
  assert.ok(txt.indexOf('## Turn Codebase') < txt.indexOf('work on the shared beta repo'));
});

test('A2b-2: a turn on the Operator primary (or omitted) gets NO ## Turn Codebase block', async (t) => {
  const db = await mkdb(t);
  const stack = wirePmStack(db);
  const { rs, projectService, registry, topAdapter, fakePm, conv } = stack;

  const primary = projectService.createProject({ name: 'alpha', directory: '/tmp/alpha' });
  seedTop({ rs, registry, adapter: topAdapter });

  // Explicit primary → redundant (already in system prompt), no block.
  conv.sendMessage(`operator:${primary.id}`, { text: 'do the thing', codebaseProjectId: primary.id, turnMode: 'codebase' });
  assert.ok(!/## Turn Codebase/.test(fakePm._runTurnCalls[0].payload.text));

  // Omitted → legacy default, no block.
  conv.sendMessage(`operator:${primary.id}`, { text: 'again' });
  assert.ok(!/## Turn Codebase/.test(fakePm._runTurnCalls[1].payload.text));
});

test('A2b-2: turnMode generic never emits a ## Turn Codebase block (codebase-less)', async (t) => {
  const db = await mkdb(t);
  const stack = wirePmStack(db);
  const { rs, projectService, registry, topAdapter, fakePm, conv } = stack;

  const primary = projectService.createProject({ name: 'alpha', directory: '/tmp/alpha' });
  const other = projectService.createProject({ name: 'beta', directory: '/tmp/beta' });
  seedTop({ rs, registry, adapter: topAdapter });

  // generic + an explicit codebase → generic wins (codebase-less), no block.
  conv.sendMessage(`operator:${primary.id}`, {
    text: 'general planning question',
    codebaseProjectId: other.id,
    turnMode: 'generic',
  });
  assert.ok(!/## Turn Codebase/.test(fakePm._runTurnCalls[0].payload.text));
});

test('A2b-2: a non-existent turn codebase is rejected fail-closed (400)', async (t) => {
  const db = await mkdb(t);
  const stack = wirePmStack(db);
  const { rs, projectService, registry, topAdapter, conv } = stack;

  const primary = projectService.createProject({ name: 'alpha', directory: '/tmp/alpha' });
  seedTop({ rs, registry, adapter: topAdapter });

  assert.throws(() => conv.sendMessage(`operator:${primary.id}`, {
    text: 'work on ghost',
    codebaseProjectId: 'proj_does_not_exist',
    turnMode: 'codebase',
  }), (err) => err && err.httpStatus === 400 && /turn codebase not found/.test(err.message));
});

test('A2b-3a: explicit non-ref codebase injects workspace memory and emits observation without creating a ref', async (t) => {
  const db = await mkdb(t);
  const stack = wirePmStack(db);
  const {
    rs, projectService, registry, memoryService,
    topAdapter, fakePm, eventBus, conv,
  } = stack;

  const primary = projectService.createProject({ name: 'alpha', directory: '/tmp/alpha' });
  const other = projectService.createProject({ name: 'beta', directory: '/tmp/beta' });
  memoryService.createMemoryItem({
    projectId: other.id,
    kind: 'convention',
    content: 'beta workspace uses cobalt fixtures',
    origin: 'human',
    importance: 9,
  });
  seedTop({ rs, registry, adapter: topAdapter });

  const observed = [];
  const unsubscribe = eventBus.subscribe((event) => {
    if (event.channel === 'memory:unwatched_codebase') observed.push(event);
  });
  t.after(unsubscribe);

  conv.sendMessage(`operator:${primary.id}`, {
    text: 'use the beta cobalt fixtures',
    codebaseProjectId: other.id,
    turnMode: 'codebase',
  });

  const call = fakePm._runTurnCalls[0];
  assert.match(call.payload.text, /## Learned Memory/);
  assert.match(call.payload.text, /beta workspace uses cobalt fixtures/);
  const run = rs.getRun(call.runId);
  assert.ok(run.operator_instance_id, 'spawned Operator has an instance id');
  assert.equal(rs.operatorInstanceHasRef(run.operator_instance_id, other.id), false, 'send does not auto-create a ref');
  assert.equal(observed.length, 1);
  assert.deepEqual(observed[0].data, {
    runId: run.id,
    instanceId: run.operator_instance_id,
    projectId: other.id,
  });

  conv.sendMessage(`operator:${primary.id}`, { text: 'primary follow-up' });
  assert.equal(observed.length, 1, 'primary turn does not emit unwatched observation');
});

test('A2b-2: the ## Turn Codebase block carries a truncated brief summary', async (t) => {
  const db = await mkdb(t);
  const stack = wirePmStack(db);
  const { rs, projectService, projectBriefService, registry, topAdapter, fakePm, conv } = stack;

  const primary = projectService.createProject({ name: 'alpha', directory: '/tmp/alpha' });
  const other = projectService.createProject({ name: 'beta', directory: '/tmp/beta' });
  projectBriefService.ensureBrief(other.id);
  projectBriefService.updateBrief(other.id, { conventions: 'use spaces in beta', known_pitfalls: 'beta flaky net test' });
  seedTop({ rs, registry, adapter: topAdapter });

  conv.sendMessage(`operator:${primary.id}`, {
    text: 'work beta', codebaseProjectId: other.id, turnMode: 'codebase',
  });
  const txt = fakePm._runTurnCalls[0].payload.text;
  assert.match(txt, /## Turn Codebase/);
  assert.match(txt, /conventions: use spaces in beta/);
  assert.match(txt, /pitfalls: beta flaky net test/);
});
