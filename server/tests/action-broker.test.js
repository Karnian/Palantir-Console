'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../db/database');
const { createActionBroker } = require('../services/actionBroker');
const { createFakeGithubGateway } = require('../services/actionGateways/fakeGithubGateway');
const { markerFor } = require('../services/actionReadback');
const { createActionLedgerService } = require('../services/actionLedgerService');
const { BadRequestError } = require('../utils/errors');

const START = '2026-08-05T00:00:00.000Z';
const BASE_PARAMS = {
  repo: 'Acme/Widgets',
  title: 'Forward broker',
  body: 'Create the issue exactly once.',
  labels: ['P1', 'security'],
};

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pal-action-broker-'));
  const handle = createDatabase(path.join(dir, 'test.db'));
  handle.migrate();
  let actionSequence = 0;
  let attemptSequence = 0;
  const clock = () => new Date(START);
  const ledger = createActionLedgerService(handle.db, {
    clock,
    actionIdFactory: () => `action-${++actionSequence}`,
    attemptIdFactory: () => `attempt-${++attemptSequence}`,
  });
  t.after(() => {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { ledger, clock };
}

function claim(ledger, index, params = BASE_PARAMS) {
  const action = ledger.declareAction({
    taskId: `task-${index}`,
    actionSlot: `issue-${index}`,
    connector: 'github',
    operation: 'github.create_issue',
    params,
  });
  ledger.approveAction(action.id, {
    approvedBy: 'user-1',
    authMethod: 'cookie',
    policyVersion: 'policy-v1',
    expiresAt: '2026-08-05T01:00:00.000Z',
    expectedParamsHash: action.params_hash,
  });
  const attemptId = ledger.claimForExecution(action.id);
  assert.ok(attemptId);
  return { action: ledger.getAction(action.id), attemptId };
}

async function execute(ledger, clock, claimed, script) {
  const match = /([0-9]+)$/.exec(claimed.action.id);
  const seed = match ? Number(match[1]) : 1;
  const gateway = createFakeGithubGateway({ seed, ...script });
  const broker = createActionBroker({ ledger, gateway, clock });
  const result = await broker.executeClaimedAction(claimed);
  return { gateway, result, row: ledger.getAction(claimed.action.id) };
}

test('happy path declares, approves, claims, creates once, and validates the marker', async (t) => {
  const { ledger, clock } = setup(t);
  const claimed = claim(ledger, 'happy');
  const { gateway, row } = await execute(ledger, clock, claimed, { seed: 41 });

  assert.equal(row.status, 'succeeded');
  assert.equal(gateway.getPostCount(), 1);
  assert.equal(gateway.getGetCount(), 1);
  const receipt = JSON.parse(row.receipt_json);
  // MUTATION: removing the server marker from buildOutgoingBody makes full GET validation unsafe.
  assert.ok(receipt.body.includes(markerFor(claimed.action.id)));
  assert.equal(receipt.body, `${BASE_PARAMS.body}\n\n${markerFor(claimed.action.id)}`);
  assert.deepEqual(JSON.parse(row.verdict), {
    reason: 'full_readback_valid',
    status: 'succeeded',
  });
  assert.deepEqual(JSON.parse(row.external_id), {
    html_url: 'https://github.test/acme/widgets/issues/41',
    number: 41,
    repo: 'acme/widgets',
  });
});

test('read-back accepts a requested-label subset and records missing requested labels', async (t) => {
  const { ledger, clock } = setup(t);
  const subsetClaim = claim(ledger, 'labels-subset');
  const subset = await execute(ledger, clock, subsetClaim, {
    createIssue: [{ kind: 'ok', issue: { labels: ['P1', 'security', 'triage'] } }],
  });
  // MUTATION: requiring label equality rejects unrelated labels GitHub is allowed to add.
  assert.equal(subset.row.status, 'succeeded');
  assert.equal(subset.gateway.getPostCount(), 1);

  const missingClaim = claim(ledger, 'labels-missing');
  const missing = await execute(ledger, clock, missingClaim, {
    createIssue: [{ kind: 'ok', issue: { labels: ['P1', 'triage'] } }],
  });
  // MUTATION: treating a label mismatch as success loses the typed repair boundary.
  assert.equal(missing.row.status, 'partially_applied');
  assert.deepEqual(JSON.parse(missing.row.verdict), {
    missingLabels: ['security'],
    reason: 'missing_labels',
    status: 'partially_applied',
  });
  assert.equal(missing.gateway.getPostCount(), 1);
});

test('404 repository and 422 validation faults are terminal no-effect failures', async (t) => {
  const { ledger, clock } = setup(t);
  for (const [index, kind] of ['not_found_repo', 'validation_error'].entries()) {
    const claimed = claim(ledger, `permanent-${index}`);
    const { gateway, row } = await execute(ledger, clock, claimed, {
      createIssue: [{ kind }],
    });
    // MUTATION: mapping confirmed no-effect failures to unknown schedules needless probes.
    assert.equal(row.status, 'failed');
    assert.deepEqual(JSON.parse(row.verdict), { reason: 'no_effect' });
    assert.equal(row.next_reconcile_at, null);
    assert.equal(gateway.getPostCount(), 1);
    assert.equal(gateway.getGetCount(), 0);
  }
});

test('429 and abuse 403 are terminal rate-limited failures with no automatic retry', async (t) => {
  const { ledger, clock } = setup(t);
  for (const [index, kind] of ['rate_limited', 'abuse_denied'].entries()) {
    const claimed = claim(ledger, `rate-${index}`);
    const { gateway, row } = await execute(ledger, clock, claimed, {
      createIssue: [{ kind }, { kind: 'ok' }],
    });
    // MUTATION: retrying rate limits consumes the queued second behavior and duplicates POST attempts.
    assert.equal(gateway.getPostCount(), 1);
    assert.equal(row.status, 'failed');
    assert.deepEqual(JSON.parse(row.verdict), {
      rate_limited: true,
      reason: 'no_effect',
    });
    assert.equal(row.active_attempt_id, null);
    assert.equal(row.next_reconcile_at, null);
  }
});

test('ambiguous create faults become unknown with a reconcile time and are never recreated', async (t) => {
  const { ledger, clock } = setup(t);
  const kinds = ['timeout', 'server_error', 'response_lost', 'malformed'];
  for (const [index, kind] of kinds.entries()) {
    const claimed = claim(ledger, `ambiguous-${index}`);
    const { gateway, row } = await execute(ledger, clock, claimed, {
      createIssue: [{ kind }, { kind: 'ok' }],
    });
    // MUTATION: changing ambiguous to queued enables a second automatic create.
    assert.equal(row.status, 'unknown');
    assert.equal(row.next_reconcile_at, '2026-08-05T00:01:00.000Z');
    assert.equal(row.active_attempt_id, null);
    assert.equal(gateway.getPostCount(), 1);
    assert.equal(gateway.getGetCount(), 0);
  }
});

test('marker missing, title mismatch, and closed state read back as unknown', async (t) => {
  const { ledger, clock } = setup(t);
  const cases = [
    { body: BASE_PARAMS.body },
    { title: 'A different issue' },
    { state: 'closed' },
  ];
  for (const [index, issue] of cases.entries()) {
    const claimed = claim(ledger, `mismatch-${index}`);
    const { gateway, row } = await execute(ledger, clock, claimed, {
      createIssue: [{ kind: 'ok', issue }],
    });
    // MUTATION: trusting the 2xx create response bypasses full GET validation.
    assert.equal(row.status, 'unknown');
    assert.deepEqual(JSON.parse(row.verdict), {
      reason: 'readback_mismatch',
      status: 'unknown',
    });
    assert.equal(gateway.getPostCount(), 1);
    assert.equal(gateway.getGetCount(), 1);
  }
});

test('a read-back transport fault becomes unknown without a second create', async (t) => {
  const { ledger, clock } = setup(t);
  const claimed = claim(ledger, 'readback-fault');
  const { gateway, row } = await execute(ledger, clock, claimed, {
    getIssue: [{ kind: 'timeout' }],
  });

  // MUTATION: retrying create after a GET timeout violates the one-POST boundary.
  assert.equal(row.status, 'unknown');
  assert.equal(row.next_reconcile_at, '2026-08-05T00:01:00.000Z');
  assert.equal(gateway.getPostCount(), 1);
  assert.equal(gateway.getGetCount(), 1);
});

test('stale fenced writes are evidence-only and the active broker attempt wins', async (t) => {
  const { ledger, clock } = setup(t);
  const claimed = claim(ledger, 'fencing');
  const before = ledger.getAction(claimed.action.id);
  const eventsBefore = ledger.listEvents(claimed.action.id).length;

  // MUTATION: dropping active_attempt_id from the CAS lets a superseded callback mutate the row.
  assert.equal(ledger.recordExecutionResult({
    id: claimed.action.id,
    attemptId: 'stale-attempt',
    status: 'succeeded',
    externalNodeId: 'STALE_NODE',
    event: { phase: 'execution.succeeded' },
  }), false);
  assert.deepEqual(ledger.getAction(claimed.action.id), before);
  const events = ledger.listEvents(claimed.action.id);
  assert.equal(events.length, eventsBefore + 1);
  assert.equal(events.at(-1).phase, 'execution.result.stale');

  const { gateway, row } = await execute(ledger, clock, claimed, {});
  assert.equal(row.status, 'succeeded');
  assert.equal(row.external_node_id, 'FAKE_NODE_1');
  assert.equal(gateway.getPostCount(), 1);
});

test('a stale dispatch persistence stops before read-back or terminal transition', async (t) => {
  const { ledger, clock } = setup(t);
  const claimed = claim(ledger, 'dispatch-fence');
  const realRecord = ledger.recordExecutionResult;
  let calls = 0;
  const fencedLedger = {
    ...ledger,
    recordExecutionResult(input) {
      calls += 1;
      if (calls === 1 && input.status === 'executing') return false;
      return realRecord(input);
    },
  };
  const gateway = createFakeGithubGateway();
  const broker = createActionBroker({ ledger: fencedLedger, gateway, clock });

  await broker.executeClaimedAction(claimed);
  // MUTATION: ignoring the fenced external-id write result lets stale work continue to GET.
  assert.equal(gateway.getPostCount(), 1);
  assert.equal(gateway.getGetCount(), 0);
  assert.equal(ledger.getAction(claimed.action.id).status, 'executing');
});

test('declaration rejects the reserved action marker syntax', (t) => {
  const { ledger } = setup(t);
  // MUTATION: removing the declaration guard lets users forge another action's marker.
  assert.throws(
    () => ledger.declareAction({
      taskId: 'task-marker',
      actionSlot: 'issue-marker',
      connector: 'github',
      operation: 'github.create_issue',
      params: { ...BASE_PARAMS, body: 'forged palantir-action-id marker' },
    }),
    (error) => error instanceof BadRequestError && error.status === 400,
  );
});

test('at-most-one POST holds across representative create and read-back faults', async (t) => {
  const { ledger, clock } = setup(t);
  const scenarios = [
    { createIssue: [{ kind: 'timeout' }, { kind: 'ok' }] },
    { createIssue: [{ kind: 'server_error' }, { kind: 'ok' }] },
    { createIssue: [{ kind: 'response_lost' }, { kind: 'ok' }] },
    { createIssue: [{ kind: 'rate_limited' }, { kind: 'ok' }] },
    { createIssue: [{ kind: 'validation_error' }, { kind: 'ok' }] },
    { getIssue: [{ kind: 'timeout' }], createIssue: [{ kind: 'ok' }, { kind: 'ok' }] },
  ];

  for (const [index, script] of scenarios.entries()) {
    const claimed = claim(ledger, `one-post-${index}`);
    const { gateway } = await execute(ledger, clock, claimed, script);
    // MUTATION: adding any broker-level create retry makes at least one scenario consume POST #2.
    assert.ok(gateway.getPostCount() <= 1, `scenario ${index} exceeded one POST`);
  }
});

test('fake counters are separate and response_lost remains readable from its store', async () => {
  const gateway = createFakeGithubGateway({
    seed: 7,
    createIssue: [{ kind: 'response_lost' }],
  });
  await assert.rejects(
    gateway.createIssue({ repo: 'acme/widgets', title: 't', body: 'b', labels: [] }),
    (error) => error.kind === 'response_lost',
  );
  const issue = await gateway.getIssue({ repo: 'acme/widgets', number: 7 });
  // MUTATION: incrementing postCount from GET makes read-only probes violate the POST invariant.
  assert.equal(gateway.getPostCount(), 1);
  assert.equal(gateway.getGetCount(), 1);
  assert.equal(issue.number, 7);
});
