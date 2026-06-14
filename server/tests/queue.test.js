const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createTaskService } = require('../services/taskService');
const { createProjectService } = require('../services/projectService');
const { createAgentProfileService } = require('../services/agentProfileService');
const { createLifecycleService } = require('../services/lifecycleService');
const { createEventBus } = require('../services/eventBus');
const { createApp } = require('../app');

async function mkdb(t, prefix = 'palantir-queue-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    try { close(); } catch { /* ignore */ }
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { db, dbPath };
}

function waitFor(predicate, { timeoutMs = 3000, intervalMs = 10 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      try {
        if (predicate()) return resolve();
        if (Date.now() >= deadline) {
          assert.ok(predicate(), 'condition was not met before timeout');
          return resolve();
        }
      } catch (err) {
        return reject(err);
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function stubExecEngine() {
  const spawned = [];
  const killed = [];
  return {
    type: 'subprocess',
    spawned,
    killed,
    spawnAgent(runId, opts) {
      spawned.push({ runId, opts });
      return { sessionName: `session-${runId}` };
    },
    isAlive() { return true; },
    detectExitCode() { return null; },
    getOutput() { return ''; },
    sendInput() { return true; },
    kill(runId) { killed.push(runId); return true; },
    discoverGhostSessions() { return []; },
    hasProcess() { return false; },
  };
}

function stubStreamJsonEngine() {
  return {
    spawned: [],
    spawnAgent(runId, opts) {
      this.spawned.push({ runId, opts });
      return { sessionName: null };
    },
    hasProcess() { return false; },
    isAlive() { return true; },
    detectExitCode() { return null; },
    sendInput() { return true; },
    kill() { return true; },
  };
}

function seedProject(projectService) {
  return projectService.createProject({ name: `P-${Math.random().toString(36).slice(2)}` });
}

function seedTask(taskService, projectId, overrides = {}) {
  return taskService.createTask({
    project_id: projectId,
    title: `T-${Math.random().toString(36).slice(2)}`,
    description: 'queue test',
    status: 'in_progress',
    ...overrides,
  });
}

function seedProfile(db, { max = 1, command = 'codex' } = {}) {
  const id = `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db.prepare(`
    INSERT INTO agent_profiles (id, name, type, command, args_template, capabilities_json, env_allowlist, max_concurrent)
    VALUES (?, 'QueueAgent', 'codex', ?, '{prompt}', '{}', '[]', ?)
  `).run(id, command, max);
  return { id, max_concurrent: max, command };
}

function buildHarness(db, { eventBus = null, harvestService = null, presetService = null } = {}) {
  const runService = createRunService(db, eventBus);
  const taskService = createTaskService(db);
  const projectService = createProjectService(db);
  const agentProfileService = createAgentProfileService(db);
  const executionEngine = stubExecEngine();
  const streamJsonEngine = stubStreamJsonEngine();
  const lifecycleService = createLifecycleService({
    runService,
    taskService,
    agentProfileService,
    projectService,
    executionEngine,
    streamJsonEngine,
    worktreeService: null,
    harvestService,
    eventBus,
    presetService,
  });
  return {
    runService,
    taskService,
    projectService,
    agentProfileService,
    executionEngine,
    streamJsonEngine,
    lifecycleService,
  };
}

function createRunningRun(runService, { taskId, profileId, retryCount = 0, queuedArgs = null, prompt = 'running' }) {
  const run = runService.createRun({
    task_id: taskId,
    agent_profile_id: profileId,
    prompt,
    queued_args: queuedArgs,
    retry_count: retryCount,
  });
  return runService.markRunStarted(run.id, { tmux_session: `session-${run.id}` });
}

function eventsOf(runService, runId, type) {
  return runService.getRunEvents(runId).filter((evt) => evt.event_type === type);
}

test('queue: max_concurrent reached enqueues without throwing and queued does not count as running', async (t) => {
  const { db } = await mkdb(t);
  const h = buildHarness(db);
  const project = seedProject(h.projectService);
  const blockerTask = seedTask(h.taskService, project.id);
  const queuedTask = seedTask(h.taskService, project.id);
  const profile = seedProfile(db, { max: 1 });
  createRunningRun(h.runService, { taskId: blockerTask.id, profileId: profile.id });

  const run = await h.lifecycleService.executeTask(queuedTask.id, {
    agentProfileId: profile.id,
    prompt: 'queued',
    skillPackIds: ['pack_a'],
  });

  assert.equal(run.status, 'queued');
  assert.equal(h.executionEngine.spawned.length, 0);
  assert.equal(h.agentProfileService.getRunningCount(profile.id), 1);
  assert.equal(eventsOf(h.runService, run.id, 'queue:enqueued').length, 1);
  assert.deepEqual(JSON.parse(run.queued_args), { skillPackIds: ['pack_a'], presetId: null });
});

test('queue: terminal run drains oldest queued run first', async (t) => {
  const { db } = await mkdb(t);
  const eventBus = createEventBus();
  const h = buildHarness(db, { eventBus });
  t.after(() => h.lifecycleService.stopMonitoring());

  const project = seedProject(h.projectService);
  const profile = seedProfile(db, { max: 1 });
  const blockerTask = seedTask(h.taskService, project.id);
  const firstTask = seedTask(h.taskService, project.id);
  const secondTask = seedTask(h.taskService, project.id);
  const blocker = createRunningRun(h.runService, { taskId: blockerTask.id, profileId: profile.id });
  const first = await h.lifecycleService.executeTask(firstTask.id, { agentProfileId: profile.id, prompt: 'first' });
  const second = await h.lifecycleService.executeTask(secondTask.id, { agentProfileId: profile.id, prompt: 'second' });
  db.prepare(`UPDATE runs SET created_at = '2026-01-01 00:00:01' WHERE id = ?`).run(first.id);
  db.prepare(`UPDATE runs SET created_at = '2026-01-01 00:00:02' WHERE id = ?`).run(second.id);

  h.lifecycleService.startMonitoring();
  h.runService.updateRunStatus(blocker.id, 'completed', { force: true });

  await waitFor(() => h.executionEngine.spawned.length === 1);
  assert.equal(h.executionEngine.spawned[0].runId, first.id);
  assert.equal(h.runService.getRun(first.id).status, 'running');
  assert.equal(h.runService.getRun(second.id).status, 'queued');
});

test('queue: queued spawn restores enqueue-time effective preset and explicit skill packs', async (t) => {
  const { db } = await mkdb(t);
  const presetCalls = [];
  const presetService = {
    resolveForSpawn({ presetId, adapter }) {
      presetCalls.push({ presetId, adapter });
      return {
        preset: { id: presetId, plugin_refs: [], setting_sources: '', base_system_prompt: '' },
        snapshot: { hash: `hash-${presetId}` },
        warnings: [],
        mcpConfig: null,
        minClaudeVersion: null,
        isolated: false,
        pluginDirs: [],
        settingSources: '',
      };
    },
    compareSemver() { return 0; },
    persistSnapshot() {},
    mergeMcp3() { return null; },
    resolvePromptChain({ presetPrompt, skillPackSections }) {
      return [presetPrompt, ...(skillPackSections || [])].filter(Boolean).join('\n\n') || null;
    },
  };
  const h = buildHarness(db, { presetService });
  const project = seedProject(h.projectService);
  const profile = seedProfile(db, { max: 1 });
  const blockerTask = seedTask(h.taskService, project.id);
  const queuedTask = seedTask(h.taskService, project.id, { preferred_preset_id: 'preset_old' });
  createRunningRun(h.runService, { taskId: blockerTask.id, profileId: profile.id });

  const queued = await h.lifecycleService.executeTask(queuedTask.id, {
    agentProfileId: profile.id,
    prompt: 'preset drift',
    skillPackIds: ['pack_fixed'],
  });
  db.prepare(`UPDATE tasks SET preferred_preset_id = 'preset_new' WHERE id = ?`).run(queuedTask.id);

  await h.lifecycleService.drainQueue(profile.id);

  assert.equal(h.executionEngine.spawned.length, 0, 'still saturated before blocker ends');
  h.runService.updateRunStatus(h.runService.listRuns({ task_id: blockerTask.id })[0].id, 'completed', { force: true });
  await h.lifecycleService.drainQueue(profile.id);

  assert.equal(h.executionEngine.spawned.length, 1);
  assert.equal(h.executionEngine.spawned[0].runId, queued.id);
  assert.deepEqual(presetCalls, [{ presetId: 'preset_old', adapter: 'codex' }]);
  assert.deepEqual(JSON.parse(h.runService.getRun(queued.id).queued_args), {
    skillPackIds: ['pack_fixed'],
    presetId: 'preset_old',
  });
});

test('queue: failed worker creates one new retry attempt and second failure skips', async (t) => {
  const { db } = await mkdb(t);
  const eventBus = createEventBus();
  const h = buildHarness(db, { eventBus });
  t.after(() => h.lifecycleService.stopMonitoring());

  const project = seedProject(h.projectService);
  const task = seedTask(h.taskService, project.id);
  const profile = seedProfile(db, { max: 0 });
  const original = createRunningRun(h.runService, {
    taskId: task.id,
    profileId: profile.id,
    queuedArgs: { skillPackIds: null, presetId: null },
  });

  h.lifecycleService.startMonitoring();
  h.runService.updateRunStatus(original.id, 'failed', { force: true });

  let runs = h.runService.listRuns({ task_id: task.id });
  assert.equal(runs.length, 2);
  const retry = runs.find((r) => r.id !== original.id);
  assert.equal(retry.retry_count, 1);
  assert.equal(retry.status, 'queued');
  assert.equal(eventsOf(h.runService, retry.id, 'queue:retry').length, 1);

  h.runService.markRunStarted(retry.id, { tmux_session: `session-${retry.id}` });
  h.runService.updateRunStatus(retry.id, 'failed', { force: true });

  runs = h.runService.listRuns({ task_id: task.id });
  assert.equal(runs.length, 2, 'retry_count=1 failure must not enqueue a third run');
});

test('queue: failed run that never started (no started_at) does not auto-retry', async (t) => {
  const { db } = await mkdb(t);
  const eventBus = createEventBus();
  const h = buildHarness(db, { eventBus });
  t.after(() => h.lifecycleService.stopMonitoring());

  const project = seedProject(h.projectService);
  const task = seedTask(h.taskService, project.id);
  const profile = seedProfile(db, { max: 0 });
  // A run created but never spawned (manual PATCH to failed, or a bare
  // createRun) has no started_at — only claimQueuedRun/markRunStarted set it.
  // Such a run must NOT spawn a retry attempt (else manual/test failures and
  // never-spawned rows would loop). Mirrors v2-api manual failed->queued.
  const run = h.runService.createRun({
    task_id: task.id,
    agent_profile_id: profile.id,
    prompt: 'never-started',
    queued_args: { skillPackIds: null, presetId: null },
  });
  assert.equal(run.started_at, null, 'precondition: run never started');

  h.lifecycleService.startMonitoring();
  h.runService.updateRunStatus(run.id, 'failed', { force: true });

  const runs = h.runService.listRuns({ task_id: task.id });
  assert.equal(runs.length, 1, 'un-started failed run must not create a retry attempt');
});

test('queue: original failed run is harvested once while retry is separate', async (t) => {
  const { db } = await mkdb(t);
  const eventBus = createEventBus();
  const harvestCalls = [];
  const harvestService = {
    async harvestRun(run) {
      harvestCalls.push(run.id);
    },
  };
  const h = buildHarness(db, { eventBus, harvestService });
  t.after(() => h.lifecycleService.stopMonitoring());

  const project = seedProject(h.projectService);
  const task = seedTask(h.taskService, project.id);
  const profile = seedProfile(db, { max: 0 });
  const original = createRunningRun(h.runService, {
    taskId: task.id,
    profileId: profile.id,
    queuedArgs: { skillPackIds: null, presetId: null },
  });

  h.lifecycleService.startMonitoring();
  h.runService.updateRunStatus(original.id, 'failed', { force: true });

  await waitFor(() => harvestCalls.length === 1);
  assert.deepEqual(harvestCalls, [original.id]);
  const retry = h.runService.listRuns({ task_id: task.id }).find((r) => r.id !== original.id);
  assert.ok(retry, 'retry attempt exists as a separate run');
});

test('queue: cancelled and stopped worker runs do not retry', async (t) => {
  const { db } = await mkdb(t);
  const eventBus = createEventBus();
  const h = buildHarness(db, { eventBus });
  t.after(() => h.lifecycleService.stopMonitoring());

  const project = seedProject(h.projectService);
  const profile = seedProfile(db, { max: 0 });
  const cancelledTask = seedTask(h.taskService, project.id);
  const stoppedTask = seedTask(h.taskService, project.id);
  const cancelled = createRunningRun(h.runService, { taskId: cancelledTask.id, profileId: profile.id });
  const stopped = createRunningRun(h.runService, { taskId: stoppedTask.id, profileId: profile.id });

  h.lifecycleService.startMonitoring();
  h.runService.updateRunStatus(cancelled.id, 'cancelled', { force: true });
  h.runService.updateRunStatus(stopped.id, 'stopped', { force: true });

  assert.equal(h.runService.listRuns({ task_id: cancelledTask.id }).length, 1);
  assert.equal(h.runService.listRuns({ task_id: stoppedTask.id }).length, 1);
});

test('queue: claim CAS prevents duplicate spawn of the same queued run', async (t) => {
  const { db } = await mkdb(t);
  const h = buildHarness(db);
  const project = seedProject(h.projectService);
  const task = seedTask(h.taskService, project.id);
  const profile = seedProfile(db, { max: 2 });
  const queued = h.runService.createRun({
    task_id: task.id,
    agent_profile_id: profile.id,
    prompt: 'claim me once',
    queued_args: { skillPackIds: null, presetId: null },
  });

  const first = h.lifecycleService.spawnQueuedRun(queued.id);
  const second = h.lifecycleService.spawnQueuedRun(queued.id);
  await Promise.allSettled([first, second]);

  assert.equal(h.executionEngine.spawned.length, 1);
  assert.equal(h.executionEngine.spawned[0].runId, queued.id);
  assert.equal(eventsOf(h.runService, queued.id, 'queue:dequeued').length, 1);
});

test('queue: retry is registered before checkTaskCompletion so task does not flip failed', async (t) => {
  const { db } = await mkdb(t);
  const eventBus = createEventBus();
  const h = buildHarness(db, { eventBus });
  t.after(() => h.lifecycleService.stopMonitoring());

  const project = seedProject(h.projectService);
  const task = seedTask(h.taskService, project.id, { status: 'in_progress' });
  const profile = seedProfile(db, { max: 0 });
  const original = createRunningRun(h.runService, {
    taskId: task.id,
    profileId: profile.id,
    queuedArgs: { skillPackIds: null, presetId: null },
  });

  h.lifecycleService.startMonitoring();
  h.runService.updateRunStatus(original.id, 'failed', { force: true });

  assert.equal(h.taskService.getTask(task.id).status, 'in_progress');
  assert.equal(h.runService.listRuns({ task_id: task.id }).length, 2);
});

test('queue: manager runs are excluded from retry and queue drain', async (t) => {
  const { db } = await mkdb(t);
  const eventBus = createEventBus();
  const h = buildHarness(db, { eventBus });
  t.after(() => h.lifecycleService.stopMonitoring());

  const manager = h.runService.createRun({
    is_manager: true,
    prompt: 'manage',
    manager_adapter: 'claude-code',
  });
  h.runService.markRunStarted(manager.id, { tmux_session: `session-${manager.id}` });

  h.lifecycleService.startMonitoring();
  h.runService.updateRunStatus(manager.id, 'failed', { force: true });
  await h.lifecycleService.drainAllQueues();

  assert.equal(h.runService.listRuns({}).filter((r) => r.id !== manager.id).length, 0);
  assert.equal(h.executionEngine.spawned.length, 0);
});

test('queue: manager run on same profile does not consume worker concurrency', async (t) => {
  // Codex Top/PM can run with agent_profile_id set (POST /api/manager/start
  // {agent_profile_id:'codex'}). If countRunning included managers, a running
  // manager would eat a worker slot and — since manager run:ended returns
  // before drain — starve the worker queue. countRunning must be worker-only.
  const { db } = await mkdb(t);
  const h = buildHarness(db, {});
  const profile = seedProfile(db, { max: 1 });

  const manager = h.runService.createRun({
    is_manager: true,
    agent_profile_id: profile.id,
    prompt: 'top',
    manager_adapter: 'codex',
    manager_layer: 'top',
    conversation_id: 'top',
  });
  h.runService.updateRunStatus(manager.id, 'running', { force: true });

  assert.equal(
    h.runService.countRunning(profile.id),
    0,
    'a running manager on the same profile must not count toward worker concurrency'
  );
});

test('queue: app boot drains queued worker runs after orphan recovery', async (t) => {
  const { db, dbPath } = await mkdb(t, 'palantir-queue-app-');
  const eventBus = null;
  const runService = createRunService(db, eventBus);
  const taskService = createTaskService(db);
  const projectService = createProjectService(db);
  const project = seedProject(projectService);
  const task = seedTask(taskService, project.id);
  const profile = seedProfile(db, { max: 1 });
  const queued = runService.createRun({
    task_id: task.id,
    agent_profile_id: profile.id,
    prompt: 'boot drain',
    queued_args: { skillPackIds: null, presetId: null },
  });
  db.close();

  const executionEngine = stubExecEngine();
  const app = createApp({
    dbPath,
    authToken: null,
    executionEngine,
    // boot drain is skipped under NODE_TEST_CONTEXT by default (so other tests'
    // createApp doesn't claim/corrupt seeded queued rows); opt in explicitly here.
    forceBootDrain: true,
    storageRoot: path.join(os.tmpdir(), `palantir-storage-${Date.now()}`),
    fsRoot: os.tmpdir(),
  });
  t.after(() => app.shutdown());

  await waitFor(() => executionEngine.spawned.length === 1);
  assert.equal(executionEngine.spawned[0].runId, queued.id);
  assert.equal(app.services.runService.getRun(queued.id).status, 'running');
});

test('queue: corrupt queued_args fails closed AND does not spawn a wasted retry', async (t) => {
  // eventBus + startMonitoring on, so the run:ended retry path is live — the
  // coupling Codex flagged: a corrupt-args failure has started_at (claimed),
  // so without the retry-budget exhaustion it would spawn one identical-failure
  // retry. Guard that it does NOT.
  const { db } = await mkdb(t);
  const eventBus = createEventBus();
  const h = buildHarness(db, { eventBus });
  t.after(() => h.lifecycleService.stopMonitoring());
  const profile = seedProfile(db, { max: 1 });
  const project = seedProject(h.projectService);
  const task = seedTask(h.taskService, project.id);
  const run = h.runService.createRun({
    task_id: task.id,
    agent_profile_id: profile.id,
    prompt: 'corrupt',
    queued_args: '{not-json',
  });

  h.lifecycleService.startMonitoring();
  const result = await h.lifecycleService.spawnQueuedRun(run.id);

  assert.equal(result, null, 'spawnQueuedRun returns null on corrupt args');
  const after = h.runService.getRun(run.id);
  assert.equal(after.status, 'failed', 'run is failed-closed, not spawned');
  assert.equal(after.retry_count, 1, 'retry budget exhausted so no wasted retry');
  assert.equal(h.executionEngine.spawned.length, 0, 'no worker spawned with missing args');
  assert.equal(eventsOf(h.runService, run.id, 'queue:args_invalid').length, 1);

  // No second (retry) attempt run was created for this task.
  const taskRuns = h.runService.listRuns({ task_id: task.id });
  assert.equal(taskRuns.length, 1, 'corrupt-args failure must not enqueue a retry attempt');
});
