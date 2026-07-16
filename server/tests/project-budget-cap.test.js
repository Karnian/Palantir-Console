'use strict';

// Phase 3 (cost cap): project budget constraint. projects.budget_usd (opt-in;
// NULL = no cap = byte-identical) is enforced at spawn, BEFORE claim, so an
// over-budget rejection is non-retryable. REJECT — never a silent downgrade.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../db/database');
const { createAgentProfileService } = require('../services/agentProfileService');
const { createLifecycleService } = require('../services/lifecycleService');
const { createProjectService } = require('../services/projectService');
const { createRunService } = require('../services/runService');
const { createTaskService } = require('../services/taskService');

async function harness(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-budget-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 'test.db'));
  migrate();
  t.after(async () => { close(); await fsp.rm(dir, { recursive: true, force: true }); });

  const runService = createRunService(db, null);
  const taskService = createTaskService(db);
  const projectService = createProjectService(db);
  const executionEngine = createExecutionEngine();
  const lifecycleService = createLifecycleService({
    runService, taskService,
    agentProfileService: createAgentProfileService(db),
    projectService, executionEngine,
    streamJsonEngine: createStreamJsonEngine(),
    worktreeService: null, eventBus: null,
  });
  return { db, runService, taskService, projectService, executionEngine, lifecycleService };
}

function createExecutionEngine() {
  const spawned = [];
  return {
    spawned,
    spawnAgent(runId, opts) { spawned.push({ runId, opts }); return { sessionName: `worker-${runId}` }; },
    isAlive() { return true; }, detectExitCode() { return null; }, getOutput() { return ''; },
    sendInput() { return true; }, kill() {}, discoverGhostSessions() { return []; }, hasProcess() { return false; },
  };
}
function createStreamJsonEngine() {
  return { spawnAgent() { throw new Error('unexpected stream-json spawn'); }, hasProcess() { return false; },
    isAlive() { return false; }, detectExitCode() { return null; }, sendInput() { return false; }, kill() { return true; } };
}
function insertCodexProfile(db) {
  const id = `codex-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command, args_template, capabilities_json, env_allowlist, max_concurrent)
              VALUES (?, ?, 'codex', 'codex', 'exec {prompt}', '{}', '[]', 5)`).run(id, id);
  return id;
}
function seedCost(db, taskId, costUsd) {
  const id = `run-seed-${Math.random().toString(36).slice(2)}`;
  db.prepare(`INSERT INTO runs (id, task_id, status, cost_usd) VALUES (?, ?, 'completed', ?)`).run(id, taskId, costUsd);
  return id;
}

test('sumProjectCost sums task-linked runs; manager (no task) runs excluded', async (t) => {
  const h = await harness(t);
  const project = h.projectService.createProject({ name: 'P', directory: null });
  const task = h.taskService.createTask({ project_id: project.id, title: 'T', description: 'x' });
  seedCost(h.db, task.id, 3);
  seedCost(h.db, task.id, 4);
  // a manager run (no task_id) must not count toward the project spend
  h.db.prepare(`INSERT INTO runs (id, task_id, status, cost_usd, is_manager) VALUES ('mgr', NULL, 'completed', 100, 1)`).run();
  assert.equal(h.runService.sumProjectCost(project.id), 7);
});

test('budget_usd NULL → worker spawns normally (no cap, byte-identical path)', async (t) => {
  const h = await harness(t);
  const project = h.projectService.createProject({ name: 'No cap', directory: null });
  const task = h.taskService.createTask({ project_id: project.id, title: 'T', description: 'x' });
  seedCost(h.db, task.id, 9999); // huge prior spend, but no budget set → not enforced
  const run = await h.lifecycleService.executeTask(task.id, { agentProfileId: insertCodexProfile(h.db), prompt: 'hi' });
  const persisted = h.runService.getRun(run.id);
  assert.equal(persisted.status, 'running');
  assert.equal(h.executionEngine.spawned.length, 1);
});

test('spent < budget → spawns; spent ≥ budget → rejected before claim (non-retryable)', async (t) => {
  const h = await harness(t);
  const project = h.projectService.createProject({ name: 'Capped', directory: null, budget_usd: 10 });
  const task = h.taskService.createTask({ project_id: project.id, title: 'T', description: 'x' });
  const profileId = insertCodexProfile(h.db);

  seedCost(h.db, task.id, 5); // spent 5 < 10
  const run1 = await h.lifecycleService.executeTask(task.id, { agentProfileId: profileId, prompt: 'a' });
  assert.equal(h.runService.getRun(run1.id).status, 'running');
  assert.equal(h.executionEngine.spawned.length, 1);

  seedCost(h.db, task.id, 5); // now spent 10 ≥ budget 10
  const run2 = await h.lifecycleService.executeTask(task.id, { agentProfileId: profileId, prompt: 'b' });
  const p2 = h.runService.getRun(run2.id);
  assert.equal(p2.status, 'failed');
  assert.equal(p2.started_at, null, 'rejected before claim → never started');
  assert.equal(h.executionEngine.spawned.length, 1, 'no new spawn');
  assert.ok(
    h.runService.getRunEvents(run2.id).some(e => e.event_type === 'run:budget_exceeded'),
    'run:budget_exceeded emitted',
  );
  // non-retryable: retry_count forced to MAX (B-lite skips) + durable
  // non_retryable flag (goal). Codex P3 review #2/#3.
  assert.equal(p2.retry_count, 1, 'retry_count forced to MAX_RETRY → B-lite non-retryable');
  assert.equal(p2.non_retryable, 1, 'durable non_retryable flag set → goal error/non_retryable');
});

test('non_retryable survives a preserved started_at on a goal-active run (Codex #3 counterexample)', async (t) => {
  const h = await harness(t);
  const { createGoalVerdictService } = require('../services/goalVerdictService');
  const project = h.projectService.createProject({ name: 'P', directory: null });
  const task = h.taskService.createTask({ project_id: project.id, title: 'T', description: 'x' });
  // A goal retry child carries goal_active=1 at queue time and a requeue would
  // preserve started_at — the exact path the started_at heuristic missed.
  h.db.prepare(`INSERT INTO runs (id, task_id, status, started_at, goal_active) VALUES ('gr', ?, 'queued', '2020-01-01 00:00:00', 1)`).run(task.id);

  assert.equal(h.runService.rejectQueuedRun('gr', { reason: 'budget_exceeded', retryCount: 1 }), true);
  const run = h.runService.getRun('gr');
  assert.equal(run.non_retryable, 1);
  assert.ok(run.started_at, 'started_at preserved (the edge)');

  const gv = createGoalVerdictService({ runService: h.runService, taskService: h.taskService });
  assert.equal(gv.computeInputs(run).nonRetryable, true,
    'isNonRetryable honors non_retryable despite started_at → error/non_retryable, not a within-budget retry');
});

test('budget_usd=0 caps everything (0 is a cap, not opt-out — only NULL opts out)', async (t) => {
  const h = await harness(t);
  const project = h.projectService.createProject({ name: 'Zero cap', directory: null, budget_usd: 0 });
  const task = h.taskService.createTask({ project_id: project.id, title: 'T', description: 'x' });
  const run = await h.lifecycleService.executeTask(task.id, { agentProfileId: insertCodexProfile(h.db), prompt: 'x' });
  const p = h.runService.getRun(run.id);
  assert.equal(p.status, 'failed', 'spent 0 >= cap 0 → rejected');
  assert.equal(h.executionEngine.spawned.length, 0);
});

test('rejectQueuedRun is an idempotent CAS — a second call on a non-queued run loses', async (t) => {
  const h = await harness(t);
  const project = h.projectService.createProject({ name: 'P', directory: null });
  const task = h.taskService.createTask({ project_id: project.id, title: 'T', description: 'x' });
  const run = h.runService.createRun({ task_id: task.id, agent_profile_id: insertCodexProfile(h.db), prompt: 'x' });
  assert.equal(h.runService.rejectQueuedRun(run.id, { reason: 'x', retryCount: 1 }), true, 'first CAS wins');
  const failed = h.runService.getRun(run.id);
  assert.equal(failed.status, 'failed');
  assert.ok(failed.ended_at, 'terminal transition stamps ended_at');
  assert.equal(h.runService.rejectQueuedRun(run.id, { reason: 'x', retryCount: 1 }), false, 'second CAS loses (not queued)');
});

test('rejectQueuedRun never LOWERS an existing retry_count (MAX, not overwrite)', async (t) => {
  const h = await harness(t);
  const project = h.projectService.createProject({ name: 'P', directory: null });
  const task = h.taskService.createTask({ project_id: project.id, title: 'T', description: 'x' });
  // a run already on its 3rd attempt (retry_count=2), re-queued
  h.db.prepare(`INSERT INTO runs (id, task_id, status, retry_count) VALUES ('r', ?, 'queued', 2)`).run(task.id);
  h.runService.rejectQueuedRun('r', { reason: 'x', retryCount: 1 });
  assert.equal(h.runService.getRun('r').retry_count, 2, 'MAX(2,1)=2 — attempt count not corrupted for review/webhook');
});
