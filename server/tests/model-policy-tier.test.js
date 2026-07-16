'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../db/database');
const { createAgentProfileService } = require('../services/agentProfileService');
const { createLifecycleService } = require('../services/lifecycleService');
const { createModelPolicyService } = require('../services/modelPolicyService');
const { createProjectService } = require('../services/projectService');
const { createRunService } = require('../services/runService');
const { createTaskService } = require('../services/taskService');

async function createTestDatabase(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-model-tier-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 'test.db'));
  migrate();
  t.after(async () => {
    close();
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return db;
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
  return {
    spawnAgent() { throw new Error('unexpected stream-json spawn'); },
    hasProcess() { return false; },
    isAlive() { return false; },
    detectExitCode() { return null; },
    sendInput() { return false; },
    kill() { return true; },
  };
}

function insertCodexProfile(db, argsTemplate) {
  const id = `codex-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db.prepare(`
    INSERT INTO agent_profiles (
      id, name, type, command, args_template, capabilities_json, env_allowlist, max_concurrent
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 5)
  `).run(id, id, 'codex', 'codex', argsTemplate, '{}', '[]');
  return id;
}

test('resolveServiceTier maps policy vocabulary to Codex CLI vocabulary', async (t) => {
  const db = await createTestDatabase(t);
  const service = createModelPolicyService(db);

  assert.equal(service.resolveServiceTier({
    layer: 'operator', instanceFastMode: 1, env: {},
  }), 'fast');
  assert.equal(service.resolveServiceTier({
    layer: 'operator', instanceFastMode: 0, env: {},
  }), 'default');
  assert.equal(service.resolveServiceTier({
    layer: 'operator', instanceFastMode: null, env: {},
  }), 'default');
  assert.equal(service.resolveServiceTier({
    layer: 'operator', instanceFastMode: null, env: { PALANTIR_CODEX_FAST: '1' },
  }), 'fast');

  service.putPolicy({
    scope_type: 'global',
    scope_id: '*',
    vendor: 'codex',
    params: { tier: 'fast' },
    changed_by: 'test',
  });
  assert.equal(service.resolveServiceTier({
    layer: 'operator', instanceFastMode: null, env: {},
  }), 'fast');

  service.putPolicy({
    scope_type: 'layer:operator',
    scope_id: '*',
    vendor: 'codex',
    params: { tier: 'standard' },
    changed_by: 'test',
  });
  assert.equal(service.resolveServiceTier({
    layer: 'operator', instanceFastMode: null, env: {},
  }), 'default');

  service.putPolicy({
    scope_type: 'layer:operator',
    scope_id: '*',
    vendor: 'codex',
    params: { tier: 'fast' },
    changed_by: 'test',
    expectedRevision: 1,
  });
  assert.equal(service.resolveServiceTier({
    layer: 'operator', instanceFastMode: null, env: {},
  }), 'fast');
});

test('Codex worker refuses tier tokens from args_template and accepts a normal template', async (t) => {
  const db = await createTestDatabase(t);
  const runService = createRunService(db, null);
  const taskService = createTaskService(db);
  const projectService = createProjectService(db);
  const executionEngine = createExecutionEngine();
  const lifecycleService = createLifecycleService({
    runService,
    taskService,
    agentProfileService: createAgentProfileService(db),
    projectService,
    executionEngine,
    streamJsonEngine: createStreamJsonEngine(),
    worktreeService: null,
    eventBus: null,
  });
  const project = projectService.createProject({ name: 'Tier worker project', directory: null });

  const forbiddenTask = taskService.createTask({
    project_id: project.id,
    title: 'Forbidden tier worker',
    description: 'must fail closed',
  });
  const forbiddenProfileId = insertCodexProfile(db, '-c "service_tier=fast" exec {prompt}');
  await assert.rejects(
    () => lifecycleService.executeTask(forbiddenTask.id, {
      agentProfileId: forbiddenProfileId,
      prompt: 'hello',
    }),
    /worker args_template must not set service_tier\/features\.fast_mode/,
  );

  assert.equal(executionEngine.spawned.length, 0);
  const failedRun = runService.listRuns({}).find((run) => run.task_id === forbiddenTask.id);
  assert.ok(failedRun);
  assert.equal(failedRun.status, 'failed');
  const forbiddenEvent = runService.getRunEvents(failedRun.id)
    .find((event) => event.event_type === 'worker:tier_forbidden');
  assert.ok(forbiddenEvent, 'worker:tier_forbidden emitted');
  assert.match(
    JSON.stringify(forbiddenEvent),
    /service_tier\/features\.fast_mode not allowed in worker args_template/,
  );

  const safeTask = taskService.createTask({
    project_id: project.id,
    title: 'Standard worker',
    description: 'must spawn',
  });
  const safeProfileId = insertCodexProfile(db, 'exec {prompt}');
  const safeRun = await lifecycleService.executeTask(safeTask.id, {
    agentProfileId: safeProfileId,
    prompt: 'hello',
  });

  assert.equal(safeRun.status, 'running');
  assert.equal(executionEngine.spawned.length, 1);
  assert.deepEqual(
    executionEngine.spawned[0].opts.args.slice(0, 2),
    ['-c', 'service_tier="default"'],
  );
  assert.ok(
    !runService.getRunEvents(safeRun.id)
      .some((event) => event.event_type === 'worker:tier_forbidden'),
  );
});
