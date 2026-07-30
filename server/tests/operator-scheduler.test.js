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
const { createManagerRegistry } = require('../services/managerRegistry');
const { createManagerMessageQueueService } = require('../services/managerMessageQueueService');
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

test('due materialization coalesces missed intervals and a newer period supersedes stale pending work', (t) => {
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
  assert.equal(again.length, 1);
  assert.equal(again[0].scheduled_for, '2026-07-23T06:00:00.000Z');
  const first = h.db.prepare('SELECT status, waiting_reason FROM operator_invocations WHERE id=?').get(created[0].id);
  assert.deepEqual(first, { status: 'cancelled', waiting_reason: 'superseded' });
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
  assert.equal(next.length, 0);
  const skippedScheduleId = created[0].schedule_id === first.id ? second.id : first.id;
  const skipped = h.scheduleService.listInvocations(skippedScheduleId);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].status, 'cancelled');
  assert.equal(skipped[0].waiting_reason, 'operator_active_skipped');
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

// Seeds an invocation that reached `running` against a manager run which then
// SURVIVES the restart (boot resume leaves it 'running'), i.e. the state where
// no recovery evidence exists.
function seedRunningInvocation(h, instance, schedule, { at = '2026-07-23T00:00:01.000Z' } = {}) {
  h.scheduleService.runNow(schedule.id, new Date('2026-07-23T00:00:00.000Z'));
  const claimed = h.scheduleService.claimNext(new Date(at));
  h.scheduleService.markDelivering(claimed.id, claimed.claim_token);
  const managerRun = h.runService.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: `operator:${instance.id}`,
    operator_instance_id: instance.id,
    prompt: 'operator',
  });
  h.runService.updateRunStatus(managerRun.id, 'running', { force: true });
  h.scheduleService.markRunning(claimed.id, claimed.claim_token, managerRun.id);
  h.db.prepare('UPDATE operator_invocations SET started_at=? WHERE id=?').run(at, claimed.id);
  return { claimed, managerRun };
}

// Regression: narrowing the restart backstop to 'delivering' stranded these
// forever, and the per-Operator active UNIQUE index then blocked the Operator's
// every later invocation — across restarts. Asserting the status is not enough:
// what actually matters is that the OS-4 slot is free again.
test('restart releases a running invocation that has no recovery evidence at all', (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Lost completion', prompt: 'Check', rule: { kind: 'interval', minutes: 60 },
  });
  const { managerRun } = seedRunningInvocation(h, instance, schedule);

  const recovery = h.scheduleService.recoverAfterRestart(new Date('2026-07-23T00:00:30.000Z'));

  // The manager run resumed, and there is no queue row (migration 071 does not
  // backfill pre-existing invocations) — neither evidence path can fire.
  assert.equal(h.runService.getRun(managerRun.id).status, 'running');
  assert.deepEqual(recovery, { pending: 0, uncertain: 1 });
  const released = h.scheduleService.listInvocations(schedule.id)[0];
  assert.equal(released.status, 'uncertain');
  assert.equal(released.waiting_reason, 'restart_delivery_uncertain');
  assert.equal(
    h.scheduleService.runNow(schedule.id, new Date('2026-07-23T01:00:00.000Z')).status,
    'pending',
    'OS-4 must be free again after the restart backstop',
  );
});

// Pins the recoverAfterRestart ORDER: the evidence-based sweep must run before
// the unconditional backstop, or every dead manager run collapses into the
// generic reason and the operator loses the diagnosis.
test('restart prefers the specific manager-run reason over the generic backstop', (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Dead manager', prompt: 'Check', rule: { kind: 'interval', minutes: 60 },
  });
  const { managerRun } = seedRunningInvocation(h, instance, schedule);
  h.runService.updateRunStatus(managerRun.id, 'stopped', { force: true });

  const recovery = h.scheduleService.recoverAfterRestart(new Date('2026-07-23T00:10:00.000Z'));

  assert.deepEqual(recovery, { pending: 0, uncertain: 1 });
  const reconciled = h.scheduleService.listInvocations(schedule.id)[0];
  assert.equal(reconciled.status, 'uncertain');
  assert.equal(reconciled.waiting_reason, 'manager_run_terminal');
  assert.match(reconciled.last_error, /status stopped/);
});

test('manager slot replacement terminals the superseded run so its stale invocation can recover', (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Replaced manager', prompt: 'Check', rule: { kind: 'interval', minutes: 60 },
  });
  h.scheduleService.runNow(schedule.id, new Date('2026-07-23T00:00:00.000Z'));
  const claimed = h.scheduleService.claimNext(new Date('2026-07-23T00:00:01.000Z'));
  h.scheduleService.markDelivering(claimed.id, claimed.claim_token);
  const oldRun = h.runService.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: `operator:${instance.id}`,
    operator_instance_id: instance.id,
    prompt: 'old operator',
  });
  const replacementRun = h.runService.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: `operator:${instance.id}`,
    operator_instance_id: instance.id,
    prompt: 'replacement operator',
  });
  h.runService.updateRunStatus(oldRun.id, 'running', { force: true });
  h.runService.updateRunStatus(replacementRun.id, 'running', { force: true });
  h.scheduleService.markRunning(claimed.id, claimed.claim_token, oldRun.id);
  h.db.prepare('UPDATE operator_invocations SET started_at=? WHERE id=?')
    .run('2026-07-23T00:00:01.000Z', claimed.id);

  const registry = createManagerRegistry({ runService: h.runService });
  const adapter = {
    isSessionAlive: () => true,
    disposeSession: () => true,
  };
  registry.setActive(`operator:${instance.id}`, oldRun.id, adapter);
  registry.setActive(`operator:${instance.id}`, replacementRun.id, adapter);

  assert.equal(h.runService.getRun(oldRun.id).status, 'stopped');
  assert.equal(h.runService.getRun(replacementRun.id).status, 'running');
  const swept = h.scheduleService.sweepTerminalRunning(
    new Date('2026-07-23T00:10:00.000Z'),
    5 * 60 * 1000,
  );
  assert.equal(swept.length, 1);
  assert.equal(swept[0].status, 'uncertain');
  assert.equal(h.scheduleService.listInvocations(schedule.id)[0].waiting_reason, 'manager_run_terminal');
});

// Regression, driven through the REAL path rather than a pre-seeded queue row:
// codexAdapter persists non-terminal failures under the same event_type and
// invocationId as a completion. The queue's restart reconciler used to accept
// them, terminalizing the row under a reason the scheduler's recovery does not
// recognize — which, combined with a resumed manager run, stranded the
// invocation and shut that Operator down permanently.
test('a non-terminal turn failure neither closes the queue lane nor strands the invocation', (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Transient codex error', prompt: 'Check', rule: { kind: 'interval', minutes: 60 },
  });
  const { claimed, managerRun } = seedRunningInvocation(h, instance, schedule);

  // An in-flight scheduler queue row from before the restart: claimed by an
  // owner that no longer exists, lease long expired.
  h.db.prepare(`
    INSERT INTO manager_message_queue (
      id, conversation_id, idempotency_key, adapter_invocation_id,
      payload_json, display_text, status, available_at,
      claim_token, claimed_by, lease_expires_at, run_id
    ) VALUES (?,?,?,?,'{"text":"go"}','go','processing',0,?,?,?,?)
  `).run('msg_transient', `operator:${instance.id}`, `invocation:${claimed.id}`,
    claimed.id, 'tok_old', 'owner_before_restart', 1, managerRun.id);

  // codexAdapter's non-terminal failure — same event type, same invocation id.
  h.runService.addRunEvent(managerRun.id, 'mgr.turn_failed', JSON.stringify({
    summaryText: 'transient codex error',
    data: {
      kind: 'codex_error', errorKind: 'stream', message: 'boom',
      terminal: false, invocationId: claimed.id,
    },
  }));

  const queue = createManagerMessageQueueService({ db: h.db, eventBus: h.eventBus, tickMs: 100000 });
  t.after(() => queue.stop());
  assert.equal(queue.reconcileStaleClaims(), 1);

  const queueRow = h.db
    .prepare('SELECT status, terminal_reason FROM manager_message_queue WHERE id=?')
    .get('msg_transient');
  assert.equal(
    queueRow.terminal_reason,
    'restart_delivery_uncertain',
    'a non-terminal failure must not be mistaken for a completion',
  );

  h.scheduleService.recoverAfterRestart(new Date('2026-07-23T00:10:00.000Z'));
  assert.equal(h.scheduleService.listInvocations(schedule.id)[0].status, 'uncertain');
  assert.equal(
    h.scheduleService.runNow(schedule.id, new Date('2026-07-23T01:00:00.000Z')).status,
    'pending',
    'OS-4 must be free again',
  );
});

test('restart reconciles a persisted terminal turn event even while the manager run is active', (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Persisted completion', prompt: 'Check', rule: { kind: 'interval', minutes: 60 },
  });
  h.scheduleService.runNow(schedule.id, new Date('2026-07-23T00:00:00.000Z'));
  const claimed = h.scheduleService.claimNext(new Date('2026-07-23T00:00:01.000Z'));
  h.scheduleService.markDelivering(claimed.id, claimed.claim_token);
  const managerRun = h.runService.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: `operator:${instance.id}`,
    operator_instance_id: instance.id,
    prompt: 'operator',
  });
  h.runService.updateRunStatus(managerRun.id, 'running');
  h.scheduleService.markRunning(claimed.id, claimed.claim_token, managerRun.id);
  h.runService.addRunEvent(managerRun.id, 'mgr.turn_completed', JSON.stringify({
    data: { invocationId: claimed.id, terminal: true },
  }));

  const recovered = h.scheduleService.recoverAfterRestart(
    new Date('2026-07-23T00:01:00.000Z'),
  );
  assert.deepEqual(recovered, { pending: 0, uncertain: 0 });
  assert.equal(h.scheduleService.listInvocations(schedule.id)[0].status, 'completed');
});

test('scheduled reconciliation does not parse unrelated terminal history', (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Long manager run', prompt: 'Check', rule: { kind: 'interval', minutes: 60 },
  });
  const { claimed, managerRun } = seedRunningInvocation(h, instance, schedule);
  const historyPayload = JSON.stringify({
    historyMarker: 'schedule-unrelated-terminal-history',
    data: { invocationId: 'oinv_historical', terminal: true },
  });
  const insertEvent = h.db.prepare(`
    INSERT INTO run_events (run_id, event_type, payload_json)
    VALUES (?, 'mgr.turn_completed', ?)
  `);
  h.db.transaction(() => {
    for (let index = 0; index < 20_000; index += 1) {
      insertEvent.run(managerRun.id, historyPayload);
    }
  })();

  const originalParse = JSON.parse;
  let historicalPayloadParses = 0;
  JSON.parse = function countedParse(value, ...args) {
    if (value === historyPayload) historicalPayloadParses += 1;
    return originalParse.call(this, value, ...args);
  };
  try {
    assert.deepEqual(h.scheduleService.reconcilePersistedTerminalEvents(), []);
  } finally {
    JSON.parse = originalParse;
  }

  assert.equal(
    historicalPayloadParses,
    0,
    'unrelated persisted events must not cross the SQL/JavaScript boundary',
  );
  assert.equal(h.scheduleService.listInvocations(schedule.id)[0].status, 'running');

  insertEvent.run(managerRun.id, JSON.stringify({
    data: { invocationId: claimed.id, terminal: true },
  }));
  const reconciled = h.scheduleService.reconcilePersistedTerminalEvents();
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].status, 'completed');
});

test('same-invocation non-terminal failures cannot exhaust scheduled terminal reconciliation', (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Candidate exhaustion', prompt: 'Check', rule: { kind: 'interval', minutes: 60 },
  });
  const { claimed, managerRun } = seedRunningInvocation(h, instance, schedule);
  const insertEvent = h.db.prepare(`
    INSERT INTO run_events (run_id, event_type, payload_json)
    VALUES (?, ?, ?)
  `);
  insertEvent.run(managerRun.id, 'mgr.turn_completed', JSON.stringify({
    data: { invocationId: claimed.id, terminal: true },
  }));
  for (let index = 0; index < 255; index += 1) {
    insertEvent.run(managerRun.id, 'mgr.turn_failed', JSON.stringify({
      data: {
        kind: 'codex_error',
        invocationId: claimed.id,
        terminal: false,
      },
    }));
  }

  const reconciled = h.scheduleService.reconcilePersistedTerminalEvents();
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].status, 'completed');
  assert.equal(
    h.scheduleService.runNow(schedule.id, new Date('2026-07-23T01:00:00.000Z')).status,
    'pending',
    'the persisted target completion must release the OS-4 slot',
  );
});

test('a persisted numeric terminal flag cannot complete a running invocation', (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Numeric terminal', prompt: 'Check', rule: { kind: 'interval', minutes: 60 },
  });
  const { claimed, managerRun } = seedRunningInvocation(h, instance, schedule);
  h.runService.addRunEvent(managerRun.id, 'mgr.turn_completed', JSON.stringify({
    data: { invocationId: claimed.id, terminal: 1 },
  }));

  assert.deepEqual(h.scheduleService.reconcilePersistedTerminalEvents(), []);
  assert.equal(h.scheduleService.listInvocations(schedule.id)[0].status, 'running');
  assert.throws(
    () => h.scheduleService.runNow(schedule.id, new Date('2026-07-23T01:00:00.000Z')),
    /Operator already has an active invocation/,
    'the numeric flag must not release the OS-4 slot',
  );
});

test('eight newer duplicate-terminal candidates cannot hide an earlier scheduled terminal event', (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Duplicate terminal candidate', prompt: 'Check', rule: { kind: 'interval', minutes: 60 },
  });
  const { claimed, managerRun } = seedRunningInvocation(h, instance, schedule);
  const insertEvent = h.db.prepare(`
    INSERT INTO run_events (run_id, event_type, payload_json)
    VALUES (?, ?, ?)
  `);
  insertEvent.run(managerRun.id, 'mgr.turn_completed', JSON.stringify({
    data: { invocationId: claimed.id, terminal: true },
  }));
  for (let index = 0; index < 8; index += 1) {
    insertEvent.run(
      managerRun.id,
      'mgr.turn_failed',
      `{"summaryText":"must be ignored","data":{"invocationId":"${claimed.id}","terminal":true,"terminal":false}}`,
    );
  }

  const reconciled = h.scheduleService.reconcilePersistedTerminalEvents();
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].status, 'completed');
  assert.equal(h.scheduleService.getSchedule(schedule.id).consecutive_failures, 0);
  assert.equal(
    h.scheduleService.runNow(schedule.id, new Date('2026-07-23T01:00:00.000Z')).status,
    'pending',
    'the earlier terminal event must release the OS-4 slot',
  );
});

test('scheduled persisted reconciliation preserves first-terminal-event-wins ordering', (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'First terminal wins', prompt: 'Check', rule: { kind: 'interval', minutes: 60 },
  });
  const { claimed, managerRun } = seedRunningInvocation(h, instance, schedule);
  h.runService.addRunEvent(managerRun.id, 'mgr.turn_completed', JSON.stringify({
    data: { invocationId: claimed.id, terminal: true },
  }));
  h.runService.addRunEvent(managerRun.id, 'mgr.turn_failed', JSON.stringify({
    summaryText: 'later failure must lose',
    data: { invocationId: claimed.id, terminal: true },
  }));

  const reconciled = h.scheduleService.reconcilePersistedTerminalEvents();
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].status, 'completed');
  assert.equal(reconciled[0].last_error, null);
  assert.equal(h.scheduleService.getSchedule(schedule.id).consecutive_failures, 0);
  assert.equal(
    h.scheduleService.runNow(schedule.id, new Date('2026-07-23T01:00:00.000Z')).status,
    'pending',
    'the first completion must release the OS-4 slot without counting a failure',
  );
});

test('a non-coercible persisted failure summary fails and releases a scheduled invocation', (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Non-coercible summary', prompt: 'Check', rule: { kind: 'interval', minutes: 60 },
  });
  const { claimed, managerRun } = seedRunningInvocation(h, instance, schedule);
  h.runService.addRunEvent(managerRun.id, 'mgr.turn_failed', JSON.stringify({
    summaryText: { toString: null, valueOf: null },
    data: { invocationId: claimed.id, terminal: true },
  }));

  const reconciled = h.scheduleService.reconcilePersistedTerminalEvents();
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].status, 'failed');
  assert.equal(reconciled[0].last_error, '{"toString":null,"valueOf":null}');
  assert.equal(h.scheduleService.getSchedule(schedule.id).consecutive_failures, 1);
  assert.equal(
    h.scheduleService.runNow(schedule.id, new Date('2026-07-23T01:00:00.000Z')).status,
    'pending',
    'the terminal failure must release the OS-4 slot',
  );
});

test('persisted candidates skip malformed newer events and keep scanning', (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Malformed terminal candidate', prompt: 'Check', rule: { kind: 'interval', minutes: 60 },
  });
  const { claimed, managerRun } = seedRunningInvocation(h, instance, schedule);
  const insertEvent = h.db.prepare(`
    INSERT INTO run_events (run_id, event_type, payload_json)
    VALUES (?, ?, ?)
  `);
  insertEvent.run(managerRun.id, 'mgr.turn_completed', JSON.stringify({
    data: { invocationId: claimed.id, terminal: true },
  }));
  insertEvent.run(managerRun.id, 'mgr.turn_failed', '{broken');

  const reconciled = h.scheduleService.reconcilePersistedTerminalEvents();
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].status, 'completed');
});

test('restart correlation loss releases a stale invocation even when the manager resumed', (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Resumed manager', prompt: 'Check', rule: { kind: 'interval', minutes: 60 },
  });
  h.scheduleService.runNow(schedule.id, new Date('2026-07-23T00:00:00.000Z'));
  const claimed = h.scheduleService.claimNext(new Date('2026-07-23T00:00:01.000Z'));
  h.scheduleService.markDelivering(claimed.id, claimed.claim_token);
  const managerRun = h.runService.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: `operator:${instance.id}`,
    operator_instance_id: instance.id,
    prompt: 'resumed operator',
  });
  h.runService.updateRunStatus(managerRun.id, 'running', { force: true });
  h.scheduleService.markRunning(claimed.id, claimed.claim_token, managerRun.id);
  h.db.prepare('UPDATE operator_invocations SET started_at=? WHERE id=?')
    .run('2026-07-23T00:00:01.000Z', claimed.id);
  h.db.prepare(`
    INSERT INTO manager_message_queue (
      id, conversation_id, idempotency_key, adapter_invocation_id,
      payload_json, display_text, status, available_at, run_id, terminal_reason, failed_at
    ) VALUES (?, ?, ?, ?, '{}', '', 'failed', 0, ?, 'restart_delivery_uncertain', datetime('now'))
  `).run(
    'msg_restart_correlation',
    `operator:${instance.id}`,
    `invocation:${claimed.id}`,
    claimed.id,
    managerRun.id,
  );

  const swept = h.scheduleService.sweepTerminalRunning(
    new Date('2026-07-23T00:10:00.000Z'),
    5 * 60 * 1000,
  );
  assert.equal(h.runService.getRun(managerRun.id).status, 'running');
  assert.equal(swept.length, 1);
  assert.equal(swept[0].status, 'uncertain');
  assert.equal(swept[0].waiting_reason, 'restart_delivery_uncertain');
  assert.match(swept[0].last_error, /correlation was lost/);
});

test('unreachable manager slot releases a stale invocation when its queue row records session end', (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Unreachable manager', prompt: 'Check', rule: { kind: 'interval', minutes: 60 },
  });
  h.scheduleService.runNow(schedule.id, new Date('2026-07-23T00:00:00.000Z'));
  const claimed = h.scheduleService.claimNext(new Date('2026-07-23T00:00:01.000Z'));
  h.scheduleService.markDelivering(claimed.id, claimed.claim_token);
  const managerRun = h.runService.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: `operator:${instance.id}`,
    operator_instance_id: instance.id,
    prompt: 'unreachable operator',
  });
  h.runService.updateRunStatus(managerRun.id, 'running', { force: true });
  h.scheduleService.markRunning(claimed.id, claimed.claim_token, managerRun.id);
  h.db.prepare('UPDATE operator_invocations SET started_at=? WHERE id=?')
    .run('2026-07-23T00:00:01.000Z', claimed.id);
  h.db.prepare(`
    INSERT INTO manager_message_queue (
      id, conversation_id, idempotency_key, adapter_invocation_id,
      payload_json, display_text, status, available_at, run_id, terminal_reason, failed_at
    ) VALUES (?, ?, ?, ?, '{}', '', 'failed', 0, ?, 'session_ended_during_processing', datetime('now'))
  `).run(
    'msg_session_ended',
    `operator:${instance.id}`,
    `invocation:${claimed.id}`,
    claimed.id,
    managerRun.id,
  );

  const swept = h.scheduleService.sweepTerminalRunning(
    new Date('2026-07-23T00:10:00.000Z'),
    5 * 60 * 1000,
  );
  assert.equal(h.runService.getRun(managerRun.id).status, 'running');
  assert.equal(swept.length, 1);
  assert.equal(swept[0].status, 'uncertain');
  assert.equal(swept[0].waiting_reason, 'session_ended_during_processing');
  assert.match(swept[0].last_error, /session ended/);
});

test('terminal manager-run audit waits for the running staleness threshold', (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Young terminal', prompt: 'Check', rule: { kind: 'interval', minutes: 60 },
  });
  h.scheduleService.runNow(schedule.id, new Date('2026-07-23T00:00:00.000Z'));
  const claimed = h.scheduleService.claimNext(new Date('2026-07-23T00:00:01.000Z'));
  h.scheduleService.markDelivering(claimed.id, claimed.claim_token);
  const managerRun = h.runService.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: `operator:${instance.id}`,
    operator_instance_id: instance.id,
    prompt: 'operator',
  });
  h.runService.updateRunStatus(managerRun.id, 'running');
  h.scheduleService.markRunning(claimed.id, claimed.claim_token, managerRun.id);
  h.db.prepare('UPDATE operator_invocations SET started_at=? WHERE id=?')
    .run('2026-07-23T00:09:00.000Z', claimed.id);
  h.runService.updateRunStatus(managerRun.id, 'failed');
  h.runService.deleteRun(managerRun.id);

  assert.deepEqual(
    h.scheduleService.sweepTerminalRunning(new Date('2026-07-23T00:10:00.000Z'), 5 * 60 * 1000),
    [],
  );
  assert.equal(h.scheduleService.listInvocations(schedule.id)[0].status, 'running');
  const swept = h.scheduleService.sweepTerminalRunning(
    new Date('2026-07-23T00:14:01.000Z'),
    5 * 60 * 1000,
  );
  assert.equal(swept.length, 1);
  assert.equal(swept[0].status, 'uncertain');
  assert.match(swept[0].last_error, /status missing/);
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

// The delivery deadline has ONE owner: the durable queue. The scheduler used to
// arm a second timer over the same await, but because the queue arms its timer
// synchronously inside drainConversation — before sendMessage even returns —
// the queue always won and the scheduler's branch was unreachable. This wires
// BOTH layers so the real interaction is what gets asserted.
test('a hung delivery times out uncertain through the real queue and never reaches the adapter', async (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h, { name: 'Hung folder' });
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Hung', prompt: 'Hang', rule: { kind: 'interval', minutes: 60 },
  });
  h.scheduleService.runNow(schedule.id, new Date('2026-07-23T00:00:00.000Z'));
  const top = h.runService.createRun({
    is_manager: true, manager_layer: 'top', conversation_id: 'top', prompt: 'top',
  });

  const queue = createManagerMessageQueueService({
    db: h.db, eventBus: h.eventBus, tickMs: 100000, immediateDispatchTimeoutMs: 25,
  });
  t.after(() => queue.stop());
  let releaseColdSpawn;
  const adapterCalls = [];
  queue.setDispatcher(async (_conversationId, _payload, invocationId, control) => {
    // Stands in for a cold spawn that outruns the deadline.
    await new Promise((resolve) => { releaseColdSpawn = resolve; });
    if (!control.canDispatch()) {
      const err = new Error('delivery fenced before adapter');
      err.code = 'OPERATOR_DELIVERY_CANCELLED';
      throw err;
    }
    adapterCalls.push(invocationId);
    return { status: 'sent', target: { kind: 'pm', runId: top.id } };
  });

  const scheduler = createOperatorScheduler({
    operatorScheduleService: h.scheduleService,
    conversationService: {
      sendMessage(conversationId, { text, invocationId }) {
        return queue.enqueue(conversationId, { text }, {
          idempotencyKey: `invocation:${invocationId}`,
          adapterInvocationId: invocationId,
          requireImmediate: true,
        });
      },
    },
    managerRegistry: { getActiveRunId() { return top.id; } },
    projectService: h.projectService,
    runService: h.runService,
    clock: () => new Date('2026-07-23T00:00:02.000Z'),
  });

  await scheduler.tick();

  const hung = h.scheduleService.listInvocations(schedule.id)[0];
  assert.equal(hung.status, 'uncertain');
  assert.match(hung.last_error, /timed out after 25ms/);
  assert.equal(
    h.scheduleService.runNow(schedule.id, new Date('2026-07-23T01:00:00.000Z')).status,
    'pending',
    'the timeout must release the Operator single-flight slot',
  );

  // The abandoned cold spawn finishes late: the durable claim fence must keep
  // it out of the adapter, or the turn runs twice.
  releaseColdSpawn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(adapterCalls, [], 'a timed-out delivery must never reach the adapter');
});

// Isolation half of #458: one hung delivery must not hold up other Operators.
test('a hung delivery does not stop another Operator from being delivered in the same tick', async (t) => {
  const h = harness(t);
  const first = createMappedOperator(h, { name: 'Hung folder' });
  const second = createMappedOperator(h, { name: 'Healthy folder' });
  const hungSchedule = h.scheduleService.createSchedule(first.instance.id, {
    name: 'Hung', prompt: 'Hang', rule: { kind: 'interval', minutes: 60 },
  });
  const healthySchedule = h.scheduleService.createSchedule(second.instance.id, {
    name: 'Healthy', prompt: 'Proceed', rule: { kind: 'interval', minutes: 60 },
  });
  h.scheduleService.runNow(hungSchedule.id, new Date('2026-07-23T00:00:00.000Z'));
  h.scheduleService.runNow(healthySchedule.id, new Date('2026-07-23T00:00:01.000Z'));
  const top = h.runService.createRun({
    is_manager: true, manager_layer: 'top', conversation_id: 'top', prompt: 'top',
  });
  const healthyRun = h.runService.createRun({
    is_manager: true, manager_layer: 'operator',
    conversation_id: `operator:${second.instance.id}`,
    operator_instance_id: second.instance.id, parent_run_id: top.id,
    prompt: 'healthy operator',
  });

  let resolveHung;
  const sends = [];
  const scheduler = createOperatorScheduler({
    operatorScheduleService: h.scheduleService,
    conversationService: {
      sendMessage(conversationId) {
        sends.push(conversationId);
        if (conversationId === `operator:${first.instance.id}`) {
          return new Promise((resolve) => { resolveHung = resolve; });
        }
        return { status: 'sent', target: { kind: 'pm', runId: healthyRun.id } };
      },
    },
    managerRegistry: { getActiveRunId() { return top.id; } },
    projectService: h.projectService,
    runService: h.runService,
    clock: () => new Date('2026-07-23T00:00:02.000Z'),
  });

  const tick = scheduler.tick();
  // The healthy Operator is delivered on its own lane while the first is stuck.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    h.scheduleService.listInvocations(healthySchedule.id)[0].status,
    'running',
    'a hung lane must not hold up another Operator',
  );
  assert.deepEqual(sends, [
    `operator:${first.instance.id}`,
    `operator:${second.instance.id}`,
  ]);

  resolveHung({ status: 'sent', target: { kind: 'pm', runId: healthyRun.id } });
  await tick;
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

// claimNext opens a BEGIN IMMEDIATE and can throw. If that escaped the lane,
// Promise.all would reject the tick while siblings were still delivering,
// tick()'s finally would release `inflight`, and the next tick would stack a
// fresh set of lanes on top of the in-flight ones — silently exceeding the cap.
test('a claim failure ends only its own lane and never releases the tick early', async (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Claim race', prompt: 'Check', rule: { kind: 'interval', minutes: 60 },
  });
  h.scheduleService.runNow(schedule.id, new Date('2026-07-23T00:00:00.000Z'));
  const top = h.runService.createRun({
    is_manager: true, manager_layer: 'top', conversation_id: 'top', prompt: 'top',
  });

  let claims = 0;
  let releaseDelivery;
  let deliverySettled = false;
  const scheduleService = {
    ...h.scheduleService,
    claimNext(now) {
      claims += 1;
      // Second lane races the first into BEGIN IMMEDIATE and loses.
      if (claims === 2) throw new Error('database is locked');
      return h.scheduleService.claimNext(now);
    },
  };
  const scheduler = createOperatorScheduler({
    operatorScheduleService: scheduleService,
    conversationService: {
      sendMessage() {
        return new Promise((resolve) => {
          releaseDelivery = () => {
            deliverySettled = true;
            resolve({ status: 'sent', target: { kind: 'pm', runId: top.id } });
          };
        });
      },
    },
    managerRegistry: { getActiveRunId() { return top.id; } },
    projectService: h.projectService,
    runService: h.runService,
    clock: () => new Date('2026-07-23T00:00:02.000Z'),
  });

  const tick = scheduler.tick();
  let resolvedEarly = false;
  await Promise.race([
    tick.then(() => { resolvedEarly = true; }),
    new Promise((resolve) => setTimeout(resolve, 50)),
  ]);
  assert.equal(deliverySettled, false, 'the surviving lane is still delivering');
  assert.equal(resolvedEarly, false, 'the tick must not resolve while a lane is in flight');

  releaseDelivery();
  await tick;
});
