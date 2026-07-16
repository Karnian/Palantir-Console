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

  // Codex final-review blocker: valid TOML with a QUOTED key + spacing must
  // ALSO be refused. The prior tight regex only matched `service_tier=` and
  // missed `'"service_tier" = "fast"'` — which codex would still parse as
  // service_tier=fast, re-overriding the forced default on a batch worker.
  const quotedTask = taskService.createTask({
    project_id: project.id,
    title: 'Quoted tier worker',
    description: 'must fail closed',
  });
  const quotedProfileId = insertCodexProfile(db, `-c '"service_tier" = "fast"' exec {prompt}`);
  await assert.rejects(
    () => lifecycleService.executeTask(quotedTask.id, {
      agentProfileId: quotedProfileId,
      prompt: 'hello',
    }),
    /worker args_template must not set service_tier\/features\.fast_mode/,
  );

  const safeTask = taskService.createTask({
    project_id: project.id,
    title: 'Standard worker',
    description: 'must spawn',
  });
  const safeProfileId = insertCodexProfile(db, 'exec {prompt}');
  // Codex final-review R2: a normal template must NOT be refused just because
  // the PROMPT (substituted into {prompt}) mentions the tier keywords — the
  // scan targets the raw template structure, not user prompt data.
  const safeRun = await lifecycleService.executeTask(safeTask.id, {
    agentProfileId: safeProfileId,
    prompt: 'please fix the service_tier bug and the fast_mode flag handling',
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

test('putPolicy: stale edit after delete → NotFoundError, not a revived INSERT', async (t) => {
  // Codex final-review blocker: a PUT that carries expectedRevision means the
  // caller believes it is EDITING an existing row. If that row was deleted
  // meanwhile, the write must 404 — it must NOT resurrect the policy via INSERT.
  const db = await createTestDatabase(t);
  const service = createModelPolicyService(db);

  const created = service.putPolicy({
    scope_type: 'global', scope_id: '*', vendor: 'codex',
    params: { tier: 'fast' }, changed_by: 'human',
  });
  assert.equal(created.revision, 1);

  service.deletePolicy({ scope_type: 'global', scope_id: '*', vendor: 'codex', changed_by: 'human' });

  // stale edit (expectedRevision present) on the now-deleted row → 404
  assert.throws(
    () => service.putPolicy({
      scope_type: 'global', scope_id: '*', vendor: 'codex',
      params: { tier: 'standard' }, expectedRevision: 1, changed_by: 'human',
    }),
    (err) => err && err.constructor && err.constructor.name === 'NotFoundError',
  );
  // and it did NOT revive the row
  assert.equal(service.getPolicy({ scope_type: 'global', scope_id: '*', vendor: 'codex' }), null);

  // a genuine create (no expectedRevision) still works afterwards
  const recreated = service.putPolicy({
    scope_type: 'global', scope_id: '*', vendor: 'codex',
    params: { tier: 'standard' }, changed_by: 'human',
  });
  assert.equal(recreated.revision, 1);
});
