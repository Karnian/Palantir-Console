'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../db/database');
const { createEventBus } = require('../services/eventBus');
const { createRunService } = require('../services/runService');
const { createProjectService } = require('../services/projectService');
const { createNodeService } = require('../services/nodeService');
const { createOperatorInstanceService } = require('../services/operatorInstanceService');
const { createOperatorScheduleService } = require('../services/operatorScheduleService');
const { createVerifyCheckService } = require('../services/verifyCheckService');
const { createOperatorScheduler } = require('../services/operatorScheduler');
const { evaluateArtifactPrecheck } = require('../services/precheckEvaluator');
const { repoSourceHash } = require('../utils/repoOperatorThread');

const BASE = new Date('2026-08-01T00:00:00.000Z');
const ONE = new Date('2026-08-01T01:00:00.000Z');

function harness(t, { createRemoteExecutor } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-precheck-runner-'));
  const handle = createDatabase(path.join(dir, 'test.db'));
  handle.migrate();
  t.after(() => {
    try { handle.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const db = handle.db;
  const eventBus = createEventBus();
  const runService = createRunService(db, eventBus);
  const projectService = createProjectService(db);
  const nodeService = createNodeService(db, {
    localExecutor: {},
    createRemoteExecutor: createRemoteExecutor || (() => ({
      async listFilesWithSizes() { return { records: [] }; },
    })),
  });
  const instanceService = createOperatorInstanceService(db, { runService });
  const scheduleService = createOperatorScheduleService(db, { eventBus, runService });
  const verifyCheckService = createVerifyCheckService(db);
  db.prepare(`
    INSERT INTO operator_profiles (id, name, capabilities_json, is_private)
    VALUES ('op_precheck_runner', 'Precheck Runner', '[]', 0)
  `).run();
  return {
    dir, db, eventBus, runService, projectService, nodeService,
    instanceService, scheduleService, verifyCheckService,
  };
}

function addRemoteNode(h, id, { reachable = true } = {}) {
  return h.nodeService.createNode({
    id,
    name: id,
    kind: 'ssh',
    ssh_host: `${id}.example`,
    ssh_user: 'operator',
    exposed_roots: ['/srv'],
    reachable,
  });
}

function fixture(h, {
  directory,
  nodeId = null,
  spec = { files: [{ glob: 'ready.txt', must_exist: true }], report: null },
  attached = true,
} = {}) {
  const project = h.projectService.createProject({
    name: `Precheck ${Math.random()}`,
    directory: directory || h.dir,
    node_id: nodeId,
  });
  const instance = h.instanceService.createInstance({
    profile_id: 'op_precheck_runner',
    primary_project_id: project.id,
  });
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Prechecked turn',
    prompt: 'Run only after the check',
    rule: { kind: 'interval', minutes: 60 },
    timezone: 'UTC',
  }, BASE);
  const check = h.verifyCheckService.createCheck({
    kind: 'artifact',
    project_id: project.id,
    name: `Artifact ${Math.random()}`,
    spec,
  }, { actor: 'human' });
  if (attached) {
    h.db.prepare('UPDATE operator_schedules SET precheck_verify_check_id=? WHERE id=?')
      .run(check.id, schedule.id);
  }
  return { project, instance, schedule, check, spec };
}

function schedulerFor(h, { clock, artifactPrecheckEvaluator } = {}) {
  return createOperatorScheduler({
    operatorScheduleService: h.scheduleService,
    conversationService: { sendMessage() { throw new Error('Top must stay unavailable in this test'); } },
    managerRegistry: { getActiveRunId() { return null; } },
    projectService: h.projectService,
    nodeService: h.nodeService,
    verifyCheckService: h.verifyCheckService,
    runService: h.runService,
    eventBus: h.eventBus,
    clock: clock || (() => ONE),
    random: () => 0.5,
    artifactPrecheckEvaluator,
  });
}

test('§7 #21a pass creates no invocation before commit and exactly one afterward', async (t) => {
  const h = harness(t);
  fs.writeFileSync(path.join(h.dir, 'ready.txt'), 'ready');
  const { schedule } = fixture(h);
  let evaluationStarted;
  const started = new Promise((resolve) => { evaluationStarted = resolve; });
  let continueEvaluation;
  const gate = new Promise((resolve) => { continueEvaluation = resolve; });
  const scheduler = schedulerFor(h, {
    artifactPrecheckEvaluator: async (input) => {
      evaluationStarted();
      await gate;
      return evaluateArtifactPrecheck(input);
    },
  });

  const tick = scheduler.tick();
  await started;
  assert.equal(h.scheduleService.listInvocations(schedule.id).length, 0);
  assert.equal(h.scheduleService.listOccurrences(schedule.id)[0].status, 'prechecking');
  continueEvaluation();
  await tick;

  const invocations = h.scheduleService.listInvocations(schedule.id);
  assert.equal(invocations.length, 1);
  const occurrence = h.scheduleService.listOccurrences(schedule.id)[0];
  assert.equal(occurrence.status, 'passed');
  assert.equal(occurrence.invocation_id, invocations[0].id);
  assert.equal(occurrence.evaluator, 'local');
  assert.ok(Buffer.byteLength(occurrence.detail_json, 'utf8') <= 2 * 1024);
});

test('dedicated attach -> tick -> passed occurrence -> one invocation end to end', async (t) => {
  const h = harness(t);
  fs.writeFileSync(path.join(h.dir, 'ready.txt'), 'ready');
  const { schedule, check } = fixture(h, { attached: false });

  const attached = h.scheduleService.attachPrecheck(schedule.id, {
    checkId: check.id,
    expectedRevision: schedule.revision,
  });
  assert.equal(attached.precheck_verify_check_id, check.id);
  assert.equal(attached.revision, schedule.revision + 1);

  await schedulerFor(h).tick();

  const occurrences = h.scheduleService.listOccurrences(schedule.id);
  const invocations = h.scheduleService.listInvocations(schedule.id);
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].status, 'passed');
  assert.equal(invocations.length, 1);
  assert.equal(occurrences[0].invocation_id, invocations[0].id);
});

test('attach/detach use revision CAS and an attached precheck blocks project changes', (t) => {
  const h = harness(t);
  const { project, instance, schedule, check } = fixture(h, { attached: false });
  const otherProject = h.projectService.createProject({
    name: 'Other mapped project',
    directory: path.join(h.dir, 'other'),
  });
  h.instanceService.addRef(instance.id, { project_id: otherProject.id, role: 'reference' });
  const changedEvents = [];
  h.eventBus.subscribe((event) => {
    if (
      event.channel === 'operator:schedule'
      && event.data.kind === 'schedule_changed'
      && event.data.schedule_id === schedule.id
    ) changedEvents.push(event.data);
  });

  const attached = h.scheduleService.attachPrecheck(schedule.id, {
    checkId: check.id,
    expectedRevision: schedule.revision,
  });
  assert.throws(
    () => h.scheduleService.attachPrecheck(schedule.id, {
      checkId: check.id,
      expectedRevision: schedule.revision,
    }),
    (err) => err.status === 409,
  );
  assert.throws(
    () => h.scheduleService.detachPrecheck(schedule.id, { expectedRevision: schedule.revision }),
    (err) => err.status === 409,
  );
  assert.throws(
    () => h.scheduleService.updateSchedule(schedule.id, {
      expected_revision: attached.revision,
      codebase_project_id: otherProject.id,
    }, ONE),
    (err) => err.status === 409,
  );
  assert.equal(h.scheduleService.getSchedule(schedule.id).codebase_project_id, project.id);

  const detached = h.scheduleService.detachPrecheck(schedule.id, {
    expectedRevision: attached.revision,
  });
  assert.equal(detached.precheck_verify_check_id, null);
  assert.equal(detached.revision, attached.revision + 1);
  assert.equal(changedEvents.length, 2, 'only successful attach and detach emit schedule_changed');
});

test('attach rejects command, operator provenance, global scope, and project mismatch with fixed statuses', (t) => {
  const h = harness(t);
  const { project, schedule } = fixture(h, { attached: false });
  const otherProject = h.projectService.createProject({
    name: 'Mismatched check project',
    directory: path.join(h.dir, 'mismatch'),
  });
  const command = h.verifyCheckService.createCheck({
    kind: 'command', project_id: project.id, name: 'Command precheck',
    spec: { command: 'true' },
  }, { actor: 'human' });
  const operator = h.verifyCheckService.createCheck({
    kind: 'artifact', project_id: project.id, name: 'Operator artifact',
    spec: { files: [], report: { min_chars: 0 } },
  }, { actor: 'operator' });
  const global = h.verifyCheckService.createCheck({
    kind: 'artifact', project_id: null, name: 'Global artifact',
    spec: { files: [], report: { min_chars: 0 } },
  }, { actor: 'human' });
  const mismatch = h.verifyCheckService.createCheck({
    kind: 'artifact', project_id: otherProject.id, name: 'Mismatched artifact',
    spec: { files: [], report: { min_chars: 0 } },
  }, { actor: 'human' });

  for (const [checkId, expectedStatus] of [
    [command.id, 400],
    [operator.id, 403],
    [global.id, 400],
    [mismatch.id, 400],
  ]) {
    assert.throws(
      () => h.scheduleService.attachPrecheck(schedule.id, {
        checkId,
        expectedRevision: schedule.revision,
      }),
      (err) => err.status === expectedStatus,
    );
  }
  assert.equal(h.scheduleService.getSchedule(schedule.id).revision, schedule.revision);
});

test('§7 #21b failed artifact evaluation creates zero invocations', async (t) => {
  const h = harness(t);
  const { schedule } = fixture(h);
  const scheduler = schedulerFor(h);
  await scheduler.tick();

  assert.equal(h.scheduleService.listInvocations(schedule.id).length, 0);
  assert.equal(h.scheduleService.listOccurrences(schedule.id)[0].status, 'precheck_failed');
  assert.equal(h.scheduleService.getSchedule(schedule.id).next_fire_at, '2026-08-01T02:00:00.000Z');
});

test('§7 #14 unavailable runner backs off and passes after node recovery', async (t) => {
  const executorCalls = [];
  const h = harness(t, {
    createRemoteExecutor: () => ({
      async listFilesWithSizes(root, options) {
        executorCalls.push({ root, options });
        return { records: ['f\t5\tready.txt'] };
      },
    }),
  });
  addRemoteNode(h, 'node-a', { reachable: false });
  const { schedule } = fixture(h, { directory: '/srv/project', nodeId: 'node-a' });
  let current = ONE;
  const scheduler = schedulerFor(h, { clock: () => current });

  await scheduler.tick();
  let occurrence = h.scheduleService.listOccurrences(schedule.id)[0];
  assert.equal(occurrence.status, 'pending');
  assert.ok(occurrence.next_attempt_at > ONE.toISOString());
  assert.equal(h.scheduleService.listInvocations(schedule.id).length, 0);
  assert.equal(executorCalls.length, 0);

  h.nodeService.updateNode('node-a', { reachable: true });
  current = new Date(occurrence.next_attempt_at);
  await scheduler.tick();
  occurrence = h.scheduleService.listOccurrences(schedule.id)[0];
  assert.equal(occurrence.status, 'passed');
  assert.equal(h.scheduleService.listInvocations(schedule.id).length, 1);
  assert.equal(executorCalls.length, 1);
});

test('§7 #29 moving the project after node A evaluation makes commit superseded', async (t) => {
  const h = harness(t, {
    createRemoteExecutor: () => ({
      async listFilesWithSizes() { return { records: ['f\t5\tready.txt'] }; },
    }),
  });
  addRemoteNode(h, 'node-a');
  addRemoteNode(h, 'node-b');
  const { project, schedule } = fixture(h, { directory: '/srv/project', nodeId: 'node-a' });
  let evaluationStarted;
  const started = new Promise((resolve) => { evaluationStarted = resolve; });
  let continueEvaluation;
  const gate = new Promise((resolve) => { continueEvaluation = resolve; });
  const scheduler = schedulerFor(h, {
    artifactPrecheckEvaluator: async (input) => {
      const result = await evaluateArtifactPrecheck(input);
      evaluationStarted();
      await gate;
      return result;
    },
  });

  const tick = scheduler.tick();
  await started;
  h.projectService.updateProject(project.id, { node_id: 'node-b' });
  continueEvaluation();
  await tick;

  assert.equal(h.scheduleService.listInvocations(schedule.id).length, 0);
  const occurrence = h.scheduleService.listOccurrences(schedule.id)[0];
  assert.equal(occurrence.status, 'superseded');
  assert.equal(occurrence.outcome_reason, 'workspace_changed');
});

test('git prechecks use the generation-fenced materialized repo cwd', async (t) => {
  const h = harness(t);
  const workspace = path.join(h.dir, 'materialized');
  const packageDir = path.join(workspace, 'packages', 'app');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'ready.txt'), 'ready');
  const project = h.projectService.createProject({
    name: 'Materialized git project',
    source_type: 'git',
    repo_url: 'https://example.invalid/repo.git',
    repo_subdir: 'packages/app',
  });
  const instance = h.instanceService.createInstance({
    profile_id: 'op_precheck_runner',
    primary_project_id: project.id,
  });
  h.runService.setOperatorInstanceThread(instance.id, {
    thread_id: 'thread-materialized',
    cwd: packageDir,
    source_generation: project.source_generation,
    source_hash: repoSourceHash(project),
    workspace_path: workspace,
  });
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Git prechecked turn',
    prompt: 'Run after checking the materialized subdirectory',
    rule: { kind: 'interval', minutes: 60 },
    timezone: 'UTC',
  }, BASE);
  const check = h.verifyCheckService.createCheck({
    kind: 'artifact',
    project_id: project.id,
    name: 'Git artifact',
    spec: { files: [{ glob: 'ready.txt' }], report: null },
  }, { actor: 'human' });
  h.db.prepare('UPDATE operator_schedules SET precheck_verify_check_id=? WHERE id=?')
    .run(check.id, schedule.id);

  await schedulerFor(h).tick();
  assert.equal(h.scheduleService.listOccurrences(schedule.id)[0].status, 'passed');
  assert.equal(h.scheduleService.listInvocations(schedule.id).length, 1);
});

test('an unmaterialized git workspace is retried, never evaluated against a null root', async (t) => {
  const h = harness(t);
  const project = h.projectService.createProject({
    name: 'Unmaterialized git project',
    source_type: 'git',
    repo_url: 'https://example.invalid/repo.git',
  });
  const instance = h.instanceService.createInstance({
    profile_id: 'op_precheck_runner',
    primary_project_id: project.id,
  });
  // No setOperatorInstanceThread: the repo has never been materialized on this
  // node. That is a TRANSIENT condition (the clone may still be running), not a
  // failed condition — evaluating a null root would silently answer "no files".
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Git prechecked turn',
    prompt: 'Run after checking',
    rule: { kind: 'interval', minutes: 60 },
    timezone: 'UTC',
  }, BASE);
  const check = h.verifyCheckService.createCheck({
    kind: 'artifact',
    project_id: project.id,
    name: 'Unmaterialized artifact',
    spec: { files: [{ glob: 'ready.txt' }], report: null },
  }, { actor: 'human' });
  h.db.prepare('UPDATE operator_schedules SET precheck_verify_check_id=? WHERE id=?')
    .run(check.id, schedule.id);

  let evaluatorCalls = 0;
  await schedulerFor(h, {
    artifactPrecheckEvaluator: async () => { evaluatorCalls += 1; throw new Error('must not run'); },
  }).tick();

  assert.equal(evaluatorCalls, 0, 'the evaluator must not be invoked without a workspace root');
  const occurrence = h.scheduleService.listOccurrences(schedule.id)[0];
  assert.equal(occurrence.status, 'pending', 'retryable, not terminal');
  assert.ok(occurrence.next_attempt_at > ONE.toISOString(), 'backoff is persisted');
  assert.equal(h.scheduleService.listInvocations(schedule.id).length, 0);
  assert.equal(
    h.db.prepare('SELECT consecutive_precheck_errors AS e FROM operator_schedules WHERE id=?')
      .get(schedule.id).e,
    0,
    'a not-yet-materialized workspace is not an infrastructure failure count',
  );
});

test('a hung precheck does not starve delivery in the same tick', async (t) => {
  const h = harness(t);
  fs.writeFileSync(path.join(h.dir, 'ready.txt'), 'ready');
  fixture(h);

  let released;
  const hang = new Promise((resolve) => { released = resolve; });
  let claimedInvocations = 0;
  const scheduler = createOperatorScheduler({
    operatorScheduleService: {
      ...h.scheduleService,
      claimNext: (...args) => {
        claimedInvocations += 1;
        return h.scheduleService.claimNext(...args);
      },
    },
    conversationService: { sendMessage() { throw new Error('unused'); } },
    managerRegistry: { getActiveRunId() { return null; } },
    projectService: h.projectService,
    nodeService: h.nodeService,
    verifyCheckService: h.verifyCheckService,
    runService: h.runService,
    eventBus: h.eventBus,
    clock: () => ONE,
    random: () => 0.5,
    artifactPrecheckEvaluator: () => hang,
  });

  const tick = scheduler.tick();
  // Delivery must have run its claim loop while the precheck is still pending.
  // Serialising the two drains would leave this at 0 until the hang resolves —
  // and because tick() holds `inflight`, every later tick would be skipped too.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(claimedInvocations > 0, 'delivery claims must not wait on the precheck');
  released({ passed: true, detail: { evaluator: 'local' }, evaluated: {} });
  await tick;
});
