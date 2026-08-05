'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../db/database');
const { createActionBroker } = require('../services/actionBroker');
const { createFakeGithubGateway } = require('../services/actionGateways/fakeGithubGateway');
const { createActionLedgerService } = require('../services/actionLedgerService');
const { buildOutgoingBody } = require('../services/actionReadback');

const START = '2026-08-05T00:00:00.000Z';
const BASE_PARAMS = {
  repo: 'Acme/Widgets',
  title: 'Reconcile issue',
  body: 'Recover this external effect',
  labels: ['P1', 'security'],
};

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pal-action-reconcile-'));
  const handle = createDatabase(path.join(dir, 'test.db'));
  handle.migrate();
  let currentTime = START;
  let actionSequence = 0;
  let attemptSequence = 0;
  const clock = () => new Date(currentTime);
  const ledger = createActionLedgerService(handle.db, {
    clock,
    actionIdFactory: () => `action-${++actionSequence}`,
    attemptIdFactory: () => `attempt-${++attemptSequence}`,
  });
  t.after(() => {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    db: handle.db,
    ledger,
    clock,
    setTime(value) { currentTime = value; },
  };
}

function declareApproved(ledger, slot, expiresAt = '2026-08-05T03:00:00.000Z') {
  const action = ledger.declareAction({
    taskId: 'task-reconcile',
    actionSlot: slot,
    connector: 'github',
    operation: 'github.create_issue',
    params: BASE_PARAMS,
  });
  ledger.approveAction(action.id, {
    approvedBy: 'user-1',
    authMethod: 'cookie',
    policyVersion: 'policy-v1',
    expiresAt,
    expectedParamsHash: action.params_hash,
  });
  return ledger.getAction(action.id);
}

function makeUnknown(ledger, slot, nextReconcileAt = START) {
  const action = declareApproved(ledger, slot);
  const attemptId = ledger.claimForExecution(action.id);
  assert.ok(attemptId);
  assert.equal(ledger.recordExecutionResult({
    id: action.id,
    attemptId,
    status: 'unknown',
    nextReconcileAt,
    verdict: JSON.stringify({ status: 'unknown', reason: 'test_setup' }),
  }), true);
  return ledger.getAction(action.id);
}

function matchingIssue(action, overrides = {}) {
  const params = JSON.parse(action.params_json);
  const number = overrides.number ?? 1;
  return {
    number,
    node_id: overrides.node_id ?? `NODE_${action.id}_${number}`,
    html_url: overrides.html_url
      ?? `https://github.test/${params.repo}/issues/${number}`,
    state: 'open',
    repo: params.repo,
    title: params.title,
    body: buildOutgoingBody(params.body, action.id),
    labels: [...params.labels],
    ...overrides,
  };
}

async function reconcile(ledger, clock, action, gateway) {
  const attemptId = ledger.claimForReconcile(action.id);
  assert.ok(attemptId);
  const broker = createActionBroker({ ledger, gateway, clock });
  const outcome = await broker.reconcileClaimedAction({
    action: ledger.getAction(action.id),
    attemptId,
  });
  return { outcome, row: ledger.getAction(action.id) };
}

test('migration 086 permits expired read-only claims but keeps mutation claim checks', (t) => {
  const { db, ledger, setTime } = setup(t);
  assert.ok(db.prepare('SELECT 1 FROM schema_version WHERE version = 85').get());
  assert.ok(db.prepare('SELECT 1 FROM schema_version WHERE version = 86').get());

  const readOnly = declareApproved(
    ledger,
    'expired-read-only',
    '2026-08-05T00:10:00.000Z',
  );
  const executionAttempt = ledger.claimForExecution(readOnly.id);
  ledger.recordExecutionResult({
    id: readOnly.id,
    attemptId: executionAttempt,
    status: 'unknown',
    nextReconcileAt: '2026-08-05T01:00:00.000Z',
  });
  setTime('2026-08-05T01:00:00.000Z');
  // MUTATION: restoring reconciling to the expiry CHECK rejects this read-only claim.
  assert.ok(ledger.claimForReconcile(readOnly.id));
  assert.equal(ledger.getAction(readOnly.id).status, 'reconciling');

  for (const status of ['executing', 'repairing']) {
    const action = declareApproved(ledger, `expired-${status}`);
    // MUTATION: removing either mutating phase from the expiry CHECK permits an expired claim.
    assert.throws(
      () => db.prepare(`
        UPDATE actions
        SET status = ?, approval_expires_at = ?,
            active_attempt_id = ?, claimed_at = ?
        WHERE id = ?
      `).run(
        status,
        '2026-08-05T00:30:00.000Z',
        `raw-${status}`,
        '2026-08-05T01:00:00.000Z',
        action.id,
      ),
      { code: 'SQLITE_CONSTRAINT_CHECK' },
    );
  }
});

test('orphan recovery releases only expired active leases to unknown, never queued', (t) => {
  const { db, ledger } = setup(t);
  const expired = [];
  for (const status of ['executing', 'reconciling', 'repairing']) {
    const action = declareApproved(ledger, `orphan-${status}`);
    db.prepare(`
      UPDATE actions
      SET status = ?, active_attempt_id = ?, claimed_at = ?
      WHERE id = ?
    `).run(status, `orphan-attempt-${status}`, START, action.id);
    expired.push(action.id);
  }
  const fresh = declareApproved(ledger, 'fresh-executing');
  db.prepare(`
    UPDATE actions
    SET status = 'executing', active_attempt_id = 'fresh-attempt', claimed_at = ?
    WHERE id = ?
  `).run('2026-08-05T01:50:00.000Z', fresh.id);

  // MUTATION: recovering active work to queued would allow a second createIssue POST.
  assert.equal(ledger.recoverOrphans({
    leaseTtlMs: 30 * 60 * 1000,
    now: '2026-08-05T02:00:00.000Z',
  }), 3);
  for (const id of expired) {
    const row = ledger.getAction(id);
    assert.equal(row.status, 'unknown');
    assert.equal(row.active_attempt_id, null);
    assert.equal(row.claimed_at, null);
    assert.equal(row.next_reconcile_at, '2026-08-05T02:00:00.000Z');
    assert.equal(ledger.listEvents(id).at(-1).phase, 'orphan.recovered');
  }
  // MUTATION: omitting the lease threshold steals a live attempt.
  assert.equal(ledger.getAction(fresh.id).status, 'executing');
  assert.equal(ledger.recoverOrphans({
    leaseTtlMs: 30 * 60 * 1000,
    now: '2026-08-05T02:00:00.000Z',
  }), 0);
  assert.equal(ledger.listActions().some((action) => action.status === 'queued'), false);
});

test('orphan recovery expires a lease at the exact TTL boundary', (t) => {
  const { db, ledger } = setup(t);
  const exact = declareApproved(ledger, 'lease-exact');
  const younger = declareApproved(ledger, 'lease-younger');
  db.prepare(`
    UPDATE actions
    SET status = 'executing', active_attempt_id = ?, claimed_at = ?
    WHERE id = ?
  `).run('exact-attempt', START, exact.id);
  db.prepare(`
    UPDATE actions
    SET status = 'executing', active_attempt_id = ?, claimed_at = ?
    WHERE id = ?
  `).run('younger-attempt', '2026-08-05T00:00:01.000Z', younger.id);

  // MUTATION: strict > leaves an exactly-expired lease stuck in executing.
  assert.equal(ledger.recoverOrphans({
    leaseTtlMs: 60 * 60 * 1000,
    now: '2026-08-05T01:00:00.000Z',
  }), 1);
  assert.equal(ledger.getAction(exact.id).status, 'unknown');
  assert.equal(ledger.getAction(younger.id).status, 'executing');
});

test('reconcile classifies valid, partial, conflicting, empty, invalid, and fault outcomes read-only', async (t) => {
  const { ledger, clock } = setup(t);
  const scenarios = [
    { slot: 'valid', issues: (action) => [matchingIssue(action)], expected: 'succeeded' },
    {
      slot: 'partial',
      issues: (action) => [matchingIssue(action, { labels: ['P1'] })],
      expected: 'partially_applied',
    },
    {
      slot: 'conflict',
      issues: (action) => [
        matchingIssue(action, { number: 3 }),
        matchingIssue(action, { number: 4 }),
      ],
      expected: 'conflict',
    },
    { slot: 'empty', issues: () => [], expected: 'unknown' },
    {
      slot: 'invalid',
      issues: (action) => [matchingIssue(action, { title: 'wrong title' })],
      expected: 'unknown',
    },
  ];

  for (const scenario of scenarios) {
    const action = makeUnknown(ledger, scenario.slot);
    const gateway = createFakeGithubGateway({ issues: scenario.issues(action) });
    const { row } = await reconcile(ledger, clock, action, gateway);
    assert.equal(row.status, scenario.expected);
    // MUTATION: reconcile must never call createIssue, regardless of classification.
    assert.equal(gateway.getPostCount(), 0);
    assert.equal(gateway.getSearchCount(), 1);
    if (scenario.expected === 'succeeded') {
      assert.equal(row.external_node_id, matchingIssue(action).node_id);
    }
    if (scenario.expected === 'unknown') {
      assert.equal(row.next_reconcile_at, '2026-08-05T00:01:00.000Z');
    }
  }

  const faultAction = makeUnknown(ledger, 'search-fault');
  const faultGateway = createFakeGithubGateway({
    searchIssuesByMarker: [{ kind: 'timeout' }],
  });
  const fault = await reconcile(ledger, clock, faultAction, faultGateway);
  // MUTATION: retrying create on an ambiguous search fault breaks at-most-one POST.
  assert.equal(fault.row.status, 'unknown');
  assert.equal(fault.row.next_reconcile_at, '2026-08-05T00:01:00.000Z');
  assert.equal(faultGateway.getPostCount(), 0);
  assert.equal(faultGateway.getSearchCount(), 1);
});

test('an ambiguous marker candidate prevents a valid sibling from succeeding', async (t) => {
  const { ledger, clock } = setup(t);
  const action = makeUnknown(ledger, 'ambiguous-with-valid');
  const firstCandidate = matchingIssue(action, { number: 21 });
  const validCandidate = matchingIssue(action, { number: 22 });
  const gateway = createFakeGithubGateway({
    issues: [firstCandidate, validCandidate],
    getIssue: [
      { kind: 'ok', issue: { ...firstCandidate, node_id: null } },
      { kind: 'ok', issue: validCandidate },
    ],
  });

  // MUTATION: silently dropping an ambiguous candidate lets a sibling be
  // recorded succeeded despite an unresolved marker match.
  const malformed = await reconcile(ledger, clock, action, gateway);
  assert.equal(malformed.row.status, 'unknown');
  assert.equal(malformed.row.next_reconcile_at, '2026-08-05T00:01:00.000Z');
  assert.equal(gateway.getPostCount(), 0);
  assert.equal(gateway.getGetCount(), 2);

  const mismatchedAction = makeUnknown(ledger, 'ambiguous-mismatch');
  const mismatchGateway = createFakeGithubGateway({
    issues: [matchingIssue(mismatchedAction, { title: 'mismatched title' })],
  });
  // MUTATION: dropping a validateReadback unknown candidate erases a marker match.
  const mismatched = await reconcile(ledger, clock, mismatchedAction, mismatchGateway);
  assert.equal(mismatched.row.status, 'unknown');
  assert.equal(mismatched.row.next_reconcile_at, '2026-08-05T00:01:00.000Z');
  assert.equal(mismatchGateway.getPostCount(), 0);
});

test('candidate GET faults keep reconcile unknown and read-only', async (t) => {
  const { ledger, clock } = setup(t);
  const action = makeUnknown(ledger, 'get-fault');
  const gateway = createFakeGithubGateway({
    issues: [matchingIssue(action)],
    getIssue: [{ kind: 'server_error' }],
  });
  const { row } = await reconcile(ledger, clock, action, gateway);
  // MUTATION: accepting a search hit without full GET bypasses read-back.
  assert.equal(row.status, 'unknown');
  assert.equal(row.next_reconcile_at, '2026-08-05T00:01:00.000Z');
  assert.equal(gateway.getPostCount(), 0);
  assert.equal(gateway.getGetCount(), 1);
});

test('external identity uniqueness turns the second reconcile into conflict', async (t) => {
  const { ledger, clock } = setup(t);
  const first = makeUnknown(ledger, 'identity-first');
  const second = makeUnknown(ledger, 'identity-second');
  const sharedNode = 'NODE_SHARED';

  const firstGateway = createFakeGithubGateway({
    issues: [matchingIssue(first, { node_id: sharedNode, number: 11 })],
  });
  await reconcile(ledger, clock, first, firstGateway);
  assert.equal(ledger.getAction(first.id).status, 'succeeded');

  const secondGateway = createFakeGithubGateway({
    issues: [matchingIssue(second, { node_id: sharedNode, number: 11 })],
  });
  // MUTATION: leaking the UNIQUE violation throws instead of recording a normal conflict outcome.
  await reconcile(ledger, clock, second, secondGateway);
  assert.equal(ledger.getAction(second.id).status, 'conflict');
  assert.equal(ledger.getAction(second.id).external_node_id, null);
  assert.equal(firstGateway.getPostCount(), 0);
  assert.equal(secondGateway.getPostCount(), 0);
});

test('a stale reconcile result is evidence-only', (t) => {
  const { ledger } = setup(t);
  const action = makeUnknown(ledger, 'stale-reconcile');
  const staleAttempt = ledger.claimForReconcile(action.id);
  assert.ok(staleAttempt);
  assert.equal(ledger.recoverOrphans({
    leaseTtlMs: 0,
    now: '2026-08-05T00:00:01.000Z',
  }), 1);
  const currentAttempt = ledger.claimForReconcile(action.id, {
    now: '2026-08-05T00:00:01.000Z',
  });
  const before = ledger.getAction(action.id);
  const eventsBefore = ledger.listEvents(action.id).length;

  // MUTATION: removing the reconcile attempt fence lets stale work overwrite the current claim.
  assert.equal(ledger.recordReconcileResult({
    id: action.id,
    attemptId: staleAttempt,
    status: 'succeeded',
    externalNodeId: 'NODE_STALE',
    verdict: JSON.stringify({ status: 'succeeded' }),
  }), false);
  assert.deepEqual(ledger.getAction(action.id), before);
  assert.equal(before.active_attempt_id, currentAttempt);
  const events = ledger.listEvents(action.id);
  assert.equal(events.length, eventsBefore + 1);
  assert.equal(events.at(-1).phase, 'reconcile.result.stale');
});

test('one POST across create unknown then reconcile success remains one', async (t) => {
  const { ledger, clock } = setup(t);
  const action = declareApproved(ledger, 'lifecycle');
  const attemptId = ledger.claimForExecution(action.id);
  const gateway = createFakeGithubGateway({
    seed: 51,
    createIssue: [{ kind: 'response_lost' }],
  });
  const broker = createActionBroker({ ledger, gateway, clock });

  await broker.executeClaimedAction({ action: ledger.getAction(action.id), attemptId });
  assert.equal(ledger.getAction(action.id).status, 'unknown');
  assert.equal(gateway.getPostCount(), 1);

  const reconcileAttempt = ledger.claimForReconcile(action.id, {
    now: '2026-08-05T00:01:00.000Z',
  });
  await broker.reconcileClaimedAction({
    action: ledger.getAction(action.id),
    attemptId: reconcileAttempt,
  });
  // MUTATION: re-entering forward execution during reconcile consumes POST #2.
  assert.equal(ledger.getAction(action.id).status, 'succeeded');
  assert.equal(gateway.getPostCount(), 1);
  assert.equal(gateway.getSearchCount(), 1);
});

test('driveReconciliation recovers orphans then reconciles every eligible unknown without POST', async (t) => {
  const { db, ledger, clock, setTime } = setup(t);
  const orphan = declareApproved(ledger, 'drive-orphan');
  db.prepare(`
    UPDATE actions
    SET status = 'executing', active_attempt_id = 'drive-orphan-attempt', claimed_at = ?
    WHERE id = ?
  `).run(START, orphan.id);
  const waiting = makeUnknown(ledger, 'drive-waiting');
  const future = makeUnknown(ledger, 'drive-future', '2026-08-05T02:30:00.000Z');
  setTime('2026-08-05T02:00:00.000Z');
  const gateway = createFakeGithubGateway({
    issues: [
      matchingIssue(orphan, { number: 61 }),
      matchingIssue(waiting, { number: 62 }),
      matchingIssue(future, { number: 63 }),
    ],
  });
  const broker = createActionBroker({ ledger, gateway, clock });

  // MUTATION: orphan recovery to queued would route the orphan back through createIssue.
  const summary = await broker.driveReconciliation({
    leaseTtlMs: 30 * 60 * 1000,
    now: '2026-08-05T02:00:00.000Z',
  });
  assert.deepEqual(summary, {
    recovered: 1,
    claimed: 2,
    outcomes: {
      succeeded: 2,
      partially_applied: 0,
      conflict: 0,
      unknown: 0,
      stale: 0,
    },
  });
  assert.equal(ledger.getAction(orphan.id).status, 'succeeded');
  assert.equal(ledger.getAction(waiting.id).status, 'succeeded');
  assert.equal(ledger.getAction(future.id).status, 'unknown');
  assert.equal(gateway.getPostCount(), 0);
  assert.equal(gateway.getSearchCount(), 2);
});

test('driveReconciliation processes a rescheduled row at most once per pass', async (t) => {
  const { ledger, clock, setTime } = setup(t);
  const action = makeUnknown(ledger, 'drive-no-spin');
  const gateway = createFakeGithubGateway();
  const broker = createActionBroker({ ledger, gateway, clock });

  // MUTATION: re-scanning eligibility mid-pass re-processes a row it just rescheduled.
  const first = await broker.driveReconciliation({
    leaseTtlMs: 60 * 60 * 1000,
    now: START,
  });
  assert.equal(first.claimed, 1);
  assert.equal(first.outcomes.unknown, 1);
  assert.equal(gateway.getSearchCount(), 1);
  assert.equal(ledger.getAction(action.id).next_reconcile_at, '2026-08-05T00:01:00.000Z');

  setTime('2026-08-05T00:01:00.000Z');
  const second = await broker.driveReconciliation({
    leaseTtlMs: 60 * 60 * 1000,
    now: '2026-08-05T00:01:00.000Z',
  });
  assert.equal(second.claimed, 1);
  assert.equal(second.outcomes.unknown, 1);
  assert.equal(gateway.getSearchCount(), 2);
  assert.equal(gateway.getPostCount(), 0);
});
