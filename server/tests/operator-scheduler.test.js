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
const {
  createOperatorScheduleService,
  nextFireForRule,
} = require('../services/operatorScheduleService');
const { createOperatorScheduler } = require('../services/operatorScheduler');

function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-operator-scheduler-'));
  const handle = createDatabase(path.join(dir, 'test.db'));
  handle.migrate();
  t.after(() => {
    try { handle.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const db = handle.db;
  const eventBus = createEventBus();
  const runService = createRunService(db, eventBus);
  const nodeService = createNodeService(db);
  const projectService = createProjectService(db);
  const instanceService = createOperatorInstanceService(db, { runService });
  const scheduleService = createOperatorScheduleService(db, { eventBus, runService });
  db.prepare(`
    INSERT INTO operator_profiles (id, name, capabilities_json, is_private)
    VALUES ('op_scheduler', 'Scheduler Operator', '[]', 0)
  `).run();
  return { db, eventBus, runService, nodeService, projectService, instanceService, scheduleService };
}

function createMappedOperator(h, projectFields = {}) {
  const project = h.projectService.createProject({ name: 'Mapped folder', directory: '/tmp', ...projectFields });
  const instance = h.instanceService.createInstance({
    profile_id: 'op_scheduler',
    display_name: 'Hourly Maintainer',
    primary_project_id: project.id,
  });
  return { project, instance };
}

test('interval rule calculates an hourly next fire', () => {
  const next = nextFireForRule(
    { kind: 'interval', minutes: 60 },
    'Asia/Seoul',
    new Date('2026-07-23T00:00:00.000Z'),
  );
  assert.equal(next.toISOString(), '2026-07-23T01:00:00.000Z');
});

test('daily rule honors the selected IANA timezone', () => {
  const next = nextFireForRule(
    { kind: 'daily', at: '09:00' },
    'Asia/Seoul',
    new Date('2026-07-23T00:01:00.000Z'),
  );
  assert.equal(next.toISOString(), '2026-07-24T00:00:00.000Z');
});

test('daily rule handles DST gaps and folds without early or duplicate wall-clock fires', () => {
  const spring = nextFireForRule(
    { kind: 'daily', at: '02:30' },
    'America/New_York',
    new Date('2026-03-08T06:00:00.000Z'),
  );
  assert.equal(spring.toISOString(), '2026-03-08T07:00:00.000Z');

  const fallFirst = nextFireForRule(
    { kind: 'daily', at: '01:30' },
    'America/New_York',
    new Date('2026-11-01T04:00:00.000Z'),
  );
  assert.equal(fallFirst.toISOString(), '2026-11-01T05:30:00.000Z');
  const afterFirstFold = nextFireForRule(
    { kind: 'daily', at: '01:30' },
    'America/New_York',
    new Date('2026-11-01T05:45:00.000Z'),
  );
  assert.equal(afterFirstFold.toISOString(), '2026-11-02T06:30:00.000Z');
});

test('Operator-first creation maps a primary folder and then accepts a schedule', (t) => {
  const h = harness(t);
  const { project, instance } = createMappedOperator(h);
  assert.equal(instance.display_name, 'Hourly Maintainer');
  assert.equal(instance.refs[0].project_id, project.id);
  assert.equal(instance.refs[0].role, 'primary');

  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Hourly health check',
    prompt: 'Inspect this folder and report blocked work.',
    rule: { kind: 'interval', minutes: 60 },
    timezone: 'Asia/Seoul',
  }, new Date('2026-07-23T00:00:00.000Z'));
  assert.equal(schedule.operator_instance_id, instance.id);
  assert.equal(schedule.codebase_project_id, project.id);
  assert.equal(schedule.next_fire_at, '2026-07-23T01:00:00.000Z');
});

test('a schedule cannot be registered before the Operator has a primary folder', (t) => {
  const h = harness(t);
  const instance = h.instanceService.createInstance({ profile_id: 'op_scheduler' });
  assert.throws(
    () => h.scheduleService.createSchedule(instance.id, {
      name: 'Invalid', prompt: 'No folder yet', rule: { kind: 'interval', minutes: 60 },
    }),
    /primary folder/,
  );
});

test('schedule boolean flags reject truthy strings instead of silently enabling', (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  assert.throws(
    () => h.scheduleService.createSchedule(instance.id, {
      name: 'Invalid flag', prompt: 'Check', rule: { kind: 'interval', minutes: 60 }, enabled: 'false',
    }),
    /enabled must be boolean/,
  );
});

test('due materialization coalesces missed intervals into one durable invocation', (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Hourly', prompt: 'Check', rule: { kind: 'interval', minutes: 60 }, timezone: 'UTC',
  }, new Date('2026-07-23T00:00:00.000Z'));

  const created = h.scheduleService.materializeDue(new Date('2026-07-23T04:30:00.000Z'));
  assert.equal(created.length, 1);
  assert.equal(created[0].scheduled_for, '2026-07-23T04:00:00.000Z');
  assert.equal(h.scheduleService.getSchedule(schedule.id).next_fire_at, '2026-07-23T05:00:00.000Z');

  const again = h.scheduleService.materializeDue(new Date('2026-07-23T06:30:00.000Z'));
  assert.equal(again.length, 0, 'active invocation prevents overlap');
  assert.equal(h.scheduleService.getSchedule(schedule.id).next_fire_at, '2026-07-23T07:00:00.000Z');
});

test('one Operator materializes at most one active invocation across schedules', (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const first = h.scheduleService.createSchedule(instance.id, {
    name: 'First hourly', prompt: 'First', rule: { kind: 'interval', minutes: 60 }, timezone: 'UTC',
  }, new Date('2026-07-23T00:00:00.000Z'));
  const second = h.scheduleService.createSchedule(instance.id, {
    name: 'Second hourly', prompt: 'Second', rule: { kind: 'interval', minutes: 60 }, timezone: 'UTC',
  }, new Date('2026-07-23T00:00:00.000Z'));

  const created = h.scheduleService.materializeDue(new Date('2026-07-23T01:00:00.000Z'));
  assert.equal(created.length, 1);
  assert.equal(h.db.prepare(`
    SELECT COUNT(*) AS count FROM operator_invocations
    WHERE operator_instance_id=? AND status IN ('pending','claimed','delivering','running')
  `).get(instance.id).count, 1);
  assert.throws(
    () => h.scheduleService.runNow(created[0].schedule_id === first.id ? second.id : first.id),
    /Operator already has an active invocation/,
  );

  h.db.prepare("UPDATE operator_invocations SET status='completed', completed_at=datetime('now') WHERE id=?").run(created[0].id);
  const next = h.scheduleService.materializeDue(new Date('2026-07-23T01:00:01.000Z'));
  assert.equal(next.length, 1);
  assert.notEqual(next[0].schedule_id, created[0].schedule_id);
});

test('068 migration reconciles legacy overlapping Operator turns before adding single-flight index', (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const firstSchedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Legacy running', prompt: 'First', rule: { kind: 'interval', minutes: 60 },
  });
  const secondSchedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Legacy delivering', prompt: 'Second', rule: { kind: 'interval', minutes: 60 },
  });

  h.db.exec('DROP INDEX idx_operator_invocations_active_operator');
  const running = h.scheduleService.runNow(firstSchedule.id, new Date('2026-07-23T00:00:00.000Z'));
  const delivering = h.scheduleService.runNow(secondSchedule.id, new Date('2026-07-23T00:00:00.000Z'));
  h.db.prepare("UPDATE operator_invocations SET status='running' WHERE id=?").run(running.id);
  h.db.prepare("UPDATE operator_invocations SET status='delivering' WHERE id=?").run(delivering.id);

  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'migrations', '068_operator_scheduler_hardening.sql'),
    'utf8',
  );
  h.db.exec(sql);

  assert.equal(h.db.prepare('SELECT status FROM operator_invocations WHERE id=?').get(running.id).status, 'running');
  assert.equal(h.db.prepare('SELECT status FROM operator_invocations WHERE id=?').get(delivering.id).status, 'uncertain');
  assert.throws(
    () => h.scheduleService.runNow(secondSchedule.id, new Date('2026-07-23T01:00:00.000Z')),
    /Operator already has an active invocation/,
  );
});

test('a schedule cannot target a mapped folder on a different node from its Operator', (t) => {
  const h = harness(t);
  h.nodeService.createNode({
    id: 'node-a', name: 'Node A', kind: 'ssh', ssh_host: 'a.example', ssh_user: 'operator',
    exposed_roots: ['/srv'], reachable: true,
  });
  h.nodeService.createNode({
    id: 'node-b', name: 'Node B', kind: 'ssh', ssh_host: 'b.example', ssh_user: 'operator',
    exposed_roots: ['/srv'], reachable: true,
  });
  const { instance } = createMappedOperator(h, { directory: '/srv/a', node_id: 'node-a' });
  const other = h.projectService.createProject({ name: 'Other node', directory: '/srv/b', node_id: 'node-b' });
  h.instanceService.addRef(instance.id, { project_id: other.id, role: 'reference' });

  assert.throws(
    () => h.scheduleService.createSchedule(instance.id, {
      name: 'Cross node', prompt: 'Inspect', codebase_project_id: other.id,
      rule: { kind: 'interval', minutes: 60 },
    }),
    /must be on the Operator node/,
  );
});

test('manual run-now obeys the schedule daily cap', (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Capped', prompt: 'Check', rule: { kind: 'interval', minutes: 60 }, max_runs_per_day: 1,
  });
  const first = h.scheduleService.runNow(schedule.id, new Date('2026-07-23T00:00:00.000Z'));
  h.db.prepare("UPDATE operator_invocations SET status='completed' WHERE id=?").run(first.id);

  assert.throws(
    () => h.scheduleService.runNow(schedule.id, new Date('2026-07-23T01:00:00.000Z')),
    /daily run limit/,
  );
});

test('restart marks the external delivery window uncertain instead of replaying it', (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Crash window', prompt: 'Check', rule: { kind: 'interval', minutes: 60 },
  });
  h.scheduleService.runNow(schedule.id, new Date('2026-07-23T00:00:00.000Z'));
  const claimed = h.scheduleService.claimNext(new Date('2026-07-23T00:00:01.000Z'));
  h.scheduleService.markDelivering(claimed.id, claimed.claim_token);

  const recovered = h.scheduleService.recoverAfterRestart(new Date('2026-07-23T00:01:00.000Z'));
  assert.deepEqual(recovered, { pending: 0, uncertain: 1 });
  assert.equal(h.scheduleService.listInvocations(schedule.id)[0].status, 'uncertain');
  assert.equal(h.scheduleService.claimNext(new Date('2026-07-23T00:02:00.000Z')), null);
});

test('scheduler delivers through the instance conversation and correlates turn completion', async (t) => {
  const h = harness(t);
  const { project, instance } = createMappedOperator(h);
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Hourly', prompt: 'Run the hourly audit', rule: { kind: 'interval', minutes: 60 }, timezone: 'UTC',
  });
  const invocation = h.scheduleService.runNow(schedule.id);
  const top = h.runService.createRun({ is_manager: true, manager_layer: 'top', conversation_id: 'top', prompt: 'top' });
  const operatorRun = h.runService.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: `operator:${instance.id}`,
    operator_instance_id: instance.id,
    parent_run_id: top.id,
    prompt: 'operator',
  });
  const sends = [];
  const scheduler = createOperatorScheduler({
    operatorScheduleService: h.scheduleService,
    conversationService: {
      sendMessage(conversationId, payload) {
        sends.push({ conversationId, payload });
        return { status: 'sent', target: { kind: 'pm', runId: operatorRun.id } };
      },
    },
    managerRegistry: { getActiveRunId(slot) { return slot === 'top' ? top.id : null; } },
    projectService: h.projectService,
    nodeService: { getNode() { throw new Error('local should not read a node'); } },
    runService: h.runService,
    eventBus: h.eventBus,
    intervalMs: 999999,
  });
  scheduler.start();
  t.after(() => scheduler.stop());
  await scheduler.awaitDrain();

  assert.equal(sends.length, 1);
  assert.equal(sends[0].conversationId, `operator:${instance.id}`);
  assert.equal(sends[0].payload.codebaseProjectId, project.id);
  assert.equal(sends[0].payload.invocationId, invocation.id);
  assert.equal(h.scheduleService.listInvocations(schedule.id)[0].status, 'running');

  const mismatchedEventId = h.runService.addRunEvent(
    operatorRun.id,
    'mgr.assistant_message',
    JSON.stringify({ data: { invocationId: invocation.id, terminal: true } }),
  );
  h.eventBus.emit('run:event', {
    runId: operatorRun.id,
    eventType: 'mgr.turn_completed',
    eventId: mismatchedEventId,
  });
  assert.equal(h.scheduleService.listInvocations(schedule.id)[0].status, 'running');
  h.runService.addRunEvent(operatorRun.id, 'mgr.turn_completed', JSON.stringify({ data: { terminal: true } }));
  assert.equal(h.scheduleService.listInvocations(schedule.id)[0].status, 'running');
  h.runService.addRunEvent(operatorRun.id, 'mgr.turn_completed', JSON.stringify({ data: { invocationId: 'oinv_wrong', terminal: true } }));
  assert.equal(h.scheduleService.listInvocations(schedule.id)[0].status, 'running');
  h.runService.addRunEvent(operatorRun.id, 'mgr.turn_failed', JSON.stringify({ data: { invocationId: invocation.id, terminal: false } }));
  assert.equal(h.scheduleService.listInvocations(schedule.id)[0].status, 'running');
  h.runService.addRunEvent(operatorRun.id, 'mgr.turn_completed', JSON.stringify({ data: { invocationId: invocation.id, terminal: true } }));
  assert.equal(h.scheduleService.listInvocations(schedule.id)[0].status, 'completed');
});

test('scheduler keeps an invocation pending when Top is unavailable', async (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Hourly', prompt: 'Check', rule: { kind: 'interval', minutes: 60 },
  });
  h.scheduleService.runNow(schedule.id);
  const scheduler = createOperatorScheduler({
    operatorScheduleService: h.scheduleService,
    conversationService: { sendMessage() { throw new Error('must not send'); } },
    managerRegistry: { getActiveRunId() { return null; } },
    projectService: h.projectService,
    runService: h.runService,
    eventBus: h.eventBus,
    intervalMs: 999999,
  });
  scheduler.start();
  t.after(() => scheduler.stop());
  await scheduler.awaitDrain();
  const row = h.scheduleService.listInvocations(schedule.id)[0];
  assert.equal(row.status, 'pending');
  assert.equal(row.waiting_reason, 'top_unavailable');
});

test('scheduler maps an external-node primary folder and waits for node recovery before delivery', async (t) => {
  const h = harness(t);
  h.nodeService.createNode({
    id: 'node-a',
    name: 'Remote node A',
    kind: 'ssh',
    ssh_host: 'node-a.example',
    ssh_user: 'operator',
    exposed_roots: ['/srv'],
    reachable: false,
  });
  const { project, instance } = createMappedOperator(h, {
    name: 'Remote folder',
    directory: '/srv/operator-work',
    node_id: 'node-a',
  });
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Remote hourly', prompt: 'Inspect the remote folder', rule: { kind: 'interval', minutes: 60 },
  });
  h.scheduleService.runNow(schedule.id);
  const top = h.runService.createRun({ is_manager: true, manager_layer: 'top', conversation_id: 'top', prompt: 'top' });
  const operatorRun = h.runService.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: `operator:${instance.id}`,
    operator_instance_id: instance.id,
    parent_run_id: top.id,
    node_id: 'node-a',
    prompt: 'operator',
  });
  const sends = [];
  const scheduler = createOperatorScheduler({
    operatorScheduleService: h.scheduleService,
    conversationService: {
      sendMessage(conversationId, payload) {
        sends.push({ conversationId, payload });
        return { status: 'sent', target: { kind: 'pm', runId: operatorRun.id } };
      },
    },
    managerRegistry: { getActiveRunId() { return top.id; } },
    projectService: h.projectService,
    nodeService: h.nodeService,
    runService: h.runService,
    eventBus: h.eventBus,
    intervalMs: 999999,
  });
  scheduler.start();
  t.after(() => scheduler.stop());
  await scheduler.awaitDrain();

  let invocation = h.scheduleService.listInvocations(schedule.id)[0];
  assert.equal(invocation.status, 'pending');
  assert.equal(invocation.waiting_reason, 'node_unreachable');
  assert.equal(sends.length, 0);

  h.nodeService.updateNode('node-a', { reachable: true });
  h.db.prepare("UPDATE operator_invocations SET run_after=datetime('now','-1 second') WHERE id=?").run(invocation.id);
  await scheduler.tick();

  invocation = h.scheduleService.listInvocations(schedule.id)[0];
  assert.equal(invocation.status, 'running');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].conversationId, `operator:${instance.id}`);
  assert.equal(sends[0].payload.codebaseProjectId, project.id);
});

test('scheduler marks ambiguous delivery failures uncertain and never replays them', async (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Hourly', prompt: 'Check', rule: { kind: 'interval', minutes: 60 },
  });
  h.scheduleService.runNow(schedule.id);
  let sends = 0;
  const scheduler = createOperatorScheduler({
    operatorScheduleService: h.scheduleService,
    conversationService: {
      sendMessage() {
        sends += 1;
        const err = new Error('transport closed after write');
        err.httpStatus = 502;
        throw err;
      },
    },
    managerRegistry: { getActiveRunId() { return 'run_top'; } },
    projectService: h.projectService,
    runService: h.runService,
    eventBus: h.eventBus,
    intervalMs: 999999,
  });
  scheduler.start();
  t.after(() => scheduler.stop());
  await scheduler.awaitDrain();
  await scheduler.tick();

  const row = h.scheduleService.listInvocations(schedule.id)[0];
  assert.equal(row.status, 'uncertain');
  assert.equal(sends, 1);
});

test('scheduler fails a structured permanent rejection even when its message says deliver message', async (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Permanent', prompt: 'Check', rule: { kind: 'interval', minutes: 60 },
  });
  h.scheduleService.runNow(schedule.id);
  const scheduler = createOperatorScheduler({
    operatorScheduleService: h.scheduleService,
    conversationService: {
      sendMessage() {
        const err = new Error('Failed to deliver message because manager rejected configuration');
        err.httpStatus = 502;
        err.code = 'OPERATOR_DELIVERY_REJECTED';
        err.retryable = false;
        throw err;
      },
    },
    managerRegistry: { getActiveRunId() { return 'run_top'; } },
    projectService: h.projectService,
    runService: h.runService,
    eventBus: h.eventBus,
    intervalMs: 999999,
  });
  scheduler.start();
  t.after(() => scheduler.stop());
  await scheduler.awaitDrain();

  const row = h.scheduleService.listInvocations(schedule.id)[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.waiting_reason, null);
});

test('scheduler retries only an explicitly retryable busy rejection', async (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Busy', prompt: 'Check', rule: { kind: 'interval', minutes: 60 },
  });
  h.scheduleService.runNow(schedule.id);
  const scheduler = createOperatorScheduler({
    operatorScheduleService: h.scheduleService,
    conversationService: {
      sendMessage() {
        const err = new Error('Manager is busy');
        err.httpStatus = 502;
        err.code = 'OPERATOR_BUSY';
        err.retryable = true;
        throw err;
      },
    },
    managerRegistry: { getActiveRunId() { return 'run_top'; } },
    projectService: h.projectService,
    runService: h.runService,
    eventBus: h.eventBus,
    intervalMs: 999999,
  });
  scheduler.start();
  t.after(() => scheduler.stop());
  await scheduler.awaitDrain();

  const row = h.scheduleService.listInvocations(schedule.id)[0];
  assert.equal(row.status, 'pending');
  assert.equal(row.waiting_reason, 'operator_busy');
});
