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
const { createOperatorInstanceService } = require('../services/operatorInstanceService');
const {
  CLAIM_LEASE_MS,
  createOperatorScheduleService,
} = require('../services/operatorScheduleService');

const BASE = new Date('2026-08-01T00:00:00.000Z');
const ONE = new Date('2026-08-01T01:00:00.000Z');

function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-precheck-occurrence-'));
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
  const instanceService = createOperatorInstanceService(db, { runService });
  const scheduleService = createOperatorScheduleService(db, { eventBus, runService });
  db.prepare(`
    INSERT INTO operator_profiles (id, name, capabilities_json, is_private)
    VALUES ('op_precheck', 'Precheck Operator', '[]', 0)
  `).run();
  return { db, eventBus, projectService, instanceService, scheduleService };
}

function createFixture(h, {
  attached = true,
  maxRuns = 24,
  rule = { kind: 'interval', minutes: 60 },
  checkOverrides = {},
  projectOverrides = {},
} = {}) {
  const project = h.projectService.createProject({
    name: `Precheck project ${Math.random()}`,
    directory: '/tmp',
    ...projectOverrides,
  });
  const instance = h.instanceService.createInstance({
    profile_id: 'op_precheck',
    display_name: `Precheck instance ${Math.random()}`,
    primary_project_id: project.id,
  });
  const schedule = h.scheduleService.createSchedule(instance.id, {
    name: 'Prechecked hourly task',
    prompt: 'Perform scheduled work',
    rule,
    timezone: 'UTC',
    max_runs_per_day: maxRuns,
  }, BASE);
  const normalizedSpec = {
    files: [{ glob: 'README.md', must_exist: true }],
    report: null,
  };
  const checkInput = {
    kind: 'artifact',
    project_id: project.id,
    name: `Artifact ${Math.random()}`,
    spec_json: JSON.stringify(normalizedSpec),
    created_by: 'human',
    ...checkOverrides,
  };
  const info = h.db.prepare(`
    INSERT INTO verify_checks (kind, project_id, name, spec_json, created_by)
    VALUES (@kind, @project_id, @name, @spec_json, @created_by)
  `).run(checkInput);
  const checkId = Number(info.lastInsertRowid);
  if (attached) {
    h.db.prepare('UPDATE operator_schedules SET precheck_verify_check_id=? WHERE id=?')
      .run(checkId, schedule.id);
  }
  return { project, instance, schedule, checkId, normalizedSpec };
}

function materializeAndClaim(h, at = ONE) {
  assert.deepEqual(h.scheduleService.materializeDue(at), []);
  const occurrence = h.scheduleService.claimNextOccurrence(at);
  assert.ok(occurrence);
  return occurrence;
}

function evaluationFor(occurrence, overrides = {}) {
  return {
    evaluatedSpecHash: occurrence.precheck_spec_hash,
    evaluatedNodeId: occurrence.precheck_node_id,
    evaluatedWorkspaceGeneration: occurrence.precheck_workspace_generation,
    now: new Date(new Date(occurrence.scheduled_for).getTime() + 1000),
    ...overrides,
  };
}

function occurrenceRow(h, id) {
  return h.db.prepare('SELECT * FROM operator_schedule_occurrences WHERE id=?').get(id);
}

function scheduleRow(h, id) {
  return h.db.prepare('SELECT * FROM operator_schedules WHERE id=?').get(id);
}

test('090 schema matches the occurrence contract and required partial indexes', (t) => {
  const h = harness(t);
  const columns = new Map(h.db.pragma('table_info(operator_schedule_occurrences)')
    .map((column) => [column.name, column]));
  for (const name of [
    'schedule_id', 'operator_instance_id', 'scheduled_for', 'schedule_revision',
    'precheck_check_id_snapshot', 'precheck_check_name', 'precheck_kind',
    'precheck_spec_hash', 'precheck_node_id', 'status', 'attempts',
    'next_attempt_at', 'deadline_at', 'created_at', 'updated_at',
  ]) assert.equal(columns.get(name)?.notnull, 1, `${name} must be NOT NULL`);
  assert.equal(columns.get('id')?.pk, 1, 'id is the contract primary key');
  assert.equal(columns.get('precheck_workspace_generation')?.notnull, 0);
  const indexes = new Map(h.db.pragma('index_list(operator_schedule_occurrences)')
    .map((index) => [index.name, index]));
  assert.equal(indexes.get('idx_osocc_inflight_schedule')?.unique, 1);
  assert.equal(indexes.get('idx_osocc_inflight_schedule')?.partial, 1);
  assert.equal(indexes.get('idx_osocc_claimable')?.partial, 1);
});

test('§7 #1 unattached schedules preserve materialize and claim/deliver with zero occurrences', (t) => {
  const h = harness(t);
  const { schedule } = createFixture(h, { attached: false });
  const [invocation] = h.scheduleService.materializeDue(ONE);
  assert.ok(invocation);
  assert.equal(h.scheduleService.listOccurrences(schedule.id).length, 0);
  const claimed = h.scheduleService.claimNext(ONE);
  assert.equal(claimed.id, invocation.id);
  const delivering = h.scheduleService.markDelivering(claimed.id, claimed.claim_token);
  assert.equal(delivering.status, 'delivering');
  assert.equal(h.scheduleService.listOccurrences(schedule.id).length, 0);
});

test('§7 #7 occurrence claims include every predicate and cannot be duplicated', (t) => {
  const h = harness(t);
  createFixture(h);
  h.scheduleService.materializeDue(ONE);
  assert.equal(h.scheduleService.claimNextOccurrence(new Date(ONE.getTime() - 1)), null,
    'next_attempt_at must be due');
  const first = h.scheduleService.claimNextOccurrence(ONE);
  assert.equal(first.status, 'prechecking');
  assert.equal(first.attempts, 1);
  assert.equal(h.scheduleService.claimNextOccurrence(ONE), null, 'CAS prevents a second claim');
});

test('§7 #12 a newer occurrence supersedes the in-flight owner and rejects its result', (t) => {
  const h = harness(t);
  const { schedule } = createFixture(h);
  const old = materializeAndClaim(h);
  h.scheduleService.materializeDue(new Date('2026-08-01T02:00:00.000Z'));
  assert.equal(occurrenceRow(h, old.id).status, 'superseded');
  assert.equal(h.scheduleService.commitPrecheck(old.id, old.claim_token, true, evaluationFor(old)), null);
  const rows = h.scheduleService.listOccurrences(schedule.id);
  assert.deepEqual(rows.map((row) => row.status), ['pending', 'superseded']);
});

test('§7 #17 cap is checked before materialize and checked again during commit', (t) => {
  const h = harness(t);
  const before = createFixture(h, { maxRuns: 1 });
  const counted = h.scheduleService.runNow(before.schedule.id, BASE);
  h.db.prepare("UPDATE operator_invocations SET status='completed' WHERE id=?").run(counted.id);
  assert.deepEqual(h.scheduleService.materializeDue(ONE), []);
  assert.equal(h.scheduleService.listOccurrences(before.schedule.id).length, 0);
  assert.equal(h.scheduleService.listInvocations(before.schedule.id)[0].waiting_reason, 'daily_cap_reached');

  const during = createFixture(h, { maxRuns: 1 });
  const occurrence = materializeAndClaim(h);
  const other = h.scheduleService.runNow(during.schedule.id, new Date(ONE.getTime() + 1000));
  h.db.prepare("UPDATE operator_invocations SET status='completed' WHERE id=?").run(other.id);
  const committed = h.scheduleService.commitPrecheck(
    occurrence.id,
    occurrence.claim_token,
    true,
    evaluationFor(occurrence, { now: new Date(ONE.getTime() + 2000) }),
  );
  assert.equal(committed.status, 'passed');
  assert.equal(committed.outcome_reason, 'daily_cap_reached');
  assert.ok(committed.invocation_id);
  assert.equal(h.db.prepare('SELECT waiting_reason FROM operator_invocations WHERE id=?')
    .get(committed.invocation_id).waiting_reason, 'daily_cap_reached');
  assert.equal(h.db.prepare(`
    SELECT COUNT(*) AS count FROM operator_invocations
     WHERE schedule_id=? AND status!='cancelled'
  `).get(during.schedule.id).count, 1, 'the terminal cap record does not consume another cap slot');
});

test('§7 #22 cap and active-skip paths terminalize passed occurrences and link invocations', (t) => {
  const h = harness(t);
  const capped = createFixture(h, { maxRuns: 1 });
  const capOccurrence = materializeAndClaim(h);
  const counted = h.scheduleService.runNow(capped.schedule.id, new Date(ONE.getTime() + 1000));
  h.db.prepare("UPDATE operator_invocations SET status='completed' WHERE id=?").run(counted.id);
  const capResult = h.scheduleService.commitPrecheck(
    capOccurrence.id, capOccurrence.claim_token, true,
    evaluationFor(capOccurrence, { now: new Date(ONE.getTime() + 2000) }),
  );
  assert.deepEqual(
    [capResult.status, capResult.outcome_reason, Boolean(capResult.invocation_id)],
    ['passed', 'daily_cap_reached', true],
  );

  const active = createFixture(h);
  const activeOccurrence = materializeAndClaim(h);
  h.scheduleService.runNow(active.schedule.id, new Date(ONE.getTime() + 1000));
  const activeResult = h.scheduleService.commitPrecheck(
    activeOccurrence.id, activeOccurrence.claim_token, true,
    evaluationFor(activeOccurrence, { now: new Date(ONE.getTime() + 2000) }),
  );
  assert.deepEqual(
    [activeResult.status, activeResult.outcome_reason, Boolean(activeResult.invocation_id)],
    ['passed', 'operator_active_skipped', true],
  );
  assert.equal(h.db.prepare(`
    SELECT COUNT(*) AS count FROM operator_schedule_occurrences WHERE status='prechecking'
  `).get().count, 0);
});

test('§7 #23 a late claimant commit is a complete no-op after lease recovery and reclaim', (t) => {
  const h = harness(t);
  createFixture(h);
  const claimantA = materializeAndClaim(h);
  const reclaimAt = new Date(ONE.getTime() + CLAIM_LEASE_MS + 1000);
  h.scheduleService.sweepStaleOccurrences(reclaimAt);
  const claimantB = h.scheduleService.claimNextOccurrence(reclaimAt);
  assert.ok(claimantB);
  assert.notEqual(claimantB.claim_token, claimantA.claim_token);
  assert.equal(h.scheduleService.commitPrecheck(
    claimantA.id, claimantA.claim_token, true,
    evaluationFor(claimantA, { now: reclaimAt }),
  ), null);
  const after = occurrenceRow(h, claimantA.id);
  assert.equal(after.status, 'prechecking');
  assert.equal(after.claim_token, claimantB.claim_token);
  assert.equal(after.attempts, 2);
});

test('§7 #24 deadline fences commits and sweep terminals never-claimed pending rows', (t) => {
  const h = harness(t);
  const claimedFixture = createFixture(h);
  const claimed = materializeAndClaim(h);
  const afterDeadline = new Date(claimed.deadline_at);
  const committed = h.scheduleService.commitPrecheck(
    claimed.id, claimed.claim_token, true,
    evaluationFor(claimed, { now: afterDeadline }),
  );
  assert.equal(committed.status, 'precheck_unavailable');
  assert.equal(h.scheduleService.listInvocations(claimedFixture.schedule.id).length, 0);

  const onceAt = new Date('2026-08-02T01:00:00.000Z');
  const pendingFixture = createFixture(h, { rule: { kind: 'once', at: onceAt.toISOString() } });
  h.scheduleService.materializeDue(onceAt);
  const [pending] = h.scheduleService.listOccurrences(pendingFixture.schedule.id);
  assert.equal(pending.status, 'pending');
  h.scheduleService.sweepStaleOccurrences(new Date(pending.deadline_at));
  assert.equal(occurrenceRow(h, pending.id).status, 'precheck_unavailable');
});

test('§7 #25 duplicate occurrence identity cannot roll back the advanced cursor', (t) => {
  const h = harness(t);
  const { schedule } = createFixture(h);
  const occurrence = materializeAndClaim(h);
  h.scheduleService.commitPrecheck(occurrence.id, occurrence.claim_token, false, evaluationFor(occurrence));
  h.db.prepare('UPDATE operator_schedules SET next_fire_at=? WHERE id=?').run(ONE.toISOString(), schedule.id);
  assert.doesNotThrow(() => h.scheduleService.materializeDue(new Date(ONE.getTime() + 1000)));
  assert.equal(scheduleRow(h, schedule.id).next_fire_at, '2026-08-01T02:00:00.000Z');
  assert.equal(h.scheduleService.listOccurrences(schedule.id).length, 1);
});

test('§7 #26 release and sweep fencing do not steal a live prechecking claim', (t) => {
  const h = harness(t);
  createFixture(h);
  const claimed = materializeAndClaim(h);
  assert.equal(h.scheduleService.releaseOccurrence(claimed.id, 'wrong-token', { now: ONE }), null);
  h.scheduleService.sweepStaleOccurrences(new Date(ONE.getTime() + CLAIM_LEASE_MS - 1));
  const after = occurrenceRow(h, claimed.id);
  assert.equal(after.status, 'prechecking');
  assert.equal(after.claim_token, claimed.claim_token);
});

test('§7 #27 release persists backoff so a reconstructed service cannot immediately reclaim', (t) => {
  const h = harness(t);
  createFixture(h);
  const claimed = materializeAndClaim(h);
  const released = h.scheduleService.releaseOccurrence(claimed.id, claimed.claim_token, { now: ONE });
  assert.equal(released.status, 'pending');
  assert.ok(released.next_attempt_at > ONE.toISOString());
  const restarted = createOperatorScheduleService(h.db, { eventBus: h.eventBus });
  assert.equal(restarted.claimNextOccurrence(ONE), null);
  const reclaimed = restarted.claimNextOccurrence(new Date(released.next_attempt_at));
  assert.equal(reclaimed.id, claimed.id);
  assert.equal(reclaimed.attempts, 2);
});

test('§7 #30 health table resets successes, increments errors, and disables exactly at three', (t) => {
  const h = harness(t);
  const passedFixture = createFixture(h);
  h.db.prepare('UPDATE operator_schedules SET consecutive_precheck_errors=2 WHERE id=?')
    .run(passedFixture.schedule.id);
  const passed = materializeAndClaim(h);
  h.scheduleService.commitPrecheck(passed.id, passed.claim_token, true, evaluationFor(passed));
  assert.equal(scheduleRow(h, passedFixture.schedule.id).consecutive_precheck_errors, 0);

  const failedFixture = createFixture(h);
  h.db.prepare('UPDATE operator_schedules SET consecutive_precheck_errors=2 WHERE id=?')
    .run(failedFixture.schedule.id);
  const failed = materializeAndClaim(h);
  h.scheduleService.commitPrecheck(failed.id, failed.claim_token, false, evaluationFor(failed));
  assert.equal(scheduleRow(h, failedFixture.schedule.id).consecutive_precheck_errors, 0);

  const unavailableFixture = createFixture(h);
  h.db.prepare('UPDATE operator_schedules SET consecutive_precheck_errors=2 WHERE id=?')
    .run(unavailableFixture.schedule.id);
  h.scheduleService.materializeDue(ONE);
  const [pending] = h.scheduleService.listOccurrences(unavailableFixture.schedule.id);
  h.scheduleService.sweepStaleOccurrences(new Date(pending.deadline_at));
  const disabled = scheduleRow(h, unavailableFixture.schedule.id);
  assert.deepEqual(
    [disabled.consecutive_precheck_errors, disabled.enabled, disabled.next_fire_at],
    [3, 0, null],
  );

  const blockedFixture = createFixture(h);
  const blocked = materializeAndClaim(h);
  h.db.prepare("UPDATE verify_checks SET created_by='operator' WHERE id=?").run(blockedFixture.checkId);
  const blockedResult = h.scheduleService.commitPrecheck(
    blocked.id, blocked.claim_token, true, evaluationFor(blocked),
  );
  assert.equal(blockedResult.status, 'precheck_blocked');
  assert.equal(scheduleRow(h, blockedFixture.schedule.id).consecutive_precheck_errors, 1);

  const supersededFixture = createFixture(h);
  h.db.prepare('UPDATE operator_schedules SET consecutive_precheck_errors=2 WHERE id=?')
    .run(supersededFixture.schedule.id);
  const superseded = materializeAndClaim(h);
  h.db.prepare('UPDATE operator_schedules SET precheck_verify_check_id=NULL WHERE id=?')
    .run(supersededFixture.schedule.id);
  const supersededResult = h.scheduleService.commitPrecheck(
    superseded.id, superseded.claim_token, true, evaluationFor(superseded),
  );
  assert.equal(supersededResult.status, 'superseded');
  assert.equal(scheduleRow(h, supersededFixture.schedule.id).consecutive_precheck_errors, 2,
    'normal reconfiguration does not alter health');

  const missingFixture = createFixture(h);
  h.db.prepare('UPDATE operator_schedules SET consecutive_precheck_errors=2 WHERE id=?')
    .run(missingFixture.schedule.id);
  h.db.pragma('foreign_keys = OFF');
  h.db.prepare('DELETE FROM verify_checks WHERE id=?').run(missingFixture.checkId);
  h.db.pragma('foreign_keys = ON');
  h.scheduleService.materializeDue(ONE);
  const missingDisabled = scheduleRow(h, missingFixture.schedule.id);
  assert.deepEqual(
    [missingDisabled.consecutive_precheck_errors, missingDisabled.enabled, missingDisabled.next_fire_at],
    [3, 0, null],
    'a corrupt missing check follows the same threshold without creating an occurrence',
  );
  assert.equal(h.scheduleService.listOccurrences(missingFixture.schedule.id).length, 0);
  h.db.prepare('UPDATE operator_schedules SET precheck_verify_check_id=NULL WHERE id=?')
    .run(missingFixture.schedule.id);
  assert.equal(scheduleRow(h, passedFixture.schedule.id).consecutive_failures, 0,
    'precheck health remains separate from delivery failures');
});

test('§7 #39 provenance loss outranks a simultaneous spec hash mismatch', (t) => {
  const h = harness(t);
  const fixture = createFixture(h);
  const occurrence = materializeAndClaim(h);
  h.db.prepare(`
    UPDATE verify_checks SET created_by='operator', spec_json=? WHERE id=?
  `).run(JSON.stringify({ files: [{ glob: 'dist/**', must_exist: true }], report: null }), fixture.checkId);
  const result = h.scheduleService.commitPrecheck(
    occurrence.id, occurrence.claim_token, true, evaluationFor(occurrence),
  );
  assert.equal(result.status, 'precheck_blocked');
  assert.equal(result.outcome_reason, 'provenance_lost');
  assert.equal(scheduleRow(h, fixture.schedule.id).consecutive_precheck_errors, 1);
  assert.equal(h.scheduleService.listInvocations(fixture.schedule.id).length, 0,
    'blocked prechecks do not consume the invocation cap');
});

test('§4.4 sweep covers lease recovery plus prechecking and pending deadline terminals', (t) => {
  const h = harness(t);
  const leaseFixture = createFixture(h);
  const leased = materializeAndClaim(h);
  const leaseExpiry = new Date(new Date(leased.leased_until).getTime());
  h.scheduleService.sweepStaleOccurrences(leaseExpiry);
  assert.equal(occurrenceRow(h, leased.id).status, 'pending');
  assert.equal(occurrenceRow(h, leased.id).next_attempt_at, leaseExpiry.toISOString());
  assert.equal(scheduleRow(h, leaseFixture.schedule.id).consecutive_precheck_errors, 0,
    'lease recovery itself is not a health error');

  const precheckingFixture = createFixture(h);
  const prechecking = materializeAndClaim(h);
  h.scheduleService.sweepStaleOccurrences(new Date(prechecking.deadline_at));
  assert.equal(occurrenceRow(h, prechecking.id).status, 'precheck_unavailable');
  assert.equal(h.scheduleService.listInvocations(precheckingFixture.schedule.id).length, 0);

  const pendingFixture = createFixture(h);
  h.scheduleService.materializeDue(ONE);
  const [pending] = h.scheduleService.listOccurrences(pendingFixture.schedule.id);
  h.scheduleService.sweepStaleOccurrences(new Date(pending.deadline_at));
  assert.equal(occurrenceRow(h, pending.id).status, 'precheck_unavailable');
  assert.equal(h.scheduleService.listInvocations(pendingFixture.schedule.id).length, 0);
});

test('§7 #41 occurrence SSE is additive while both legacy payload shapes stay exact', (t) => {
  const h = harness(t);
  const events = [];
  h.eventBus.subscribe((event) => {
    if (event.channel === 'operator:schedule') events.push(event.data);
  });
  const plain = createFixture(h, { attached: false });
  h.scheduleService.materializeDue(ONE);
  const scheduleChanged = events.find((event) => event.kind === 'schedule_changed');
  const invocationChanged = events.find((event) => event.kind === 'invocation_status');
  const oldKeys = ['invocation_id', 'kind', 'operator_instance_id', 'schedule_id', 'status'];
  assert.deepEqual(Object.keys(scheduleChanged).sort(), oldKeys);
  assert.deepEqual(Object.keys(invocationChanged).sort(), oldKeys);
  h.db.prepare("UPDATE operator_invocations SET status='completed' WHERE schedule_id=?")
    .run(plain.schedule.id);

  createFixture(h);
  h.scheduleService.materializeDue(ONE);
  const occurrenceEvent = events.find((event) => event.kind === 'occurrence_status');
  assert.ok(occurrenceEvent);
  assert.equal(occurrenceEvent.invocation_id, null);
  assert.equal(occurrenceEvent.occurrence_status, 'pending');
  assert.deepEqual(Object.keys(occurrenceEvent).sort(), [
    ...oldKeys, 'occurrence_id', 'occurrence_status',
  ].sort());
});

test('§7 #42/#43 detach then delete is NULL-safe superseded, not check_gone blocked', (t) => {
  const h = harness(t);
  const fixture = createFixture(h);
  const occurrence = materializeAndClaim(h);
  h.db.prepare('UPDATE operator_schedules SET precheck_verify_check_id=NULL WHERE id=?')
    .run(fixture.schedule.id);
  h.db.prepare('DELETE FROM verify_checks WHERE id=?').run(fixture.checkId);
  assert.equal(occurrenceRow(h, occurrence.id).precheck_verify_check_id, null,
    'occurrence FK is SET NULL while the non-FK snapshot survives');
  const result = h.scheduleService.commitPrecheck(
    occurrence.id, occurrence.claim_token, true, evaluationFor(occurrence),
  );
  assert.equal(result.status, 'superseded');
  assert.equal(result.outcome_reason, 'attachment_changed');
  assert.equal(scheduleRow(h, fixture.schedule.id).consecutive_precheck_errors, 0);
  assert.equal(result.precheck_check_id_snapshot, fixture.checkId);
});

test('release past the deadline terminalizes instead of parking an unclaimable row', (t) => {
  const h = harness(t);
  const fixture = createFixture(h);
  const occurrence = materializeAndClaim(h);
  const afterDeadline = new Date(new Date(occurrence.deadline_at).getTime() + 1000);

  const released = h.scheduleService.releaseOccurrence(
    occurrence.id, occurrence.claim_token, { now: afterDeadline },
  );
  // Parking it back to `pending` would be a zombie: the claim predicate requires
  // deadline_at > now, so it could never be picked up again, and its health cost
  // would never be counted.
  assert.equal(released.status, 'precheck_unavailable');
  assert.equal(released.outcome_reason, 'deadline_exceeded');
  assert.equal(released.claim_token, null);
  assert.equal(scheduleRow(h, fixture.schedule.id).consecutive_precheck_errors, 1);
  assert.equal(h.scheduleService.claimNextOccurrence(afterDeadline), null);
});

test('release before the deadline still parks for retry with a persisted backoff', (t) => {
  const h = harness(t);
  const fixture = createFixture(h);
  const occurrence = materializeAndClaim(h);
  const soon = new Date(new Date(occurrence.scheduled_for).getTime() + 1000);

  const released = h.scheduleService.releaseOccurrence(
    occurrence.id, occurrence.claim_token, { now: soon },
  );
  assert.equal(released.status, 'pending');
  assert.ok(released.next_attempt_at > soon.toISOString(), 'backoff is persisted in the row');
  // A retry is not an infrastructure failure.
  assert.equal(scheduleRow(h, fixture.schedule.id).consecutive_precheck_errors, 0);
});

test('a stale worker cannot expire a row a newer claimant owns', (t) => {
  const h = harness(t);
  const fixture = createFixture(h);
  const stale = materializeAndClaim(h);
  const afterDeadline = new Date(new Date(stale.deadline_at).getTime() + 1000);

  assert.equal(
    h.scheduleService.releaseOccurrence(stale.id, 'not-the-owning-token', { now: afterDeadline }),
    null,
    'ownership loss is a complete no-op, even on the expiry path',
  );
  assert.equal(occurrenceRow(h, stale.id).status, 'prechecking');
  assert.equal(scheduleRow(h, fixture.schedule.id).consecutive_precheck_errors, 0);
});

test('commit refuses a result whose check kind no longer matches the snapshot', (t) => {
  const h = harness(t);
  const fixture = createFixture(h);
  const occurrence = materializeAndClaim(h);
  // Backstop path: migration 089 makes kind immutable, so this contamination is
  // only reachable by disabling that trigger — exactly what a future writer who
  // relaxes the trigger would do without noticing this invariant.
  h.db.exec('DROP TRIGGER verify_checks_kind_immutable');
  h.db.prepare("UPDATE verify_checks SET kind='command' WHERE id=?").run(fixture.checkId);

  const result = h.scheduleService.commitPrecheck(
    occurrence.id, occurrence.claim_token, true, evaluationFor(occurrence),
  );
  assert.equal(result.status, 'precheck_blocked');
  assert.equal(result.outcome_reason, 'kind_changed');
  assert.equal(scheduleRow(h, fixture.schedule.id).consecutive_precheck_errors, 1);
  assert.equal(result.invocation_id, null);
});

test('release terminalizes when the backoff itself would overshoot the deadline', (t) => {
  const h = harness(t);
  const fixture = createFixture(h);
  const occurrence = materializeAndClaim(h);
  // Still inside the deadline, but the retry would land past it. Parking here is
  // the same zombie one step removed: by the time next_attempt_at arrives, the
  // claim predicate (deadline_at > now) can no longer be satisfied.
  const justInside = new Date(new Date(occurrence.deadline_at).getTime() - 1000);
  assert.ok(justInside.toISOString() < occurrence.deadline_at, 'precondition: not yet expired');

  const released = h.scheduleService.releaseOccurrence(
    occurrence.id, occurrence.claim_token, { now: justInside },
  );
  assert.equal(released.status, 'precheck_unavailable');
  assert.equal(released.outcome_reason, 'deadline_exceeded');
  assert.equal(scheduleRow(h, fixture.schedule.id).consecutive_precheck_errors, 1);
  assert.equal(h.scheduleService.claimNextOccurrence(justInside), null);
});
