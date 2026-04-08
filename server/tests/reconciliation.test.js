// v3 Phase 4 — annotate-only reconciliation tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createTaskService } = require('../services/taskService');
const { createProjectService } = require('../services/projectService');
const { createAgentProfileService } = require('../services/agentProfileService');
const { createReconciliationService } = require('../services/reconciliationService');
const { createApp } = require('../app');

async function mkdb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-reconcile-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return db;
}

function seedCore(db) {
  const projectService = createProjectService(db);
  const taskService = createTaskService(db, null);
  const runService = createRunService(db, null);
  const project = projectService.createProject({ name: 'alpha' });
  // agent profile needed for worker runs
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command) VALUES ('a1','A','codex','codex')`).run();
  return { projectService, taskService, runService, project };
}

test('Phase 4: migration 010 creates dispatch_audit_log', async (t) => {
  const db = await mkdb(t);
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='dispatch_audit_log'`).get();
  assert.ok(row);
});

test('Phase 4: coherent task_complete claim is recorded with flag=0', async (t) => {
  const db = await mkdb(t);
  const { projectService, taskService, runService, project } = seedCore(db);
  const svc = createReconciliationService({ db, runService, taskService });

  const task = taskService.createTask({ title: 'T', project_id: project.id });
  taskService.updateTaskStatus(task.id, 'done');

  const row = svc.recordClaim({
    projectId: project.id,
    taskId: task.id,
    pmClaim: { kind: 'task_complete', task_id: task.id },
  });
  assert.equal(row.incoherence_flag, 0);
  assert.equal(row.incoherence_kind, null);
  const truth = JSON.parse(row.db_truth);
  assert.equal(truth.status, 'done');
});

test('Phase 4: incoherent task_complete claim is flagged pm_hallucination', async (t) => {
  const db = await mkdb(t);
  const { taskService, runService, project } = seedCore(db);
  const svc = createReconciliationService({ db, runService, taskService });

  const task = taskService.createTask({ title: 'T', project_id: project.id });
  // Leave task in backlog — PM says it's done → hallucination.

  const row = svc.recordClaim({
    projectId: project.id,
    taskId: task.id,
    pmClaim: { kind: 'task_complete', task_id: task.id },
  });
  assert.equal(row.incoherence_flag, 1);
  assert.equal(row.incoherence_kind, 'pm_hallucination');
});

test('Phase 4: worker_running claim vs actual run status', async (t) => {
  const db = await mkdb(t);
  const { taskService, runService, project } = seedCore(db);
  const svc = createReconciliationService({ db, runService, taskService });

  const task = taskService.createTask({ title: 'T', project_id: project.id });
  const run = runService.createRun({ task_id: task.id, agent_profile_id: 'a1', prompt: 'w' });
  runService.updateRunStatus(run.id, 'running', { force: true });

  // Coherent
  const row1 = svc.recordClaim({
    projectId: project.id,
    pmClaim: { kind: 'worker_running', run_id: run.id },
  });
  assert.equal(row1.incoherence_flag, 0);

  // PM says worker_completed but run is still running → hallucination
  const row2 = svc.recordClaim({
    projectId: project.id,
    pmClaim: { kind: 'worker_completed', run_id: run.id },
  });
  assert.equal(row2.incoherence_flag, 1);
  assert.equal(row2.incoherence_kind, 'pm_hallucination');
});

test('Phase 4: missing task_id / run_id on claim flags invalid_claim', async (t) => {
  const db = await mkdb(t);
  const { taskService, runService, project } = seedCore(db);
  const svc = createReconciliationService({ db, runService, taskService });

  const row = svc.recordClaim({
    projectId: project.id,
    pmClaim: { kind: 'task_complete' },
  });
  assert.equal(row.incoherence_flag, 1);
  assert.equal(row.incoherence_kind, 'invalid_claim');
});

test('Phase 4: unknown claim kinds are recorded without flagging', async (t) => {
  const db = await mkdb(t);
  const { taskService, runService, project } = seedCore(db);
  const svc = createReconciliationService({ db, runService, taskService });

  const row = svc.recordClaim({
    projectId: project.id,
    pmClaim: { kind: 'something_new', detail: 'x' },
  });
  assert.equal(row.incoherence_flag, 0);
  assert.equal(row.incoherence_kind, 'unknown_kind');
});

// Helper: seed a real PM run for staleness tests. Must exist + be in
// the pm layer + have conversation_id='pm:<projectId>' to pass R4 binding.
function seedPmRun(rs, projectId) {
  const pm = rs.createRun({
    is_manager: true,
    manager_layer: 'pm',
    conversation_id: `pm:${projectId}`,
    manager_adapter: 'codex',
    prompt: `pm ${projectId}`,
  });
  rs.updateRunStatus(pm.id, 'running', { force: true });
  return pm;
}

test('Phase 4: user_intervention_stale is detected when parent notices are queued', async (t) => {
  const db = await mkdb(t);
  const { projectService, taskService, runService, project } = seedCore(db);
  const pm = seedPmRun(runService, project.id);
  // Fake conversationService whose peekParentNotices reports one queued
  // notice for the pmRunId. reconciliationService must flag the otherwise
  // coherent claim as user_intervention_stale.
  const stubConv = {
    peekParentNotices: (runId) => runId === pm.id ? ['queued notice'] : [],
  };
  const svc = createReconciliationService({
    db, runService, taskService, projectService,
    conversationService: stubConv,
  });

  const task = taskService.createTask({ title: 'T', project_id: project.id });
  taskService.updateTaskStatus(task.id, 'done');

  const row = svc.recordClaim({
    projectId: project.id,
    pmRunId: pm.id,
    pmClaim: { kind: 'task_complete', task_id: task.id },
  });
  assert.equal(row.incoherence_flag, 1);
  assert.equal(row.incoherence_kind, 'user_intervention_stale');
});

test('Phase 4: pm_hallucination takes precedence over user_intervention_stale', async (t) => {
  const db = await mkdb(t);
  const { projectService, taskService, runService, project } = seedCore(db);
  const pm = seedPmRun(runService, project.id);
  const stubConv = {
    peekParentNotices: () => ['queued notice'],
  };
  const svc = createReconciliationService({
    db, runService, taskService, projectService, conversationService: stubConv,
  });
  const task = taskService.createTask({ title: 'T', project_id: project.id });
  // Task NOT done — primary check wins even though staleness is also true.

  const row = svc.recordClaim({
    projectId: project.id,
    pmRunId: pm.id,
    pmClaim: { kind: 'task_complete', task_id: task.id },
  });
  assert.equal(row.incoherence_flag, 1);
  assert.equal(row.incoherence_kind, 'pm_hallucination',
    'pm_hallucination is more informative than user_intervention_stale when both fire');
});

test('Phase 4: R4 fix — pmRunId envelope binding rejects foreign/top/nonexistent ids', async (t) => {
  const db = await mkdb(t);
  const { projectService, taskService, runService, project } = seedCore(db);
  const svc = createReconciliationService({
    db, runService, taskService, projectService,
  });

  // (a) nonexistent id
  assert.throws(() => svc.recordClaim({
    projectId: project.id,
    pmRunId: 'run_does_not_exist',
    pmClaim: { kind: 'task_complete', task_id: 'whatever' },
  }), /pm_run_id not found/);

  // (b) a Top run (layer='top') is not acceptable
  const top = runService.createRun({ is_manager: true, prompt: 'top' });
  runService.updateRunStatus(top.id, 'running', { force: true });
  assert.throws(() => svc.recordClaim({
    projectId: project.id,
    pmRunId: top.id,
    pmClaim: { kind: 'task_complete', task_id: 'whatever' },
  }), /expected 'pm'/);

  // (c) a PM run from a DIFFERENT project is not acceptable
  const otherProject = projectService.createProject({ name: 'beta' });
  const otherPm = seedPmRun(runService, otherProject.id);
  assert.throws(() => svc.recordClaim({
    projectId: project.id,
    pmRunId: otherPm.id,
    pmClaim: { kind: 'task_complete', task_id: 'whatever' },
  }), /belongs to pm:.+, not pm:/);

  // (d) a worker run (not a manager) is not acceptable
  const task = taskService.createTask({ title: 'T', project_id: project.id });
  const worker = runService.createRun({ task_id: task.id, agent_profile_id: 'a1' });
  assert.throws(() => svc.recordClaim({
    projectId: project.id,
    pmRunId: worker.id,
    pmClaim: { kind: 'task_complete', task_id: task.id },
  }), /is not a manager run/);
});

test('Phase 4: listClaims filters by project and incoherent_only', async (t) => {
  const db = await mkdb(t);
  const { taskService, runService, project } = seedCore(db);
  const svc = createReconciliationService({ db, runService, taskService });

  const doneTask = taskService.createTask({ title: 'D', project_id: project.id });
  taskService.updateTaskStatus(doneTask.id, 'done');
  const stuckTask = taskService.createTask({ title: 'S', project_id: project.id });

  svc.recordClaim({ projectId: project.id, pmClaim: { kind: 'task_complete', task_id: doneTask.id } });
  svc.recordClaim({ projectId: project.id, pmClaim: { kind: 'task_complete', task_id: stuckTask.id } });
  svc.recordClaim({ projectId: project.id, pmClaim: { kind: 'task_complete', task_id: stuckTask.id } });

  const all = svc.listClaims({ projectId: project.id });
  assert.equal(all.length, 3);

  const bad = svc.listClaims({ projectId: project.id, incoherentOnly: true });
  assert.equal(bad.length, 2);
  for (const r of bad) assert.equal(r.incoherence_flag, 1);
});

test('Phase 4: R1 fix — envelope binding rejects cross-project claim', async (t) => {
  // Regression for codex R1 #1: recordClaim must refuse to store a
  // claim whose referenced entity belongs to a DIFFERENT project than
  // the envelope project_id.
  const db = await mkdb(t);
  const { projectService, taskService, runService } = seedCore(db);
  const svc = createReconciliationService({
    db, runService, taskService, projectService,
  });
  const projAlpha = projectService.createProject({ name: 'alpha-2' });
  const projBeta = projectService.createProject({ name: 'beta' });
  const taskInAlpha = taskService.createTask({ title: 'T', project_id: projAlpha.id });

  assert.throws(
    () => svc.recordClaim({
      projectId: projBeta.id,
      pmClaim: { kind: 'task_complete', task_id: taskInAlpha.id },
    }),
    /belongs to project/
  );
});

test('Phase 4: R1 fix — envelope taskId must match pm_claim.task_id', async (t) => {
  const db = await mkdb(t);
  const { projectService, taskService, runService, project } = seedCore(db);
  const svc = createReconciliationService({
    db, runService, taskService, projectService,
  });
  const t1 = taskService.createTask({ title: 'one', project_id: project.id });
  const t2 = taskService.createTask({ title: 'two', project_id: project.id });

  assert.throws(
    () => svc.recordClaim({
      projectId: project.id,
      taskId: t1.id,
      pmClaim: { kind: 'task_complete', task_id: t2.id },
    }),
    /does not match/
  );
});

test('Phase 4: R1 fix — recordClaim refuses unknown project', async (t) => {
  const db = await mkdb(t);
  const { projectService, taskService, runService } = seedCore(db);
  const svc = createReconciliationService({
    db, runService, taskService, projectService,
  });
  assert.throws(
    () => svc.recordClaim({
      projectId: 'proj_never_existed',
      pmClaim: { kind: 'task_complete', task_id: 'anything' },
    }),
    /project not found/
  );
});

test('Phase 4: R1 fix — cross-project worker run rejected', async (t) => {
  const db = await mkdb(t);
  const { projectService, taskService, runService } = seedCore(db);
  const svc = createReconciliationService({
    db, runService, taskService, projectService,
  });
  const projA = projectService.createProject({ name: 'a' });
  const projB = projectService.createProject({ name: 'b' });
  const taskA = taskService.createTask({ title: 'ta', project_id: projA.id });
  const runA = runService.createRun({ task_id: taskA.id, agent_profile_id: 'a1', prompt: 'w' });

  assert.throws(
    () => svc.recordClaim({
      projectId: projB.id,
      pmClaim: { kind: 'worker_running', run_id: runA.id },
    }),
    /belongs to project/
  );
});

test('Phase 4: R2 fix — pm_run_id and pm_claim.run_id are distinct identities', async (t) => {
  // Regression for codex R2: pm_run_id (PM manager run) and
  // pm_claim.run_id (worker run) are DIFFERENT. A claim where the two
  // values differ must NOT be rejected by envelope binding — that's
  // actually the common case (PM reporting on a worker it spawned).
  // R4 update: pm_run_id must be a real PM-layer run owned by the
  // envelope project, so we use seedPmRun() instead of a raw Top.
  const db = await mkdb(t);
  const { projectService, taskService, runService, project } = seedCore(db);
  const svc = createReconciliationService({
    db, runService, taskService, projectService,
  });
  const pmRun = seedPmRun(runService, project.id);
  const task = taskService.createTask({ title: 'T', project_id: project.id });
  const worker = runService.createRun({ task_id: task.id, agent_profile_id: 'a1', prompt: 'w' });
  runService.updateRunStatus(worker.id, 'running', { force: true });

  // pm_run_id = PM's own, pm_claim.run_id = worker. MUST be accepted.
  const row = svc.recordClaim({
    projectId: project.id,
    pmRunId: pmRun.id,
    pmClaim: { kind: 'worker_running', run_id: worker.id },
  });
  assert.equal(row.incoherence_flag, 0);
  assert.notEqual(pmRun.id, worker.id);
});

test('Phase 4: R2 fix — PM prompt clarifies pm_run_id vs pm_claim.run_id distinction', () => {
  const { buildManagerSystemPrompt } = require('../services/managerSystemPrompt');
  const fakeAdapter = { buildGuardrailsSection: () => '' };
  const pmPrompt = buildManagerSystemPrompt({ adapter: fakeAdapter, port: 4177, layer: 'pm' });
  // The prompt must explicitly say the two ids are DIFFERENT identities.
  assert.match(pmPrompt, /DIFFERENT identities/);
  assert.match(pmPrompt, /YOUR OWN PM MANAGER run id/);
  // It must not tell PMs the run_id envelope must match pm_claim.run_id
  // (that would be wrong per R2).
  assert.doesNotMatch(pmPrompt, /run_id in the envelope.*must match/i);
});

test('Phase 4: R1 fix — PM system prompt documents POST /api/dispatch-audit', () => {
  const { buildManagerSystemPrompt } = require('../services/managerSystemPrompt');
  const fakeAdapter = { buildGuardrailsSection: () => '' };
  const pmPrompt = buildManagerSystemPrompt({ adapter: fakeAdapter, port: 4177, layer: 'pm' });
  const topPrompt = buildManagerSystemPrompt({ adapter: fakeAdapter, port: 4177, layer: 'top' });
  assert.match(pmPrompt, /\/api\/dispatch-audit/);
  assert.match(pmPrompt, /task_complete/);
  assert.match(pmPrompt, /worker_spawned/);
  // Top does NOT get the audit instructions (Phase 4 is PM-only today).
  assert.doesNotMatch(topPrompt, /\/api\/dispatch-audit/);
});

test('Phase 4: R5 fix — envelope task_id must exist and belong to project', async (t) => {
  const db = await mkdb(t);
  const { projectService, taskService, runService, project } = seedCore(db);
  const svc = createReconciliationService({
    db, runService, taskService, projectService,
  });
  // Nonexistent envelope task_id
  assert.throws(() => svc.recordClaim({
    projectId: project.id,
    taskId: 'task_does_not_exist',
    pmClaim: { kind: 'task_complete', task_id: 'task_does_not_exist' },
  }), /envelope task_id not found/);

  // Envelope task_id that belongs to a different project
  const other = projectService.createProject({ name: 'beta-e' });
  const otherTask = taskService.createTask({ title: 'O', project_id: other.id });
  assert.throws(() => svc.recordClaim({
    projectId: project.id,
    taskId: otherTask.id,
    pmClaim: { kind: 'task_complete' /* no task_id; envelope carries it */ },
  }), /belongs to project/);
});

test('Phase 4: R5 fix — envelope task_id must match pm_claim.run_id.task_id', async (t) => {
  // Intra-project sibling-task forgery: real run in project A, but
  // envelope task_id is a DIFFERENT task in the same project.
  const db = await mkdb(t);
  const { projectService, taskService, runService, project } = seedCore(db);
  const svc = createReconciliationService({
    db, runService, taskService, projectService,
  });
  const realTask = taskService.createTask({ title: 'real', project_id: project.id });
  const fakeTask = taskService.createTask({ title: 'fake', project_id: project.id });
  const run = runService.createRun({ task_id: realTask.id, agent_profile_id: 'a1' });
  runService.updateRunStatus(run.id, 'running', { force: true });
  assert.throws(() => svc.recordClaim({
    projectId: project.id,
    taskId: fakeTask.id,
    pmClaim: { kind: 'worker_running', run_id: run.id },
  }), /belongs to task .*, not envelope task_id/);
});

test('Phase 4: R5 fix — selected_agent_profile_id must exist', async (t) => {
  const db = await mkdb(t);
  const { projectService, taskService, runService, project } = seedCore(db);
  const agentProfileService = createAgentProfileService(db);
  const svc = createReconciliationService({
    db, runService, taskService, projectService, agentProfileService,
  });
  // Existing profile 'a1' from seedCore is acceptable
  const task = taskService.createTask({ title: 'T', project_id: project.id });
  taskService.updateTaskStatus(task.id, 'done');
  const good = svc.recordClaim({
    projectId: project.id,
    selectedAgentProfileId: 'a1',
    pmClaim: { kind: 'task_complete', task_id: task.id },
  });
  assert.equal(good.incoherence_flag, 0);

  // Nonexistent profile
  assert.throws(() => svc.recordClaim({
    projectId: project.id,
    selectedAgentProfileId: 'agent_does_not_exist',
    pmClaim: { kind: 'task_complete', task_id: task.id },
  }), /selected_agent_profile_id not found/);
});

test('Phase 4: R3 fix — worker_* claim against a manager run is flagged pm_hallucination', async (t) => {
  // Regression for codex R3 #2: previously a PM could claim
  // "worker_running" with a manager run id and be marked coherent
  // because only status was checked. Manager runs can never satisfy a
  // worker_* claim, regardless of status.
  const db = await mkdb(t);
  const { taskService, runService, project } = seedCore(db);
  const svc = createReconciliationService({
    db, runService, taskService,
    projectService: createProjectService(db),
  });
  // Manager run in the same project (via parent top). Manager runs
  // have no task_id, so binding rejects them BEFORE evaluation now.
  const mgr = runService.createRun({ is_manager: true, prompt: 'mgr' });
  runService.updateRunStatus(mgr.id, 'running', { force: true });
  assert.throws(
    () => svc.recordClaim({
      projectId: project.id,
      pmClaim: { kind: 'worker_running', run_id: mgr.id },
    }),
    /is a manager run/
  );
});

test('Phase 4: R3 fix — orphan run (no task) rejected by binding', async (t) => {
  const db = await mkdb(t);
  const { taskService, runService, project } = seedCore(db);
  const svc = createReconciliationService({
    db, runService, taskService,
    projectService: createProjectService(db),
  });
  // Raw insert of a non-manager run with no task_id — bypasses
  // createRun's worker validation so we can exercise the orphan path.
  db.prepare(`
    INSERT INTO runs (id, status, is_manager, conversation_id)
    VALUES ('run_orphan', 'running', 0, 'worker:run_orphan')
  `).run();
  assert.throws(
    () => svc.recordClaim({
      projectId: project.id,
      pmClaim: { kind: 'worker_running', run_id: 'run_orphan' },
    }),
    /has no task/
  );
});

test('Phase 4: R3 fix — PM system prompt injects pm_run_id into project scope', async (t) => {
  // Regression: pmSpawnService must bake the PM's own run id into the
  // project-scoped system prompt so the PM can self-identify when
  // calling /api/dispatch-audit. Use a fake codex adapter to capture
  // the systemPrompt passed to startSession.
  const db = await mkdb(t);
  const projectService = createProjectService(db);
  const projectBriefService = require('../services/projectBriefService').createProjectBriefService(db);
  const registry = require('../services/managerRegistry').createManagerRegistry({ runService: createRunService(db, null) });
  const rs = createRunService(db, null);
  const registry2 = require('../services/managerRegistry').createManagerRegistry({ runService: rs });

  let capturedSystemPrompt = null;
  const fakeAdapter = {
    type: 'codex',
    capabilities: { persistentProcess: false },
    startSession(runId, opts) {
      capturedSystemPrompt = opts.systemPrompt;
      return { sessionRef: {} };
    },
    runTurn: () => ({ accepted: true }),
    isSessionAlive: () => true,
    detectExitCode: () => null,
    emitSessionEndedIfNeeded: () => {},
    getUsage: () => null,
    getSessionId: () => null,
    getOutput: () => null,
    disposeSession: () => {},
    buildGuardrailsSection: () => '',
  };

  const { createPmSpawnService } = require('../services/pmSpawnService');
  const spawn = createPmSpawnService({
    runService: rs,
    managerRegistry: registry2,
    managerAdapterFactory: { getAdapter: () => fakeAdapter },
    projectService,
    projectBriefService,
    authResolverOpts: { hasKeychain: true },
  });

  const project = projectService.createProject({ name: 'alpha' });
  // Seed a live top
  const top = rs.createRun({ is_manager: true, prompt: 'top' });
  rs.updateRunStatus(top.id, 'running', { force: true });
  registry2.setActive('top', top.id, fakeAdapter);

  const result = spawn.ensureLivePm({ projectId: project.id });
  assert.ok(capturedSystemPrompt, 'systemPrompt must be captured');
  // The PM's own run id must appear in the system prompt so it can
  // self-reference when posting audit claims.
  assert.match(capturedSystemPrompt, new RegExp(`pm_run_id: ${result.run.id}`));
});

test('Phase 4: Phase 1.5 contract preserved — no blocking of PM claims', async (t) => {
  // This is an explicit annotate-only guarantee: recordClaim never
  // throws on incoherence. Even a maximally wrong claim returns a row.
  const db = await mkdb(t);
  const { taskService, runService, project } = seedCore(db);
  const svc = createReconciliationService({ db, runService, taskService });
  const row = svc.recordClaim({
    projectId: project.id,
    pmClaim: { kind: 'worker_completed', run_id: 'run_never_existed' },
  });
  assert.ok(row);
  assert.equal(row.incoherence_flag, 1);
  assert.equal(row.incoherence_kind, 'pm_hallucination');
});

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

async function createTestApp(t) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-reconcile-storage-'));
  const fsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-reconcile-fs-'));
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-reconcile-db-'));
  const dbPath = path.join(dbDir, 'test.db');
  const app = createApp({
    storageRoot, fsRoot, dbPath,
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

test('Phase 4: POST /api/dispatch-audit validates body', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).post('/api/dispatch-audit').send({});
  assert.equal(res.status, 400);
});

test('Phase 4: POST /api/dispatch-audit records and GET lists', async (t) => {
  const app = await createTestApp(t);
  const proj = (await request(app).post('/api/projects').send({ name: 'alpha' })).body.project;
  const task = (await request(app).post('/api/tasks').send({ title: 'T', project_id: proj.id })).body.task;

  // Coherent claim: PM says task in progress, task actually is in_progress
  await request(app).patch(`/api/tasks/${task.id}/status`).send({ status: 'in_progress' });
  const good = await request(app).post('/api/dispatch-audit').send({
    project_id: proj.id,
    task_id: task.id,
    pm_claim: { kind: 'task_in_progress', task_id: task.id },
  });
  assert.equal(good.status, 201);
  assert.equal(good.body.audit.incoherence_flag, 0);

  // Incoherent claim
  const bad = await request(app).post('/api/dispatch-audit').send({
    project_id: proj.id,
    task_id: task.id,
    pm_claim: { kind: 'task_complete', task_id: task.id },
  });
  assert.equal(bad.status, 201);
  assert.equal(bad.body.audit.incoherence_flag, 1);

  // List all
  const list = await request(app).get(`/api/dispatch-audit?project_id=${proj.id}`);
  assert.equal(list.status, 200);
  assert.equal(list.body.audit.length, 2);

  // List incoherent only
  const bad2 = await request(app).get(`/api/dispatch-audit?project_id=${proj.id}&incoherent_only=1`);
  assert.equal(bad2.body.audit.length, 1);
  assert.equal(bad2.body.audit[0].incoherence_flag, 1);
});
