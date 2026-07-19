// v3 Phase 3a — operatorSpawnService (lazy PM spawn) + operatorCleanupService
// (single-owner teardown). These tests inject a fake adapter factory so
// no real Codex subprocess is spawned — the service contracts are
// verified end-to-end on the in-memory registry + SQLite.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Readable, Writable } = require('node:stream');
const express = require('express');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createTaskService } = require('../services/taskService');
const { createAgentProfileService } = require('../services/agentProfileService');
const { createProjectService } = require('../services/projectService');
const { createProjectBriefService } = require('../services/projectBriefService');
const { createManagerRegistry } = require('../services/managerRegistry');
const { createConversationService } = require('../services/conversationService');
const { createLifecycleService } = require('../services/lifecycleService');
const { createEventBus } = require('../services/eventBus');
const { createOperatorSpawnService } = require('../services/operatorSpawnService');
const { createOperatorCleanupService } = require('../services/operatorCleanupService');
const { createNodeService } = require('../services/nodeService');
const { createTasksRouter } = require('../routes/tasks');
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

function operatorThreadRow(runService, projectId) {
  return runService.getOperatorThreadForProject(projectId, { ensure: true });
}

function operatorThreadId(runService, projectId) {
  return operatorThreadRow(runService, projectId)?.thread_id || null;
}

function stubExecEngine() {
  return {
    type: 'subprocess',
    spawnAgent(runId) { return { sessionName: `session-${runId}` }; },
    isAlive() { return true; },
    detectExitCode() { return null; },
    getOutput() { return ''; },
    sendInput() { return true; },
    kill() { return true; },
    discoverGhostSessions() { return []; },
    hasProcess() { return false; },
  };
}

function stubStreamJsonEngine() {
  return {
    spawnAgent() { return { sessionName: null }; },
    hasProcess() { return false; },
    isAlive() { return true; },
    detectExitCode() { return null; },
    sendInput() { return true; },
    kill() { return true; },
  };
}

function seedWorkerProfile(db, id = `worker_${Math.random().toString(36).slice(2)}`) {
  db.prepare(`
    INSERT INTO agent_profiles (id, name, type, command, args_template, capabilities_json, env_allowlist, max_concurrent)
    VALUES (?, 'Worker', 'codex', 'codex', '{prompt}', '{}', '[]', 0)
  `).run(id);
  return id;
}

function createExecuteRouteApp({ taskService, lifecycleService }) {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', createTasksRouter({ taskService, lifecycleService }));
  return app;
}

function httpJson(app, method, url, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = new Readable({
      read() {
        if (payload) this.push(payload);
        this.push(null);
      },
    });
    req.method = method;
    req.url = url;
    req.headers = {
      host: '127.0.0.1',
      ...(payload ? {
        'content-type': 'application/json',
        'content-length': String(payload.length),
      } : {}),
    };

    const chunks = [];
    const res = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    res.statusCode = 200;
    res.headers = {};
    res.setHeader = (name, value) => { res.headers[String(name).toLowerCase()] = value; };
    res.getHeader = (name) => res.headers[String(name).toLowerCase()];
    res.removeHeader = (name) => { delete res.headers[String(name).toLowerCase()]; };
    res.writeHead = (statusCode, headers = {}) => {
      res.statusCode = statusCode;
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
      return res;
    };
    res.end = (chunk, encoding, callback) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      const text = Buffer.concat(chunks).toString('utf8');
      let parsed = {};
      if (text) {
        try { parsed = JSON.parse(text); } catch { parsed = text; }
      }
      if (typeof callback === 'function') callback();
      resolve({ status: res.statusCode, body: parsed, text });
      return res;
    };

    try {
      if (typeof app.handle === 'function') app.handle(req, res);
      else app.emit('request', req, res);
    } catch (err) {
      reject(err);
    }
  });
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
// operatorSpawnService — lazy spawn
// ---------------------------------------------------------------------------

test('Phase 3a: lazy spawn creates a PM run when none exists', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService: rs });
  const fakePm = makeFakeCodexAdapter();
  const topAdapter = makeFakeCodexAdapter();

  const spawn = createOperatorSpawnService({
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
  const result1 = spawn.ensureLiveOperator({ projectId: project.id });
  assert.equal(result1.spawned, true);
  assert.equal(result1.resumed, false);
  assert.equal(result1.run.manager_layer, 'operator'); // Phase 2: flipped from 'pm'
  assert.equal(result1.run.conversation_id, `operator:oi_${project.id}`); // W-P5: canonical slot is instance-form
  assert.equal(result1.run.operator_instance_id, `oi_${project.id}`);
  assert.equal(result1.run.is_manager, 1);
  assert.ok(result1.run.parent_run_id, 'parent_run_id should be set to active Top');

  // Registry now has one PM slot; legacy project input resolves to it.
  assert.equal(registry.getActiveRunId(`operator:${project.id}`), result1.run.id);
  assert.equal(registry.getActiveRunId(`operator:oi_${project.id}`), result1.run.id);

  // Phase 3a R1 fix: the brief is injected into the SYSTEM prompt, not
  // via a seed runTurn. No adapter.runTurn should fire before the user's
  // own first message lands.
  assert.equal(fakePm._runTurnCalls.length, 0, 'no seed runTurn in spawn path (R1 fix)');

  // The system prompt stored in the adapter session must contain the
  // project section so subsequent turns get cached brief context.
  const sessionState = fakePm._sessions.get(result1.run.id);
  assert.match(sessionState.systemPrompt, /Project Scope/);
  assert.match(sessionState.systemPrompt, /PM Role/);
  // A2b: the fresh-spawn prompt uses the shared favorite-pool PM Role — names a
  // primary but no longer hard-locks the Operator to a single project.
  assert.match(sessionState.systemPrompt, /shared codebase pool/i);
  assert.ok(!/Stay within this project's scope/.test(sessionState.systemPrompt));

  // Thread id has NOT been captured yet because no turn has run. It will
  // appear when the first user message triggers runTurn (tested below in
  // the conversationService integration test).
  const briefAfter = projectBriefService.getBrief(project.id);
  assert.equal(briefAfter.pm_thread_id, null, 'thread id only persists after first real turn');

  // Second call: already live → fast path, no new run
  const result2 = spawn.ensureLiveOperator({ projectId: project.id });
  assert.equal(result2.spawned, false);
  assert.equal(result2.run.id, result1.run.id);
});

test('P2-1: fresh PM spawn leaves run in queued until first turn emits thread.started', async (t) => {
  // Regression guard for the P2-1 fix: operatorSpawnService used to call
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

  const spawn = createOperatorSpawnService({
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
    operatorSpawnService: spawn,
  });
  const project = projectService.createProject({ name: 'alpha' });
  seedTop({ rs, registry, adapter: topAdapter });

  // Fresh spawn — no resumeThreadId, no runTurn yet.
  const result = spawn.ensureLiveOperator({ projectId: project.id });
  assert.equal(result.spawned, true);
  assert.equal(result.resumed, false);

  // Pre-P2-1 behavior: run.status would already be 'running'. Post-fix:
  // still 'queued' because thread.started has not fired.
  const runBefore = rs.getRun(result.run.id);
  assert.equal(runBefore.status, 'queued', 'PM run must stay queued until first turn');

  // Trigger the first real user turn via conversationService. The fake
  // adapter's runTurn synthesizes thread.started on first call, which
  // invokes onThreadStarted → markRunStarted.
  conv.sendMessage(`operator:${project.id}`, { text: 'hello' });

  const runAfter = rs.getRun(result.run.id);
  assert.equal(runAfter.status, 'running', 'PM run flips to running after first turn / thread.started');
  // started_at should now be populated (markRunStarted path).
  assert.ok(runAfter.started_at, 'started_at populated by markRunStarted');
});

test('P2-1: resumed PM spawn is marked running synchronously inside startSession', async (t) => {
  // For the resume path the fake adapter fires onThreadStarted
  // synchronously inside startSession, so ensureLiveOperator should return a
  // run that is already 'running' — no pre-turn 'queued' window is
  // possible because the adapter semantically already has a live thread
  // as soon as resume is wired up.
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService: rs });
  const fakePm = makeFakeCodexAdapter();

  const spawn = createOperatorSpawnService({
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

  const result = spawn.ensureLiveOperator({ projectId: project.id });
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

  const spawn = createOperatorSpawnService({
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

  const result = spawn.ensureLiveOperator({ projectId: project.id });
  assert.equal(result.resumed, true);
  // The adapter state has threadId pre-seeded via resumeThreadId
  const sessionState = fakePm._sessions.get(result.run.id);
  assert.equal(sessionState.threadId, 'thread_persisted');
  // Brief should NOT have been overwritten (same id)
  const brief = projectBriefService.getBrief(project.id);
  assert.equal(brief.pm_thread_id, 'thread_persisted');
  assert.equal(operatorThreadId(rs, project.id), 'thread_persisted', 'legacy bridge resume is copied to operator instance');
});

test('W-P3 R1: empty instance row (NULL thread) still falls back to legacy bridge thread', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService: rs });
  const fakePm = makeFakeCodexAdapter();
  const spawn = createOperatorSpawnService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm),
    projectService,
    projectBriefService,
    authResolverOpts: { hasKeychain: true },
  });
  const project = projectService.createProject({ name: 'staged' });
  seedTop({ rs, registry, adapter: fakePm });

  // Staged-upgrade shape (Codex W-P3 R1 BLOCKER): the instance ROW exists
  // (W-P1 backfill / ensure) but its thread is NULL — the thread only ever
  // landed in project_briefs. Fallback must key on missing thread STATE.
  projectBriefService.ensureBrief(project.id);
  projectBriefService.setPmThread(project.id, {
    pm_thread_id: 'thread_bridge_after_wp1',
    pm_adapter: 'codex',
  });
  rs.ensurePrimaryOperatorInstanceForProject(project.id);

  const result = spawn.ensureLiveOperator({ projectId: project.id });
  assert.equal(result.resumed, true, 'bridge thread must resume when instance row has NULL thread');
  assert.equal(fakePm._sessions.get(result.run.id).threadId, 'thread_bridge_after_wp1');
});

test('W-P3: operator_instances thread state wins over legacy project_briefs bridge', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService: rs });
  const fakePm = makeFakeCodexAdapter();

  const spawn = createOperatorSpawnService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm),
    projectService,
    projectBriefService,
    authResolverOpts: { hasKeychain: true },
  });

  const project = projectService.createProject({ name: 'alpha' });
  seedTop({ rs, registry, adapter: fakePm });

  projectBriefService.ensureBrief(project.id);
  projectBriefService.setPmThread(project.id, {
    pm_thread_id: 'thread_bridge',
    pm_adapter: 'codex',
  });
  const resolved = rs.ensurePrimaryOperatorInstanceForProject(project.id);
  rs.setOperatorInstanceThread(resolved.instanceId, {
    pm_thread_id: 'thread_instance',
    pm_adapter: 'codex',
  });

  const result = spawn.ensureLiveOperator({ projectId: project.id });
  assert.equal(result.resumed, true);
  assert.equal(fakePm._sessions.get(result.run.id).threadId, 'thread_instance');
  assert.equal(projectBriefService.getBrief(project.id).pm_thread_id, 'thread_bridge', 'legacy bridge is read-only');
});

test('W-P3: /execute derives operator attribution from pm_run_id server-side', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const taskService = createTaskService(db, null);
  const agentProfileService = createAgentProfileService(db);
  const profileId = seedWorkerProfile(db);
  const lifecycleService = createLifecycleService({
    runService: rs,
    taskService,
    agentProfileService,
    projectService,
    executionEngine: stubExecEngine(),
    streamJsonEngine: stubStreamJsonEngine(),
    worktreeService: null,
    harvestService: null,
    eventBus: null,
  });
  const app = createExecuteRouteApp({ taskService, lifecycleService });

  const project = projectService.createProject({ name: 'alpha' });
  const referenceProject = projectService.createProject({ name: 'shared-ref' });
  const otherProject = projectService.createProject({ name: 'beta' });
  const resolved = rs.ensurePrimaryOperatorInstanceForProject(project.id);
  db.prepare(`
    INSERT INTO operator_codebase_refs (instance_id, project_id, role)
    VALUES (?, ?, 'reference')
  `).run(resolved.instanceId, referenceProject.id);
  rs.ensurePrimaryOperatorInstanceForProject(otherProject.id);
  const pmRun = rs.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: `operator:${project.id}`,
    prompt: 'operator alpha',
  });
  const otherPmRun = rs.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: `operator:${otherProject.id}`,
    prompt: 'operator beta',
  });

  const attributedTask = taskService.createTask({ project_id: project.id, title: 'attributed' });
  const attributed = await httpJson(app, 'POST', `/api/tasks/${attributedTask.id}/execute`, {
    agent_profile_id: profileId,
    prompt: 'work',
    pm_run_id: pmRun.id,
  });
  assert.equal(attributed.status, 201);
  assert.equal(attributed.body.run.operator_instance_id, resolved.instanceId);
  assert.equal(attributed.body.run.parent_run_id, pmRun.id);

  const referenceTask = taskService.createTask({ project_id: referenceProject.id, title: 'reference' });
  const referenceAttributed = await httpJson(app, 'POST', `/api/tasks/${referenceTask.id}/execute`, {
    agent_profile_id: profileId,
    prompt: 'work',
    pm_run_id: pmRun.id,
  });
  assert.equal(referenceAttributed.status, 201);
  assert.equal(referenceAttributed.body.run.operator_instance_id, resolved.instanceId);
  assert.equal(referenceAttributed.body.run.parent_run_id, pmRun.id);

  const missingTask = taskService.createTask({ project_id: project.id, title: 'missing' });
  const missing = await httpJson(app, 'POST', `/api/tasks/${missingTask.id}/execute`, {
    agent_profile_id: profileId,
    prompt: 'work',
  });
  assert.equal(missing.status, 201);
  assert.equal(missing.body.run.operator_instance_id, null);
  assert.equal(missing.body.run.parent_run_id, null);

  const mismatchedTask = taskService.createTask({ project_id: project.id, title: 'mismatched' });
  const mismatched = await httpJson(app, 'POST', `/api/tasks/${mismatchedTask.id}/execute`, {
    agent_profile_id: profileId,
    prompt: 'work',
    pm_run_id: otherPmRun.id,
  });
  assert.equal(mismatched.status, 201);
  // Favorite model (codebase-pool-memory-axes-brief §4 LOCKED): dispatching to a
  // codebase the Operator holds NO ref to no longer drops attribution — the
  // Operator KEEPS operator_instance_id + parent_run_id (so auto-review returns
  // to it, not the target's primary). Only the observation event is emitted.
  assert.equal(mismatched.body.run.operator_instance_id, `oi_${otherProject.id}`);
  assert.equal(mismatched.body.run.parent_run_id, otherPmRun.id);
  const unwatchedEvents = rs.getRunEvents(mismatched.body.run.id)
    .filter((event) => event.event_type === 'dispatch:unwatched_codebase');
  assert.equal(unwatchedEvents.length, 1);
  assert.deepEqual(JSON.parse(unwatchedEvents[0].payload_json), {
    pm_run_id: otherPmRun.id,
    operator_instance_id: `oi_${otherProject.id}`,
    task_id: mismatchedTask.id,
    project_id: project.id,
    reason: 'operator_instance_ref_missing',
  });
});

test('W-P3/A1c: /execute drops attribution for terminal or slot-stale pm_run', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const taskService = createTaskService(db, null);
  const agentProfileService = createAgentProfileService(db);
  const profileId = seedWorkerProfile(db);
  const { createManagerRegistry } = require('../services/managerRegistry');
  const registry = createManagerRegistry({ runService: rs });
  const lifecycleService = createLifecycleService({
    runService: rs,
    taskService,
    agentProfileService,
    projectService,
    managerRegistry: registry,
    executionEngine: stubExecEngine(),
    streamJsonEngine: stubStreamJsonEngine(),
    worktreeService: null,
    harvestService: null,
    eventBus: null,
  });
  const app = createExecuteRouteApp({ taskService, lifecycleService });

  const project = projectService.createProject({ name: 'alpha' });
  const inst = rs.ensurePrimaryOperatorInstanceForProject(project.id);
  const slot = inst.instanceConversationId;
  const adapter = { disposeSession() {}, isSessionAlive() { return true; } };

  // (a) a COMPLETED pm_run (non-active) lends no attribution.
  const terminalPm = rs.createRun({ is_manager: true, manager_layer: 'operator', conversation_id: slot });
  rs.updateRunStatus(terminalPm.id, 'completed', { force: true });
  const t1 = taskService.createTask({ project_id: project.id, title: 'a' });
  const r1 = await httpJson(app, 'POST', `/api/tasks/${t1.id}/execute`, {
    agent_profile_id: profileId, prompt: 'work', pm_run_id: terminalPm.id,
  });
  assert.equal(r1.status, 201);
  assert.equal(r1.body.run.operator_instance_id, null);
  assert.equal(r1.body.run.parent_run_id, null);

  // (b) a still-'running' pm_run that a newer PM has replaced in the slot →
  //     registry mismatch drops the stale attribution.
  const oldPm = rs.createRun({ is_manager: true, manager_layer: 'operator', conversation_id: slot });
  rs.updateRunStatus(oldPm.id, 'running', { force: true });
  const newPm = rs.createRun({ is_manager: true, manager_layer: 'operator', conversation_id: slot });
  rs.updateRunStatus(newPm.id, 'running', { force: true });
  registry.setActive(slot, newPm.id, adapter);
  const t2 = taskService.createTask({ project_id: project.id, title: 'b' });
  const r2 = await httpJson(app, 'POST', `/api/tasks/${t2.id}/execute`, {
    agent_profile_id: profileId, prompt: 'work', pm_run_id: oldPm.id,
  });
  assert.equal(r2.status, 201);
  assert.equal(r2.body.run.operator_instance_id, null);
  assert.equal(r2.body.run.parent_run_id, null);

  // (c) the CURRENT slot occupant attributes normally.
  const t3 = taskService.createTask({ project_id: project.id, title: 'c' });
  const r3 = await httpJson(app, 'POST', `/api/tasks/${t3.id}/execute`, {
    agent_profile_id: profileId, prompt: 'work', pm_run_id: newPm.id,
  });
  assert.equal(r3.status, 201);
  assert.equal(r3.body.run.operator_instance_id, inst.instanceId);
  assert.equal(r3.body.run.parent_run_id, newPm.id);
});

test('W-P3: retry run copies operator lineage and sets retry root', async (t) => {
  const db = await mkdb(t);
  const eventBus = createEventBus();
  const rs = createRunService(db, eventBus);
  const projectService = createProjectService(db);
  const taskService = createTaskService(db, null);
  const agentProfileService = createAgentProfileService(db);
  const profileId = seedWorkerProfile(db);
  const lifecycleService = createLifecycleService({
    runService: rs,
    taskService,
    agentProfileService,
    projectService,
    executionEngine: stubExecEngine(),
    streamJsonEngine: stubStreamJsonEngine(),
    worktreeService: null,
    harvestService: null,
    eventBus,
  });
  t.after(() => lifecycleService.stopMonitoring());

  const project = projectService.createProject({ name: 'alpha' });
  const task = taskService.createTask({ project_id: project.id, title: 'retry me' });
  const resolved = rs.ensurePrimaryOperatorInstanceForProject(project.id);
  const pmRun = rs.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: `operator:${project.id}`,
    prompt: 'operator alpha',
  });
  const original = rs.createRun({
    task_id: task.id,
    agent_profile_id: profileId,
    prompt: 'original',
    operator_instance_id: resolved.instanceId,
    parent_run_id: pmRun.id,
    queued_args: { skillPackIds: null, presetId: null },
  });
  rs.markRunStarted(original.id, { tmux_session: `session-${original.id}` });

  lifecycleService.startMonitoring();
  rs.updateRunStatus(original.id, 'failed', { force: true });

  const runs = rs.listRuns({ task_id: task.id });
  assert.equal(runs.length, 2);
  const retry = runs.find((run) => run.id !== original.id);
  assert.equal(retry.operator_instance_id, resolved.instanceId);
  assert.equal(retry.parent_run_id, pmRun.id);
  assert.equal(retry.retry_root_run_id, original.id);
  assert.equal(retry.retry_count, 1);
});

test('Phase 3a: lazy spawn refuses when no active Top', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService: rs });
  const fakePm = makeFakeCodexAdapter();
  const spawn = createOperatorSpawnService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm),
    projectService,
    projectBriefService,
    authResolverOpts: { hasKeychain: true },
  });
  const project = projectService.createProject({ name: 'alpha' });
  assert.throws(
    () => spawn.ensureLiveOperator({ projectId: project.id }),
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
  const spawn = createOperatorSpawnService({
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
    () => spawn.ensureLiveOperator({ projectId: project.id }),
    /PM is disabled/
  );
});

test('N3-1: lazy operator spawn refuses a cordoned remote node', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const nodeService = createNodeService(db, { createRemoteExecutor: () => ({}) });
  const registry = createManagerRegistry({ runService: rs });
  const fakePm = makeFakeCodexAdapter();
  const topAdapter = makeFakeCodexAdapter();

  nodeService.createNode({
    id: 'cordoned-pod',
    name: 'Cordoned Pod',
    kind: 'ssh',
    ssh_host: 'worker.local',
    ssh_user: 'ubuntu',
    exposed_roots: ['/srv/workspaces'],
    reachable: true,
    cordoned: true,
  });
  const project = projectService.createProject({ name: 'alpha', node_id: 'cordoned-pod' });
  const top = seedTop({ rs, registry, adapter: topAdapter });

  const spawn = createOperatorSpawnService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm),
    projectService,
    projectBriefService,
    nodeService,
    authResolverOpts: { hasKeychain: true },
  });

  assert.throws(
    () => spawn.ensureLiveOperator({ projectId: project.id }),
    (err) => err.httpStatus === 409 && /node is cordoned/.test(err.message),
  );
  assert.equal(fakePm._sessions.size, 0, 'adapter startSession should not run');
  assert.equal(registry.getActiveRunId(`operator:${project.id}`), null);

  const event = rs.getRunEvents(top.id).find((row) => row.event_type === 'operator:spawn_blocked_cordoned');
  assert.ok(event, 'cordon block event is recorded on the active Top run');
  assert.deepEqual(JSON.parse(event.payload_json), { node_id: 'cordoned-pod', project_id: project.id });
});

test('N3-1: already-live operator on a cordoned node is left alone', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const nodeService = createNodeService(db, { createRemoteExecutor: () => ({}) });
  const registry = createManagerRegistry({ runService: rs });
  const fakePm = makeFakeCodexAdapter();
  const topAdapter = makeFakeCodexAdapter();

  nodeService.createNode({
    id: 'cordoned-pod',
    name: 'Cordoned Pod',
    kind: 'ssh',
    ssh_host: 'worker.local',
    ssh_user: 'ubuntu',
    exposed_roots: ['/srv/workspaces'],
    reachable: true,
    cordoned: true,
  });
  const project = projectService.createProject({ name: 'alpha', node_id: 'cordoned-pod' });
  seedTop({ rs, registry, adapter: topAdapter });
  const live = rs.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: `operator:${project.id}`,
    manager_adapter: 'codex',
    prompt: 'PM alpha',
    node_id: 'cordoned-pod',
  });
  rs.updateRunStatus(live.id, 'running', { force: true });
  fakePm._sessions.set(live.id, { threadId: 'thread_live', ended: false });
  registry.setActive(`operator:${project.id}`, live.id, fakePm);

  const spawn = createOperatorSpawnService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm),
    projectService,
    projectBriefService,
    nodeService,
    authResolverOpts: { hasKeychain: true },
  });

  const result = spawn.ensureLiveOperator({ projectId: project.id });
  assert.equal(result.spawned, false);
  assert.equal(result.run.id, live.id);
  assert.equal(rs.getRun(live.id).status, 'running');
});

test('Phase 3a: conversationService integrates lazy PM spawn on first message', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService: rs });
  const fakePm = makeFakeCodexAdapter();
  const topAdapter = makeFakeCodexAdapter();

  const spawn = createOperatorSpawnService({
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
    operatorSpawnService: spawn,
  });

  const project = projectService.createProject({ name: 'alpha' });
  seedTop({ rs, registry, adapter: topAdapter });

  // First call: no PM → conversationService should lazy-spawn and deliver
  const sendResult = conv.sendMessage(`operator:${project.id}`, { text: '시작' });
  assert.equal(sendResult.status, 'sent');
  assert.equal(sendResult.target.kind, 'pm');

  // Phase 3a R1 fix: exactly ONE runTurn — the user's own first message.
  // No seed turn was made by operatorSpawnService.
  assert.equal(fakePm._runTurnCalls.length, 1, 'exactly one runTurn = the user message');
  assert.match(fakePm._runTurnCalls[0].payload.text, /시작/);

  // After the user's message, the fake adapter's mocked thread.started
  // handler should have fired and persisted the id into the operator instance.
  const thread = operatorThreadRow(rs, project.id);
  assert.ok(thread.thread_id, 'thread id persisted after first real turn');
  assert.equal(thread.pm_adapter, 'codex');
  assert.equal(projectBriefService.getBrief(project.id).pm_thread_id, null, 'project_briefs is not written');

  // Second call: PM already live → direct delivery (no re-spawn)
  conv.sendMessage(`operator:${project.id}`, { text: '두번째' });
  assert.equal(fakePm._runTurnCalls.length, 2);
});

test('Phase 3a: R1 fix — no back-to-back runTurn race on cold PM spawn', async (t) => {
  // Regression: the original implementation called runTurn inside
  // operatorSpawnService as a "seed" turn, then conversationService called
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
  const spawn = createOperatorSpawnService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: wireFactory(strictPm),
    projectService, projectBriefService,
    authResolverOpts: { hasKeychain: true },
  });
  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: wireFactory(strictPm),
    lifecycleService: { sendAgentInput: () => true },
    operatorSpawnService: spawn,
  });

  const project = projectService.createProject({ name: 'alpha' });
  seedTop({ rs, registry, adapter: strictPm });

  // If the seed-runTurn race existed, this would throw.
  const result = conv.sendMessage(`operator:${project.id}`, { text: 'cold start' });
  assert.equal(result.status, 'sent');
  assert.equal(strictPm.calls.length, 1, 'exactly one runTurn — the user message');
});

// ---------------------------------------------------------------------------
// operatorCleanupService
// ---------------------------------------------------------------------------

test('Phase 3a: operatorCleanupService.reset disposes live PM and clears brief', async (t) => {
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

  const spawn = createOperatorSpawnService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm),
    projectService,
    projectBriefService,
    authResolverOpts: { hasKeychain: true },
  });
  const cleanup = createOperatorCleanupService({
    projectService,
    projectBriefService,
    managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm),
    runService: rs,
  });

  const project = projectService.createProject({ name: 'alpha' });
  seedTop({ rs, registry, adapter: topAdapter });
  const spawnResult = spawn.ensureLiveOperator({ projectId: project.id });
  const pmRunId = spawnResult.run.id;

  // The thread id only materializes on the first real turn (R1 fix —
  // no seed runTurn inside operatorSpawnService). Trigger it via conv.
  conv.sendMessage(`operator:${project.id}`, { text: 'first' });

  // Pre-reset: slot is live, operator instance has thread id
  assert.ok(registry.getActiveRunId(`operator:${project.id}`));
  assert.ok(operatorThreadId(rs, project.id));

  const result = cleanup.reset(project.id);
  assert.equal(result.disposed, true);
  assert.equal(result.clearedBrief, true);
  assert.equal(result.cancelledRunId, pmRunId);

  // Post-reset: slot cleared, instance thread id null, adapter disposeSession called
  assert.equal(registry.getActiveRunId(`operator:${project.id}`), null);
  assert.equal(operatorThreadId(rs, project.id), null);
  assert.equal(projectBriefService.getBrief(project.id).pm_thread_id, null, 'project_briefs remains unchanged');
  assert.ok(fakePm._disposeCalls.includes(pmRunId));

  // Run row is marked cancelled
  const run = rs.getRun(pmRunId);
  assert.equal(run.status, 'cancelled');
});

test('Phase 3a: operatorCleanupService.reset is idempotent when no PM is live', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService: rs });
  const fakePm = makeFakeCodexAdapter();
  const cleanup = createOperatorCleanupService({
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

  const spawn = createOperatorSpawnService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm),
    projectService, projectBriefService,
    authResolverOpts: { hasKeychain: true },
  });
  const cleanup = createOperatorCleanupService({
    projectService, projectBriefService, managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm), runService: rs,
  });

  const project = projectService.createProject({ name: 'alpha' });
  seedTop({ rs, registry, adapter: topAdapter });

  // First spawn + first turn → thread id persisted (R1 fix: no seed turn,
  // thread id only appears after the first real runTurn).
  const first = spawn.ensureLiveOperator({ projectId: project.id });
  conv.sendMessage(`operator:${project.id}`, { text: 'first message' });
  const firstThreadId = operatorThreadId(rs, project.id);
  assert.ok(firstThreadId);

  // Reset
  cleanup.reset(project.id);

  // Second spawn + turn — should be a new run with a new thread id
  const second = spawn.ensureLiveOperator({ projectId: project.id });
  assert.notEqual(second.run.id, first.run.id);
  assert.equal(second.resumed, false, 'second spawn is a fresh thread, not a resume');
  conv.sendMessage(`operator:${project.id}`, { text: 'after reset' });
  const secondThreadId = operatorThreadId(rs, project.id);
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
  const createRes = await httpJson(app, 'POST', '/api/projects', { name: 'alpha' });
  assert.equal(createRes.status, 201);
  const projectId = createRes.body.project.id;

  const res = await httpJson(app, 'POST', `/api/manager/pm/${projectId}/reset`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'reset');
  assert.equal(res.body.disposed, false);
});

test('Phase 3a: DELETE /api/projects/:id runs operatorCleanupService.dispose before deleting', async (t) => {
  // Can't fully exercise without a real Codex, but we can verify the
  // route doesn't crash and the project is deleted.
  const app = await createTestApp(t);
  const createRes = await httpJson(app, 'POST', '/api/projects', { name: 'alpha' });
  const projectId = createRes.body.project.id;

  const delRes = await httpJson(app, 'DELETE', `/api/projects/${projectId}`);
  assert.equal(delRes.status, 200);

  const getRes = await httpJson(app, 'GET', `/api/projects/${projectId}`);
  assert.equal(getRes.status, 404);
});

test('Phase 3a: R2 fix — operatorCleanupService.reset rethrows disposeSession failures and leaves state intact', async (t) => {
  // Regression for codex R2: _terminate used to swallow disposeSession
  // errors, mark the run cancelled, clear the registry, and clear the
  // brief — returning success to the caller. That made both /reset and
  // DELETE /api/projects/:id silently drop in-memory PM state even when
  // the adapter hadn't actually torn down. Now a dispose failure must:
  //   (a) throw with httpStatus 502
  //   (b) leave managerRegistry slot intact (so retry can address it)
  //   (c) leave persisted operator thread state intact
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
  const spawn = createOperatorSpawnService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: wireFactory(flakyDispose),
    projectService, projectBriefService,
    authResolverOpts: { hasKeychain: true },
  });
  const cleanup = createOperatorCleanupService({
    projectService, projectBriefService, managerRegistry: registry,
    managerAdapterFactory: wireFactory(flakyDispose), runService: rs,
  });

  const project = projectService.createProject({ name: 'alpha' });
  seedTop({ rs, registry, adapter: flakyDispose });
  spawn.ensureLiveOperator({ projectId: project.id });
  conv.sendMessage(`operator:${project.id}`, { text: 'first' });
  const pmRunIdBefore = registry.getActiveRunId(`operator:${project.id}`);
  const threadIdBefore = operatorThreadId(rs, project.id);
  assert.ok(pmRunIdBefore);
  assert.ok(threadIdBefore);
  const statusBefore = rs.getRun(pmRunIdBefore).status;

  // Reset must throw, and no state must have changed.
  assert.throws(() => cleanup.reset(project.id), /disposeSession failed/);
  assert.equal(registry.getActiveRunId(`operator:${project.id}`), pmRunIdBefore, 'registry slot must remain');
  assert.equal(operatorThreadId(rs, project.id), threadIdBefore, 'operator instance thread must remain');
  assert.equal(rs.getRun(pmRunIdBefore).status, statusBefore, 'run status must remain (not cancelled)');

  // Restore and retry — reset now succeeds end-to-end.
  flakyDispose.disposeSession = realDispose;
  const result = cleanup.reset(project.id);
  assert.equal(result.disposed, true);
  assert.equal(registry.getActiveRunId(`operator:${project.id}`), null);
});

test('Phase 3a: R1 fix — DELETE /api/projects/:id refuses on operatorCleanupService failure', async (t) => {
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
    operatorCleanupService: failingCleanup,
  }));
  const res = await httpJson(app, 'DELETE', '/api/projects/p1');
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'pm_dispose_failed');
  assert.match(res.body.message, /adapter exploded/);
});

// ---------------------------------------------------------------------------
// operatorCleanupService.forceReset (v3 Phase 7 P7-2)
// ---------------------------------------------------------------------------

test('P7-2: forceReset succeeds even when disposeSession throws', async (t) => {
  // Core contract: force mode swallows dispose failures and always clears
  // the registry slot + brief so the PM is never permanently locked.
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService: rs });
  const fakePm = makeFakeCodexAdapter();
  const topAdapter = makeFakeCodexAdapter();

  // Make disposeSession fail
  fakePm.disposeSession = () => { throw new Error('adapter stuck'); };

  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm),
    lifecycleService: { sendAgentInput: () => true },
  });
  const spawn = createOperatorSpawnService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm),
    projectService, projectBriefService,
    authResolverOpts: { hasKeychain: true },
  });

  // Capture eventBus emissions
  const emitted = [];
  const fakeEventBus = { emit: (channel, data) => emitted.push({ channel, data }) };

  const cleanup = createOperatorCleanupService({
    projectService, projectBriefService, managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm), runService: rs,
    eventBus: fakeEventBus,
  });

  const project = projectService.createProject({ name: 'alpha' });
  seedTop({ rs, registry, adapter: topAdapter });
  spawn.ensureLiveOperator({ projectId: project.id });
  conv.sendMessage(`operator:${project.id}`, { text: 'hello' });

  const pmRunId = registry.getActiveRunId(`operator:${project.id}`);
  assert.ok(pmRunId, 'PM run is live before forceReset');
  assert.ok(operatorThreadId(rs, project.id), 'operator instance has thread id');

  // Normal reset must fail-closed (throws)
  assert.throws(() => cleanup.reset(project.id), /disposeSession failed/);

  // forceReset must succeed despite the broken dispose
  const result = cleanup.forceReset(project.id);

  // disposed=false because disposeSession threw, but everything else is cleaned up
  assert.equal(result.disposed, false, 'disposed=false when disposeSession threw');
  assert.equal(result.clearedBrief, true, 'operator thread was cleared regardless');
  assert.ok(result.cancelledRunId, 'cancelledRunId captured');
  assert.ok(result.disposeError, 'disposeError records the failure reason');

  // Registry slot must be gone
  assert.equal(registry.getActiveRunId(`operator:${project.id}`), null, 'registry slot cleared');

  // Operator instance thread must be cleared; project_briefs is not a write target.
  assert.equal(operatorThreadId(rs, project.id), null, 'operator instance thread cleared');
  assert.equal(projectBriefService.getBrief(project.id).pm_thread_id, null, 'project_briefs remains unchanged');

  // Run must be marked failed
  const run = rs.getRun(pmRunId);
  assert.equal(run.status, 'failed', 'run marked failed even when dispose threw');

  // Audit event must have been emitted on the canonical operator channel only
  // (Phase 4: legacy pm:force_reset dual-emit removed).
  assert.equal(emitted.length, 1, 'single eventBus emission');
  assert.ok(!emitted.some(e => e.channel === 'pm:force_reset'), 'legacy pm force-reset event NOT emitted');
  const operatorEvent = emitted.find(e => e.channel === 'operator:force_reset');
  assert.ok(operatorEvent, 'canonical operator force-reset event emitted');
  assert.equal(operatorEvent.data.projectId, project.id);
  assert.equal(operatorEvent.data.disposed, false);
  assert.ok(operatorEvent.data.disposeError, 'disposeError in event payload');
});

test('P7-2: forceReset succeeds cleanly when disposeSession works', async (t) => {
  // When the adapter is healthy, forceReset should report disposed=true and
  // emit the audit event just like the failure path.
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
  const spawn = createOperatorSpawnService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm),
    projectService, projectBriefService,
    authResolverOpts: { hasKeychain: true },
  });

  const emitted = [];
  const fakeEventBus = { emit: (channel, data) => emitted.push({ channel, data }) };

  const cleanup = createOperatorCleanupService({
    projectService, projectBriefService, managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm), runService: rs,
    eventBus: fakeEventBus,
  });

  const project = projectService.createProject({ name: 'beta' });
  seedTop({ rs, registry, adapter: topAdapter });
  spawn.ensureLiveOperator({ projectId: project.id });
  conv.sendMessage(`operator:${project.id}`, { text: 'hello' });

  const pmRunId = registry.getActiveRunId(`operator:${project.id}`);

  const result = cleanup.forceReset(project.id);

  assert.equal(result.disposed, true, 'disposed=true when disposeSession succeeded');
  assert.equal(result.clearedBrief, true);
  assert.equal(result.cancelledRunId, pmRunId);
  assert.equal(result.disposeError, null, 'no disposeError when dispose succeeded');

  assert.equal(registry.getActiveRunId(`operator:${project.id}`), null);
  assert.equal(operatorThreadId(rs, project.id), null);
  assert.equal(projectBriefService.getBrief(project.id).pm_thread_id, null);

  assert.equal(emitted.length, 1);
  assert.ok(!emitted.some(e => e.channel === 'pm:force_reset'));
  const operatorEvent = emitted.find(e => e.channel === 'operator:force_reset');
  assert.ok(operatorEvent);
  assert.equal(operatorEvent.data.disposed, true);
  assert.equal(operatorEvent.data.disposeError, null);
});

test('P7-2: forceReset is idempotent when no PM is live', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService: rs });
  const fakePm = makeFakeCodexAdapter();
  const emitted = [];
  const fakeEventBus = { emit: (channel, data) => emitted.push({ channel, data }) };

  const cleanup = createOperatorCleanupService({
    projectService, projectBriefService, managerRegistry: registry,
    managerAdapterFactory: wireFactory(fakePm), runService: rs,
    eventBus: fakeEventBus,
  });

  const project = projectService.createProject({ name: 'gamma' });
  const result = cleanup.forceReset(project.id);

  assert.equal(result.disposed, false);
  assert.equal(result.clearedBrief, false);
  assert.equal(result.cancelledRunId, null);
  assert.equal(result.disposeError, null);

  // Audit event still fired so the operator knows the call happened
  // (Phase 4: single operator: emission only).
  assert.equal(emitted.length, 1);
  assert.ok(!emitted.some(e => e.channel === 'pm:force_reset'));
  assert.ok(emitted.some(e => e.channel === 'operator:force_reset'));
});

test('P7-2: normal reset behavior is unchanged (fail-closed still applies)', async (t) => {
  // Regression guard: ensure forceReset existence does not affect normal reset.
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService: rs });
  const fakePm = makeFakeCodexAdapter();
  const topAdapter = makeFakeCodexAdapter();
  const broken = makeFakeCodexAdapter();
  broken.disposeSession = () => { throw new Error('still broken'); };

  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: wireFactory(broken),
    lifecycleService: { sendAgentInput: () => true },
  });
  const spawn = createOperatorSpawnService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: wireFactory(broken),
    projectService, projectBriefService,
    authResolverOpts: { hasKeychain: true },
  });
  const cleanup = createOperatorCleanupService({
    projectService, projectBriefService, managerRegistry: registry,
    managerAdapterFactory: wireFactory(broken), runService: rs,
  });

  const project = projectService.createProject({ name: 'delta' });
  seedTop({ rs, registry, adapter: topAdapter });
  spawn.ensureLiveOperator({ projectId: project.id });
  conv.sendMessage(`operator:${project.id}`, { text: 'hi' });

  const pmRunId = registry.getActiveRunId(`operator:${project.id}`);
  const threadId = operatorThreadId(rs, project.id);

  // reset() must still throw (fail-closed unchanged)
  assert.throws(() => cleanup.reset(project.id), /disposeSession failed/);

  // State must remain intact after failed reset
  assert.equal(registry.getActiveRunId(`operator:${project.id}`), pmRunId, 'slot intact after failed reset');
  assert.equal(operatorThreadId(rs, project.id), threadId, 'operator instance thread intact after failed reset');
});

test('P7-2: POST /api/manager/pm/:projectId/force-reset HTTP wiring', async (t) => {
  const app = await createTestApp(t);
  const createRes = await httpJson(app, 'POST', '/api/projects', { name: 'force-test' });
  assert.equal(createRes.status, 201);
  const projectId = createRes.body.project.id;

  // With no PM live, force-reset should still return 200 with correct shape
  const res = await httpJson(app, 'POST', `/api/manager/pm/${projectId}/force-reset`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'force_reset');
  assert.equal(res.body.projectId, projectId);
  assert.equal(res.body.disposed, false);
  assert.equal(res.body.clearedBrief, false);
  assert.equal(res.body.disposeError, null);
});

test('Phase 3a: PM system prompt uses layer=operator variant', () => {
  const { buildManagerSystemPrompt } = require('../services/managerSystemPrompt');
  const fakeAdapter = {
    buildGuardrailsSection: () => '## Adapter Guardrails\nTest.',
  };
  const topPrompt = buildManagerSystemPrompt({ adapter: fakeAdapter, port: 4177, layer: 'top' });
  const pmPrompt = buildManagerSystemPrompt({ adapter: fakeAdapter, port: 4177, layer: 'operator' });
  assert.match(topPrompt, /top-level dispatcher/);
  assert.match(pmPrompt, /project-scoped dispatcher/);
  // PM gets worker intervention APIs (input/cancel), Top does not
  assert.match(pmPrompt, /Send input to run/);
  assert.doesNotMatch(topPrompt, /Send input to run/);
});
