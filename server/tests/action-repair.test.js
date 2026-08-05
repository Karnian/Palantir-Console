'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../db/database');
const { createActionBroker } = require('../services/actionBroker');
const { createFakeGithubGateway } = require('../services/actionGateways/fakeGithubGateway');
const { buildOutgoingBody } = require('../services/actionReadback');
const { createActionLedgerService } = require('../services/actionLedgerService');

const START = '2026-08-05T00:00:00.000Z';
const LATER = '2026-08-05T00:01:01.000Z';
const PARAMS = {
  repo: 'acme/widgets',
  title: 'Repair labels',
  body: 'Apply all requested labels.',
  labels: ['P1', 'security'],
};

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pal-action-repair-'));
  const handle = createDatabase(path.join(dir, 'test.db'));
  handle.migrate();
  let currentTime = START;
  let actionSequence = 0;
  let attemptSequence = 0;
  const clock = () => new Date(currentTime);
  const ledger = createActionLedgerService(handle.db, {
    clock,
    actionIdFactory: () => 'action-' + (++actionSequence),
    attemptIdFactory: () => 'attempt-' + (++attemptSequence),
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
    taskId: 'repair-task',
    actionSlot: slot,
    connector: 'github',
    operation: 'github.create_issue',
    params: PARAMS,
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

function issueFor(action, labels = ['P1']) {
  const params = JSON.parse(action.params_json);
  return {
    number: 17,
    node_id: 'NODE_' + action.id,
    html_url: 'https://github.test/' + params.repo + '/issues/17',
    state: 'open',
    repo: params.repo,
    title: params.title,
    body: buildOutgoingBody(params.body, action.id),
    labels,
  };
}

function makePartial(ledger, slot, labels = ['P1'], expiresAt) {
  const action = declareApproved(ledger, slot, expiresAt);
  const attemptId = ledger.claimForExecution(action.id);
  const issue = issueFor(action, labels);
  assert.equal(ledger.recordExecutionResult({
    id: action.id,
    attemptId,
    status: 'partially_applied',
    externalId: JSON.stringify({ repo: PARAMS.repo, number: issue.number, html_url: issue.html_url }),
    externalNodeId: issue.node_id,
    receipt: issue,
  }), true);
  return { action: ledger.getAction(action.id), issue };
}

async function claimAndRepair(ledger, clock, partial, gateway, options = {}) {
  const claim = ledger.claimForRepair(partial.action.id, {
    now: options.now || START,
    maxRepairAttempts: options.maxRepairAttempts ?? 3,
  });
  assert.equal(typeof claim, 'string');
  const broker = createActionBroker({ ledger, gateway, clock });
  const outcome = await broker.repairClaimedAction({
    action: ledger.getAction(partial.action.id),
    attemptId: claim,
    now: options.now || START,
    maxRepairAttempts: options.maxRepairAttempts ?? 3,
    backoffMs: options.backoffMs ?? 60_000,
  });
  return { claim, outcome, row: ledger.getAction(partial.action.id) };
}

test('happy repair adds only missing labels and succeeds without create POST', async (t) => {
  const { ledger, clock } = setup(t);
  const partial = makePartial(ledger, 'happy');
  const gateway = createFakeGithubGateway({ issues: [partial.issue] });
  const result = await claimAndRepair(ledger, clock, partial, gateway);
  // MUTATION: incrementing repair_attempts after dispatch loses the crash-safe repair fence.
  assert.equal(result.row.repair_attempts, 1);
  assert.equal(result.row.status, 'succeeded');
  assert.equal(gateway.getLabelWriteCount(), 1);
  assert.equal(gateway.getPostCount(), 0);
});

test('permanent denial blocks terminally and preserves external identity', async (t) => {
  const { ledger, clock } = setup(t);
  const partial = makePartial(ledger, 'denied');
  const gateway = createFakeGithubGateway({
    issues: [partial.issue],
    addLabels: [{ kind: 'permission_denied' }],
  });
  const result = await claimAndRepair(ledger, clock, partial, gateway);
  // MUTATION: treating a permission denial as retryable keeps human-blocked work spinning.
  assert.equal(result.row.status, 'repair_blocked');
  assert.equal(result.row.external_node_id, partial.issue.node_id);
  assert.equal(ledger.listRepairableActionIds({ now: LATER }).includes(partial.action.id), false);
  assert.equal(gateway.getPostCount(), 0);
});

test('rate limit waits on the repair timer and a later bounded pass reclaims once', async (t) => {
  const { ledger, clock, setTime } = setup(t);
  const partial = makePartial(ledger, 'rate');
  const gateway = createFakeGithubGateway({
    issues: [partial.issue],
    addLabels: [{ kind: 'rate_limited' }, { kind: 'ok' }],
  });
  const first = await claimAndRepair(ledger, clock, partial, gateway);
  assert.equal(first.row.status, 'repair_retry_wait');
  assert.equal(first.row.next_repair_at, '2026-08-05T00:01:00.000Z');
  setTime(LATER);
  const broker = createActionBroker({ ledger, gateway, clock });
  // MUTATION: re-scanning within one pass can spin indefinitely on immediately-due repair rows.
  const summary = await broker.driveRepair({ now: LATER, maxRepairAttempts: 3, backoffMs: 60_000 });
  assert.equal(summary.scanned, 1);
  assert.equal(summary.claimed, 1);
  assert.equal(ledger.getAction(partial.action.id).status, 'succeeded');
  assert.equal(ledger.getAction(partial.action.id).repair_attempts, 2);
});

test('max attempts and expired approval block before repairing', (t) => {
  const { db, ledger } = setup(t);
  const maximum = makePartial(ledger, 'maximum');
  db.prepare('UPDATE actions SET repair_attempts = 2 WHERE id = ?').run(maximum.action.id);
  // MUTATION: incrementing repair_attempts AFTER dispatch lets a crash loop repair forever.
  assert.deepEqual(ledger.claimForRepair(maximum.action.id, {
    now: START,
    maxRepairAttempts: 2,
  }), { blocked: true, reason: 'max_attempts' });
  assert.equal(ledger.getAction(maximum.action.id).repair_attempts, 2);
  assert.equal(ledger.getAction(maximum.action.id).status, 'repair_blocked');

  const expired = makePartial(ledger, 'expired');
  db.prepare('UPDATE actions SET approval_expires_at = ? WHERE id = ?')
    .run(START, expired.action.id);
  // MUTATION: attempting the raw repairing update first turns expiry into a CHECK exception.
  assert.deepEqual(ledger.claimForRepair(expired.action.id, {
    now: START,
    maxRepairAttempts: 3,
  }), { blocked: true, reason: 'approval_expired' });
  assert.equal(ledger.getAction(expired.action.id).status, 'repair_blocked');
});

test('ambiguous label writes become reconcileable unknown without create', async (t) => {
  const { ledger, clock } = setup(t);
  for (const [index, kind] of ['timeout', 'server_error'].entries()) {
    const partial = makePartial(ledger, 'ambiguous-' + index);
    const gateway = createFakeGithubGateway({
      issues: [partial.issue],
      addLabels: [{ kind }],
    });
    const result = await claimAndRepair(ledger, clock, partial, gateway);
    // MUTATION: retrying an ambiguous label response in place bypasses read-only adjudication.
    assert.equal(result.row.status, 'unknown');
    assert.equal(result.row.next_reconcile_at, '2026-08-05T00:01:00.000Z');
    assert.equal(gateway.getPostCount(), 0);
  }
});

test('repair fencing rejects stale results but appends evidence', (t) => {
  const { ledger } = setup(t);
  const partial = makePartial(ledger, 'fencing');
  const attemptId = ledger.claimForRepair(partial.action.id, {
    now: START,
    maxRepairAttempts: 3,
  });
  const before = ledger.listEvents(partial.action.id).length;
  // MUTATION: removing the active attempt predicate lets a stale worker win.
  assert.equal(ledger.recordRepairResult({
    id: partial.action.id,
    attemptId: 'stale-attempt',
    status: 'succeeded',
  }), false);
  assert.equal(ledger.getAction(partial.action.id).active_attempt_id, attemptId);
  assert.equal(ledger.listEvents(partial.action.id).length, before + 1);
  assert.equal(ledger.listEvents(partial.action.id).at(-1).phase, 'repair.result.stale');
});

test('orphan recovery and state-idempotent labels remain safe', async (t) => {
  const { db, ledger } = setup(t);
  const orphan = makePartial(ledger, 'orphan');
  db.prepare(
    "UPDATE actions SET status = 'repairing', active_attempt_id = ?, claimed_at = ? WHERE id = ?",
  ).run('orphan-attempt', START, orphan.action.id);
  // MUTATION: recovering repairing to queued would authorize another create POST.
  assert.equal(ledger.recoverOrphans({ now: LATER, leaseTtlMs: 60_000 }), 1);
  assert.equal(ledger.getAction(orphan.action.id).status, 'unknown');

  const gateway = createFakeGithubGateway({ issues: [orphan.issue] });
  await gateway.addLabels({ repo: PARAMS.repo, number: 17, labels: ['security'] });
  await gateway.addLabels({ repo: PARAMS.repo, number: 17, labels: ['SECURITY'] });
  const issue = await gateway.getIssue({ repo: PARAMS.repo, number: 17 });
  // MUTATION: blindly appending labels breaks state idempotence on repeated repair.
  assert.deepEqual(issue.labels, ['P1', 'security']);

  const alreadyApplied = makePartial(ledger, 'already-applied');
  const alreadyGateway = createFakeGithubGateway({
    issues: [issueFor(alreadyApplied.action, ['P1', 'security'])],
  });
  const result = await claimAndRepair(ledger, () => new Date(START), alreadyApplied, alreadyGateway);
  assert.equal(result.row.status, 'succeeded');
  assert.equal(alreadyGateway.getLabelWriteCount(), 0);
});

test('the full partial-to-repair lifecycle performs one create total', async (t) => {
  const { ledger, clock } = setup(t);
  const action = declareApproved(ledger, 'lifecycle');
  const executionAttempt = ledger.claimForExecution(action.id);
  const gateway = createFakeGithubGateway({
    createIssue: [{ kind: 'ok', issue: { labels: ['P1'] } }],
  });
  const broker = createActionBroker({ ledger, gateway, clock });
  await broker.executeClaimedAction({
    action: ledger.getAction(action.id),
    attemptId: executionAttempt,
  });
  assert.equal(ledger.getAction(action.id).status, 'partially_applied');
  assert.equal(gateway.getPostCount(), 1);
  const repairAttempt = ledger.claimForRepair(action.id, {
    now: START,
    maxRepairAttempts: 3,
  });
  await broker.repairClaimedAction({
    action: ledger.getAction(action.id),
    attemptId: repairAttempt,
    now: START,
  });
  // MUTATION: calling createIssue from repair violates the whole-lifecycle POST fence.
  assert.equal(ledger.getAction(action.id).status, 'succeeded');
  assert.equal(gateway.getPostCount(), 1);
  assert.equal(gateway.getLabelWriteCount(), 1);
});
