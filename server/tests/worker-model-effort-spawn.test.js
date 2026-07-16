'use strict';

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

async function createHarness(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-worker-model-effort-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 'test.db'));
  migrate();
  t.after(async () => {
    close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const runService = createRunService(db, null);
  const taskService = createTaskService(db);
  const projectService = createProjectService(db);
  const executionEngine = createExecutionEngine();
  const streamJsonEngine = createStreamJsonEngine();
  const lifecycleService = createLifecycleService({
    runService,
    taskService,
    agentProfileService: createAgentProfileService(db),
    projectService,
    executionEngine,
    streamJsonEngine,
    worktreeService: null,
    eventBus: null,
  });
  const project = projectService.createProject({
    name: 'Worker model/effort project',
    directory: null,
  });

  return {
    db,
    runService,
    taskService,
    executionEngine,
    streamJsonEngine,
    lifecycleService,
    project,
  };
}

function createExecutionEngine() {
  const spawned = [];
  return {
    spawned,
    spawnAgent(runId, opts) {
      spawned.push({ runId, opts });
      return { sessionName: `worker-${runId}` };
    },
    isAlive() { return true; },
    detectExitCode() { return null; },
    getOutput() { return ''; },
    sendInput() { return true; },
    kill() {},
    discoverGhostSessions() { return []; },
    hasProcess() { return false; },
  };
}

function createStreamJsonEngine() {
  const spawned = [];
  return {
    spawned,
    spawnAgent(runId, opts) {
      spawned.push({ runId, opts });
      return { sessionName: null };
    },
    hasProcess(runId) { return spawned.some((spawn) => spawn.runId === runId); },
    isAlive() { return true; },
    detectExitCode() { return null; },
    sendInput() { return true; },
    kill() { return true; },
  };
}

function insertProfile(db, {
  command,
  argsTemplate = 'exec --full-auto --skip-git-repo-check {prompt}',
  model = null,
  reasoningEffort = null,
}) {
  const id = `${command}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db.prepare(`
    INSERT INTO agent_profiles (
      id, name, type, command, args_template, capabilities_json,
      env_allowlist, max_concurrent, model, reasoning_effort
    ) VALUES (?, ?, ?, ?, ?, '{}', '[]', 5, ?, ?)
  `).run(id, id, command, command, argsTemplate, model, reasoningEffort);
  return id;
}

async function executeWorker(harness, profileId, title) {
  const task = harness.taskService.createTask({
    project_id: harness.project.id,
    title,
    description: 'spawn worker',
  });
  return harness.lifecycleService.executeTask(task.id, {
    agentProfileId: profileId,
    prompt: 'hello',
  });
}

test('codex worker injects structured effort/model before forced tier and snapshots both', async (t) => {
  const harness = await createHarness(t);
  const profileId = insertProfile(harness.db, {
    command: 'codex',
    model: 'gpt-x',
    reasoningEffort: 'high',
  });

  const run = await executeWorker(harness, profileId, 'Structured codex worker');

  assert.deepEqual(harness.executionEngine.spawned[0].opts.args, [
    '-c', 'model_reasoning_effort="high"',
    '-m', 'gpt-x',
    '-c', 'service_tier="default"',
    'exec', '--full-auto', '--skip-git-repo-check', 'hello',
  ]);
  const persisted = harness.runService.getRun(run.id);
  assert.equal(persisted.session_model, 'gpt-x');
  assert.equal(persisted.session_effort, 'high');
});

test('codex worker argv stays byte-identical when structured columns are NULL', async (t) => {
  const harness = await createHarness(t);
  const profileId = insertProfile(harness.db, { command: 'codex' });

  await executeWorker(harness, profileId, 'Default codex worker');

  assert.deepEqual(harness.executionEngine.spawned[0].opts.args, [
    '-c', 'service_tier="default"',
    'exec', '--full-auto', '--skip-git-repo-check', 'hello',
  ]);
});

test('claude worker forwards structured model to the stream-json spec', async (t) => {
  const harness = await createHarness(t);
  const profileId = insertProfile(harness.db, {
    command: 'claude',
    argsTemplate: '{prompt}',
    model: 'claude-x',
  });

  await executeWorker(harness, profileId, 'Structured claude worker');

  assert.equal(harness.streamJsonEngine.spawned.length, 1);
  assert.equal(harness.streamJsonEngine.spawned[0].opts.model, 'claude-x');
  assert.equal(harness.executionEngine.spawned.length, 0);
});

test('raw-SQL-contaminated structured profile fails before claim and never spawns', async (t) => {
  const harness = await createHarness(t);
  const profileId = insertProfile(harness.db, {
    command: 'codex',
    argsTemplate: `exec --full-auto --skip-git-repo-check -c 'model_reasoning_effort="high"' {prompt}`,
    reasoningEffort: 'high',
  });

  const run = await executeWorker(harness, profileId, 'Contaminated codex worker');
  const persisted = harness.runService.getRun(run.id);

  assert.equal(persisted.status, 'failed');
  assert.equal(persisted.started_at, null);
  assert.equal(harness.executionEngine.spawned.length, 0);
  assert.ok(
    harness.runService.getRunEvents(run.id)
      .some((event) => event.event_type === 'worker:profile_invalid'),
  );
});
