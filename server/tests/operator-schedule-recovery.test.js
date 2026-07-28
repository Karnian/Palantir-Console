'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const { createApp } = require('../app');
const { createDatabase } = require('../db/database');
const { createEventBus } = require('../services/eventBus');
const { createProjectService } = require('../services/projectService');
const { createRunService } = require('../services/runService');
const { createOperatorInstanceService } = require('../services/operatorInstanceService');
const {
  CLAIM_LEASE_MS,
  createOperatorScheduleService,
} = require('../services/operatorScheduleService');
const {
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  RETRY_JITTER_RATIO,
  createOperatorScheduler,
  retryDelayMs,
} = require('../services/operatorScheduler');

const ACTIVE_SQL = `
  SELECT COUNT(*) AS count
    FROM operator_invocations
   WHERE operator_instance_id=?
     AND status IN ('pending','claimed','delivering','running')
`;

function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-operator-recovery-'));
  const dbPath = path.join(dir, 'test.db');
  const handle = createDatabase(dbPath);
  handle.migrate();
  t.after(() => {
    try { handle.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { db } = handle;
  const eventBus = createEventBus();
  const runService = createRunService(db, eventBus);
  const projectService = createProjectService(db);
  const instanceService = createOperatorInstanceService(db, { runService });
  const scheduleService = createOperatorScheduleService(db, { eventBus, runService, logger() {} });
  db.prepare(`
    INSERT INTO operator_profiles (id, name, capabilities_json, is_private)
    VALUES ('op_recovery', 'Recovery Operator', '[]', 0)
  `).run();
  return {
    dbPath,
    db,
    eventBus,
    runService,
    projectService,
    instanceService,
    scheduleService,
  };
}

function createMappedOperator(h, suffix = cryptoSuffix()) {
  const project = h.projectService.createProject({
    name: `Recovery folder ${suffix}`,
    directory: `/tmp/recovery-${suffix}`,
  });
  const instance = h.instanceService.createInstance({
    profile_id: 'op_recovery',
    display_name: `Recovery Operator ${suffix}`,
    primary_project_id: project.id,
  });
  return { project, instance };
}

function cryptoSuffix() {
  return Math.random().toString(16).slice(2);
}

function createHourly(h, instance, now = new Date('2026-07-01T00:00:00.000Z'), name = 'Hourly') {
  return h.scheduleService.createSchedule(instance.id, {
    name,
    prompt: `Run ${name}`,
    rule: { kind: 'interval', minutes: 60 },
    timezone: 'UTC',
  }, now);
}

function invocations(h, scheduleId) {
  return h.db.prepare(`
    SELECT * FROM operator_invocations
     WHERE schedule_id=?
     ORDER BY scheduled_for ASC, created_at ASC, id ASC
  `).all(scheduleId);
}

function assertSingleFlight(h, instanceId) {
  assert.ok(
    Number(h.db.prepare(ACTIVE_SQL).get(instanceId).count) <= 1,
    `Operator ${instanceId} must have at most one active invocation`,
  );
}

function schedulerFor(h, overrides = {}) {
  return createOperatorScheduler({
    operatorScheduleService: h.scheduleService,
    conversationService: { sendMessage() { throw new Error('unexpected delivery'); } },
    managerRegistry: { getActiveRunId() { return null; } },
    projectService: h.projectService,
    runService: h.runService,
    eventBus: h.eventBus,
    ...overrides,
  });
}

test('a newer scheduled period supersedes a Top-unavailable pending invocation', async (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = createHourly(h, instance);
  const firstTime = new Date('2026-07-01T01:00:00.000Z');
  const [first] = h.scheduleService.materializeDue(firstTime);
  const claimed = h.scheduleService.claimNext(firstTime);
  await schedulerFor(h, { clock: () => firstTime, random: () => 0.5 }).deliver(claimed);
  assert.equal(h.scheduleService.listInvocations(schedule.id)[0].waiting_reason, 'top_unavailable');

  const [second] = h.scheduleService.materializeDue(new Date('2026-07-01T02:00:00.000Z'));
  assert.ok(second);
  assert.equal(second.scheduled_for, '2026-07-01T02:00:00.000Z');
  const rows = invocations(h, schedule.id);
  assert.deepEqual(
    rows.map((row) => [row.id, row.status, row.waiting_reason]),
    [
      [first.id, 'cancelled', 'superseded'],
      [second.id, 'pending', null],
    ],
  );
  assertSingleFlight(h, instance.id);
});

test('delivering and running turns remain active while each new period gets a durable skip row', (t) => {
  const h = harness(t);
  for (const status of ['delivering', 'running']) {
    const { instance } = createMappedOperator(h, status);
    const schedule = createHourly(h, instance, new Date('2026-07-01T00:00:00.000Z'), status);
    const [first] = h.scheduleService.materializeDue(new Date('2026-07-01T01:00:00.000Z'));
    const claimed = h.scheduleService.claimNext(new Date('2026-07-01T01:00:00.000Z'));
    h.scheduleService.markDelivering(claimed.id, claimed.claim_token);
    if (status === 'running') {
      const run = h.runService.createRun({
        is_manager: true,
        manager_layer: 'operator',
        conversation_id: `operator:${instance.id}`,
        operator_instance_id: instance.id,
        prompt: 'scheduled',
      });
      h.scheduleService.markRunning(claimed.id, claimed.claim_token, run.id);
    }

    assert.equal(h.scheduleService.materializeDue(new Date('2026-07-01T02:00:00.000Z')).length, 0);
    const rows = invocations(h, schedule.id);
    assert.equal(rows[0].id, first.id);
    assert.equal(rows[0].status, status);
    assert.equal(rows[1].status, 'cancelled');
    assert.equal(rows[1].waiting_reason, 'operator_active_skipped');
    assert.equal(rows[1].scheduled_for, '2026-07-01T02:00:00.000Z');
    assertSingleFlight(h, instance.id);
  }
});

test('superseding a claimed row fences its claimant before sendMessage', async (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = createHourly(h, instance);
  h.scheduleService.materializeDue(new Date('2026-07-01T01:00:00.000Z'));
  const staleClaim = h.scheduleService.claimNext(new Date('2026-07-01T01:00:00.000Z'));
  h.scheduleService.materializeDue(new Date('2026-07-01T02:00:00.000Z'));

  let sends = 0;
  const scheduler = schedulerFor(h, {
    conversationService: {
      sendMessage() {
        sends += 1;
        return { target: { runId: 'must_not_exist' } };
      },
    },
    managerRegistry: { getActiveRunId() { return 'run_top'; } },
  });
  await assert.rejects(() => scheduler.deliver(staleClaim), /claim was lost before delivery/);
  assert.equal(sends, 0);
  assert.equal(
    h.db.prepare('SELECT waiting_reason FROM operator_invocations WHERE id=?').get(staleClaim.id).waiting_reason,
    'superseded',
  );
  assert.equal(invocations(h, schedule.id).at(-1).status, 'pending');
  assertSingleFlight(h, instance.id);
});

test('a scheduled period never supersedes a manual_run_now invocation', (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = createHourly(h, instance);
  const manual = h.scheduleService.runNow(schedule.id, new Date('2026-07-01T00:30:00.000Z'));

  assert.equal(h.scheduleService.materializeDue(new Date('2026-07-01T01:00:00.000Z')).length, 0);
  const rows = invocations(h, schedule.id);
  assert.equal(rows.find((row) => row.id === manual.id).status, 'pending');
  const skip = rows.find((row) => row.scheduled_for === '2026-07-01T01:00:00.000Z');
  assert.equal(skip.status, 'cancelled');
  assert.equal(skip.waiting_reason, 'operator_active_skipped');
  assertSingleFlight(h, instance.id);
});

test('an overdue invocation materialized after downtime cannot expire before its first attempt', (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Downtime once',
    prompt: 'Run after downtime',
    rule: { kind: 'once', at: '2026-07-01T01:00:00.000Z' },
    timezone: 'UTC',
  }, new Date('2026-07-01T00:00:00.000Z'));
  const [overdue] = h.scheduleService.materializeDue(new Date('2026-07-03T01:00:00.000Z'));
  assert.equal(overdue.attempts, 0);

  assert.deepEqual(h.scheduleService.sweepExpired(new Date('2026-07-03T01:00:01.000Z')), []);
  assert.equal(h.db.prepare('SELECT status FROM operator_invocations WHERE id=?').get(overdue.id).status, 'pending');
  assertSingleFlight(h, instance.id);
});

test('attempted once and manual invocations expire after the conservative 24-hour backstop', (t) => {
  const h = harness(t);
  for (const source of ['once', 'manual_run_now']) {
    const { instance } = createMappedOperator(h, source);
    let invocation;
    if (source === 'once') {
      const schedule = h.scheduleService.createSchedule(instance.id, {
        name: 'Once',
        prompt: 'Once',
        rule: { kind: 'once', at: '2026-07-01T01:00:00.000Z' },
        timezone: 'UTC',
      }, new Date('2026-07-01T00:00:00.000Z'));
      [invocation] = h.scheduleService.materializeDue(new Date('2026-07-01T01:00:00.000Z'));
      assert.equal(invocation.schedule_id, schedule.id);
    } else {
      const schedule = createHourly(h, instance);
      invocation = h.scheduleService.runNow(schedule.id, new Date('2026-07-01T01:00:00.000Z'));
    }
    const claimed = h.scheduleService.claimNext(new Date('2026-07-01T01:00:00.000Z'));
    h.scheduleService.releaseClaim(claimed.id, claimed.claim_token, {
      waitingReason: 'top_unavailable',
      delayMs: RETRY_BASE_MS,
      now: new Date('2026-07-01T01:00:00.000Z'),
    });
    const expired = h.scheduleService.sweepExpired(new Date('2026-07-02T01:00:00.001Z'));
    assert.equal(expired.length, 1);
    assert.equal(expired[0].id, invocation.id);
    assert.equal(expired[0].status, 'cancelled');
    assert.equal(expired[0].waiting_reason, 'expired');
    assert.ok(expired[0].completed_at);
    assertSingleFlight(h, instance.id);
  }
});

test('expiry sweep runs before materialization in every scheduler tick', async () => {
  const calls = [];
  const service = {
    sweepExpired(now) {
      assert.equal(now.toISOString(), '2026-07-02T01:00:00.000Z');
      calls.push('sweep');
    },
    materializeDue(now) {
      assert.equal(now.toISOString(), '2026-07-02T01:00:00.000Z');
      calls.push('materialize');
    },
    claimNext() {
      calls.push('claim');
      return null;
    },
  };
  const scheduler = createOperatorScheduler({
    operatorScheduleService: service,
    clock: () => new Date('2026-07-02T01:00:00.000Z'),
  });
  await scheduler.tick();
  assert.deepEqual(calls, ['sweep', 'materialize', 'claim']);
});

const workerSource = `
  'use strict';
  const { parentPort, workerData } = require('node:worker_threads');
  const { createDatabase } = require(workerData.databaseModule);
  const { createOperatorScheduleService } = require(workerData.scheduleModule);
  const handle = createDatabase(workerData.dbPath);
  const service = createOperatorScheduleService(handle.db, { logger() {} });
  const barrier = new Int32Array(workerData.barrier);
  parentPort.postMessage({ ready: true });
  Atomics.wait(barrier, 0, 0);
  try {
    const value = service[workerData.operation](new Date(workerData.now));
    parentPort.postMessage({ ok: true, count: Array.isArray(value) ? value.length : Number(Boolean(value)) });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error.message, code: error.code || null });
  } finally {
    handle.close();
  }
`;

async function raceOperations(h, operations, now) {
  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const databaseModule = require.resolve('../db/database');
  const scheduleModule = require.resolve('../services/operatorScheduleService');
  const workers = operations.map((operation) => new Worker(workerSource, {
    eval: true,
    workerData: { barrier, dbPath: h.dbPath, databaseModule, scheduleModule, operation, now },
  }));
  const ready = workers.map((worker) => new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (!message.ready) return;
      worker.off('error', reject);
      resolve();
    };
    worker.once('error', reject);
    worker.on('message', onMessage);
  }));
  await Promise.all(ready);
  const results = workers.map((worker) => new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message.ready) return;
      worker.off('error', reject);
      resolve(message);
    };
    worker.once('error', reject);
    worker.on('message', onMessage);
  }));
  Atomics.store(new Int32Array(barrier), 0, 1);
  Atomics.notify(new Int32Array(barrier), 0, workers.length);
  const values = await Promise.all(results);
  await Promise.all(workers.map((worker) => worker.terminate()));
  return values;
}

test('OS-4 holds across two-connection materialize/materialize and materialize/claim races', async (t) => {
  const h = harness(t);
  const first = createMappedOperator(h, 'materialize-race');
  createHourly(h, first.instance, new Date('2026-07-01T00:00:00.000Z'), 'A');
  createHourly(h, first.instance, new Date('2026-07-01T00:00:00.000Z'), 'B');
  const materializeRace = await raceOperations(
    h,
    ['materializeDue', 'materializeDue'],
    '2026-07-01T01:00:00.000Z',
  );
  assert.ok(materializeRace.every((result) => result.ok), JSON.stringify(materializeRace));
  assertSingleFlight(h, first.instance.id);

  const second = createMappedOperator(h, 'claim-race');
  createHourly(h, second.instance, new Date('2026-07-01T00:00:00.000Z'), 'Claim race');
  h.scheduleService.materializeDue(new Date('2026-07-01T01:00:00.000Z'));
  const schedule = h.db.prepare(`
    SELECT * FROM operator_schedules WHERE operator_instance_id=?
  `).get(second.instance.id);
  h.db.prepare('UPDATE operator_schedules SET next_fire_at=? WHERE id=?')
    .run('2026-07-01T02:00:00.000Z', schedule.id);
  const claimRace = await raceOperations(
    h,
    ['materializeDue', 'claimNext'],
    '2026-07-01T02:00:00.000Z',
  );
  assert.ok(claimRace.every((result) => result.ok), JSON.stringify(claimRace));
  assertSingleFlight(h, second.instance.id);
});

test('replacement insert failure rolls back supersede and preserves the previous OS-4 owner', (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = createHourly(h, instance);
  const [first] = h.scheduleService.materializeDue(new Date('2026-07-01T01:00:00.000Z'));
  h.db.exec(`
    CREATE TRIGGER fail_operator_replacement
    BEFORE INSERT ON operator_invocations
    WHEN NEW.scheduled_for='2026-07-01T02:00:00.000Z'
    BEGIN
      SELECT RAISE(ABORT, 'replacement insert blocked');
    END
  `);

  assert.equal(h.scheduleService.materializeDue(new Date('2026-07-01T02:00:00.000Z')).length, 0);
  const previous = h.db.prepare(`
    SELECT status, waiting_reason FROM operator_invocations WHERE id=?
  `).get(first.id);
  assert.deepEqual(previous, { status: 'pending', waiting_reason: null });
  assert.equal(h.scheduleService.getSchedule(schedule.id).next_fire_at, '2026-07-01T02:00:00.000Z');
  assertSingleFlight(h, instance.id);
});

test('materialization logs ConflictError instead of silently swallowing it', (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = createHourly(h, instance);
  h.db.prepare(`
    INSERT INTO operator_invocations (
      id, schedule_id, operator_instance_id, schedule_revision, source,
      prompt_snapshot, codebase_project_id, rule_snapshot_json,
      scheduled_for, status, run_after, waiting_reason, completed_at
    ) VALUES (
      'oinv_conflict_log', ?, ?, 1, 'scheduled',
      'already recorded', ?, '{"kind":"interval","minutes":60}',
      '2026-07-01T01:00:00.000Z', 'cancelled',
      '2026-07-01T01:00:00.000Z', 'operator_active_skipped', datetime('now')
    )
  `).run(schedule.id, instance.id, schedule.codebase_project_id);
  const logs = [];
  const service = createOperatorScheduleService(h.db, { logger: (message) => logs.push(message) });

  assert.equal(service.materializeDue(new Date('2026-07-01T01:00:00.000Z')).length, 0);
  assert.equal(service.getSchedule(schedule.id).next_fire_at, '2026-07-01T01:00:00.000Z');
  assert.ok(logs.some((line) => (
    line.includes(schedule.id) && line.includes('Operator already has an active invocation')
  )));
});

test('retry delay grows with attempts, stays jittered, and never exceeds 15 minutes', async (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = createHourly(h, instance);
  h.scheduleService.runNow(schedule.id, new Date('2026-07-01T00:00:00.000Z'));
  let now = new Date('2026-07-01T00:00:00.000Z');
  const scheduler = schedulerFor(h, { clock: () => now, random: () => 0.5 });
  const delays = [];

  for (let attempt = 1; attempt <= 7; attempt += 1) {
    const claimed = h.scheduleService.claimNext(now);
    assert.equal(claimed.attempts, attempt);
    const released = await scheduler.deliver(claimed);
    const delay = new Date(released.run_after).getTime() - now.getTime();
    delays.push(delay);
    const lower = Math.round(Math.min(RETRY_CAP_MS, RETRY_BASE_MS * (2 ** (attempt - 1)))
      * (1 - RETRY_JITTER_RATIO));
    assert.ok(delay >= lower);
    assert.ok(delay <= RETRY_CAP_MS);
    now = new Date(released.run_after);
  }
  assert.deepEqual(delays, [60000, 120000, 240000, 480000, 900000, 900000, 900000]);
  assert.equal(retryDelayMs(1, () => 0), 48000);
  assert.equal(retryDelayMs(1, () => 1), 72000);
  assert.equal(retryDelayMs(20, () => 1), RETRY_CAP_MS);
  assertSingleFlight(h, instance.id);
});

test('two schedules retain a durable execution-or-skip record for three periods each', (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const scheduleA = createHourly(h, instance, new Date('2026-07-01T00:00:00.000Z'), 'A');
  const scheduleB = createHourly(h, instance, new Date('2026-07-01T00:00:00.000Z'), 'B');

  for (const hour of [1, 2, 3]) {
    const now = new Date(`2026-07-01T0${hour}:00:00.000Z`);
    const created = h.scheduleService.materializeDue(now);
    assert.equal(created.length, 1);
    h.db.prepare(`
      UPDATE operator_invocations
         SET status='completed', completed_at=datetime('now')
       WHERE id=?
    `).run(created[0].id);
    assertSingleFlight(h, instance.id);
  }

  const rowsA = invocations(h, scheduleA.id);
  const rowsB = invocations(h, scheduleB.id);
  assert.equal(rowsA.length, 3);
  assert.equal(rowsB.length, 3);
  const accepted = rowsA.every((row) => row.status === 'completed') ? rowsA : rowsB;
  const skipped = accepted === rowsA ? rowsB : rowsA;
  assert.ok(accepted.every((row) => row.status === 'completed'));
  assert.ok(skipped.every(
    (row) => row.status === 'cancelled' && row.waiting_reason === 'operator_active_skipped',
  ));
});

test('schedule API data exposes durable waiting details after restart and event-stream reconnect', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-recovery-api-'));
  const dbPath = path.join(root, 'test.db');
  const options = {
    storageRoot: path.join(root, 'storage'),
    fsRoot: root,
    dbPath,
    authToken: 'recovery-secret',
    authResolverOpts: { hasKeychain: () => false },
    operatorSchedulerEnabled: false,
  };
  let app = createApp(options);
  t.after(async () => {
    if (app) await app.shutdown();
    await fsp.rm(root, { recursive: true, force: true });
  });
  app.services._rawDb.prepare(`
    INSERT INTO operator_profiles (id, name, capabilities_json, is_private)
    VALUES ('op_recovery_api', 'Recovery API', '[]', 0)
  `).run();
  const project = app.services.projectService.createProject({ name: 'API folder', directory: '/tmp/api' });
  const instance = app.services.operatorInstanceService.createInstance({
    profile_id: 'op_recovery_api',
    primary_project_id: project.id,
  });
  const schedule = app.services.operatorScheduleService.createSchedule(instance.id, {
    name: 'API hourly',
    prompt: 'Inspect',
    rule: { kind: 'interval', minutes: 60 },
    timezone: 'UTC',
  }, new Date('2026-07-01T00:00:00.000Z'));
  app.services.operatorScheduleService.materializeDue(new Date('2026-07-01T01:00:00.000Z'));
  const claimed = app.services.operatorScheduleService.claimNext(new Date('2026-07-01T01:00:00.000Z'));
  app.services.operatorScheduleService.releaseClaim(claimed.id, claimed.claim_token, {
    waitingReason: 'top_unavailable',
    delayMs: RETRY_BASE_MS,
    now: new Date('2026-07-01T01:00:00.000Z'),
  });

  const assertSchedule = (value) => {
    assert.equal(value.waiting_reason, 'top_unavailable');
    assert.equal(value.attempts, 1);
    assert.equal(value.active_invocation_id, claimed.id);
  };
  assertSchedule(app.services.operatorScheduleService.getSchedule(schedule.id));

  await app.shutdown();
  app = createApp(options);
  const unsubscribe = app.services.eventBus.subscribe(() => {});
  unsubscribe();
  const reconnect = app.services.eventBus.subscribe(() => {});
  const after = app.services.operatorScheduleService.getSchedule(schedule.id);
  reconnect();
  assertSchedule(after);
  const list = app.services.operatorScheduleService.listSchedules(instance.id);
  assert.equal(list[0].waiting_reason, 'top_unavailable');
  assert.equal(list[0].attempts, 1);
});

test('expired claimed rows require both age and an expired claim lease', (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const schedule = createHourly(h, instance);
  const invocation = h.scheduleService.runNow(schedule.id, new Date('2026-07-01T00:00:00.000Z'));
  h.scheduleService.claimNext(new Date('2026-07-01T00:00:00.000Z'));
  const now = new Date('2026-07-02T00:00:00.001Z');

  h.db.prepare('UPDATE operator_invocations SET locked_at=? WHERE id=?')
    .run(now.toISOString(), invocation.id);
  assert.equal(h.scheduleService.sweepExpired(now).length, 0);
  h.db.prepare('UPDATE operator_invocations SET locked_at=? WHERE id=?')
    .run(new Date(now.getTime() - CLAIM_LEASE_MS - 1).toISOString(), invocation.id);
  assert.equal(h.scheduleService.sweepExpired(now).length, 1);
  assert.equal(h.db.prepare('SELECT waiting_reason FROM operator_invocations WHERE id=?').get(invocation.id).waiting_reason, 'expired');
  assertSingleFlight(h, instance.id);
});

// codex adversarial review (BLOCKER): the daily cap must be decided BEFORE the
// active invocation is touched. Superseding first and then returning on the cap
// commits the cancellation without a replacement — the older occurrence is
// destroyed, this one is never created, and the cursor has already advanced
// past both. Reproduced against the pre-fix code.
test('a capped schedule never destroys another schedule\'s waiting invocation', (t) => {
  const h = harness(t);
  const { instance } = createMappedOperator(h);
  const base = new Date('2026-07-01T00:00:00.000Z');
  const scheduleA = createHourly(h, instance, base, 'A');
  const scheduleB = createHourly(h, instance, base, 'B');

  // Whichever schedule wins the Operator's single active slot becomes the
  // holder; the other one is the capped peer. Which one wins is decided by
  // (next_fire_at, id) ordering and is not what this test is about.
  h.scheduleService.materializeDue(new Date('2026-07-01T01:00:00.000Z'));
  const active = h.db.prepare(`
    SELECT * FROM operator_invocations
     WHERE operator_instance_id=? AND status IN ('pending','claimed')
     LIMIT 1
  `).get(instance.id);
  assert.ok(active, 'one schedule must hold the active slot');
  const holderId = active.schedule_id;
  const cappedId = holderId === scheduleA.id ? scheduleB.id : scheduleA.id;
  const aActive = active;

  // Park the holder far in the future so only the capped peer is due below.
  // Otherwise the holder legitimately supersedes its own older occurrence and
  // the cap path under test is never reached.
  h.db.prepare("UPDATE operator_schedules SET next_fire_at='2026-08-01T00:00:00.000Z' WHERE id=?")
    .run(holderId);

  // The peer is already at its cap for the window.
  h.db.prepare('UPDATE operator_schedules SET max_runs_per_day=1 WHERE id=?').run(cappedId);
  h.db.prepare(`
    INSERT INTO operator_invocations (
      id, schedule_id, operator_instance_id, source, prompt_snapshot,
      scheduled_for, status, run_after, completed_at
    ) VALUES (?, ?, ?, 'scheduled', 'p', ?, 'completed', ?, datetime('now'))
  `).run(
    `oinv_capped_${Math.random().toString(16).slice(2)}`,
    cappedId,
    instance.id,
    '2026-07-01T00:30:00.000Z',
    '2026-07-01T00:30:00.000Z',
  );

  // A newer occurrence of the capped peer comes due while the holder waits.
  h.scheduleService.materializeDue(new Date('2026-07-01T02:00:00.000Z'));

  const aAfter = h.db.prepare('SELECT * FROM operator_invocations WHERE id=?').get(aActive.id);
  assert.equal(aAfter.status, 'pending', 'a capped peer must not supersede the waiting occurrence');
  assert.equal(aAfter.waiting_reason, aActive.waiting_reason);

  // B's occurrence is refused, but durably — not silently dropped.
  const bCapped = invocations(h, cappedId)
    .filter((row) => row.waiting_reason === 'daily_cap_reached');
  assert.equal(bCapped.length, 1, 'the capped occurrence must leave a durable record');
  assert.equal(bCapped[0].status, 'cancelled');
  assert.equal(bCapped[0].completed_at !== null, true);
});
