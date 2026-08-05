'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../db/database');
const {
  createActionLedgerService,
  canonicalParamsJson,
} = require('../services/actionLedgerService');

const BASE_PARAMS = {
  repo: 'Acme/Widgets',
  title: 'Ship e\u0301vidence',
  body: 'Do not trim me  ',
  labels: ['security', 'P1'],
};

function setup(t, start = '2026-08-05T00:00:00.000Z') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pal-action-ledger-'));
  const handle = createDatabase(path.join(dir, 'test.db'));
  handle.migrate();
  let currentTime = start;
  let actionSequence = 0;
  let attemptSequence = 0;
  const ledger = createActionLedgerService(handle.db, {
    clock: () => new Date(currentTime),
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
    setTime(value) { currentTime = value; },
  };
}

function declare(ledger, overrides = {}) {
  return ledger.declareAction({
    taskId: overrides.taskId || 'task-1',
    actionSlot: overrides.actionSlot || 'primary-issue',
    connector: 'github',
    operation: 'github.create_issue',
    params: overrides.params || BASE_PARAMS,
  });
}

function approve(ledger, id, overrides = {}) {
  const current = ledger.getAction(id);
  return ledger.approveAction(id, {
    approvedBy: overrides.approvedBy || 'user-1',
    authMethod: overrides.authMethod || 'cookie',
    policyVersion: overrides.policyVersion || 'policy-v1',
    expiresAt: overrides.expiresAt || '2026-08-05T01:00:00.000Z',
    expectedParamsHash: overrides.expectedParamsHash ?? current.params_hash,
  });
}

test('canonical params normalize repo, labels, Unicode, and key order without trimming', () => {
  const a = canonicalParamsJson(BASE_PARAMS);
  const b = canonicalParamsJson({
    labels: ['P1', 'security', 'P1'],
    body: 'Do not trim me  ',
    title: 'Ship évidence',
    repo: 'ACME/WIDGETS',
  });
  assert.equal(a, b);
  assert.deepEqual(JSON.parse(a), {
    body: 'Do not trim me  ',
    labels: ['P1', 'security'],
    repo: 'acme/widgets',
    title: 'Ship évidence',
  });
  assert.deepEqual(JSON.parse(canonicalParamsJson({ ...BASE_PARAMS, labels: undefined })).labels, []);
});

test('canonical params reject ambiguous, polluting, sparse, and unbounded inputs', () => {
  const clean = canonicalParamsJson(BASE_PARAMS);

  // MUTATION: accepting unknown top-level fields makes operation semantics ambiguous.
  assert.throws(
    () => canonicalParamsJson({ ...BASE_PARAMS, milestone: 7 }),
    (error) => error.status === 400 && /unknown create_issue param field/.test(error.message),
  );

  const polluting = JSON.parse(JSON.stringify({ ...BASE_PARAMS }).replace(
    /}$/, ',"__proto__":{"polluted":true}}',
  ));
  // MUTATION: constructing canonical maps with {} lets __proto__ mutate their prototype.
  assert.throws(() => canonicalParamsJson(polluting), (error) => error.status === 400);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(canonicalParamsJson(BASE_PARAMS), clean, 'polluting input cannot collide with clean params');

  const sparseLabels = new Array(2);
  sparseLabels[0] = 'P1';
  // MUTATION: Array.map on a sparse array serializes holes as null.
  assert.throws(
    () => canonicalParamsJson({ ...BASE_PARAMS, labels: sparseLabels }),
    (error) => error.status === 400 && /must not be sparse/.test(error.message),
  );

  const oversized = {
    ...BASE_PARAMS,
    title: 't'.repeat(30_000),
    body: 'b'.repeat(40_000),
  };
  // MUTATION: removing the serialized byte cap permits memory-amplification inputs.
  assert.throws(
    () => canonicalParamsJson(oversized),
    (error) => error.status === 400 && /exceed/.test(error.message),
  );

  const tooDeep = { leaf: true };
  for (let depth = 0, node = tooDeep; depth < 10; depth += 1) {
    node.child = {};
    node = node.child;
  }
  // MUTATION: removing the depth cap makes normalization recurse without a small bound.
  assert.throws(
    () => canonicalParamsJson({ ...BASE_PARAMS, extra: tooDeep }),
    (error) => error.status === 400 && /nesting exceeds/.test(error.message),
  );

  const cyclic = { ...BASE_PARAMS };
  cyclic.self = cyclic;
  // MUTATION: removing ancestor tracking lets cyclic input recurse indefinitely.
  assert.throws(
    () => canonicalParamsJson(cyclic),
    (error) => error.status === 400 && /must not be cyclic/.test(error.message),
  );
});

test('approval requires the exact hash reviewed by the human', (t) => {
  const { ledger } = setup(t);
  const action = declare(ledger);

  // MUTATION: removing expectedParamsHash comparison approves a different reviewed state.
  assert.throws(
    () => approve(ledger, action.id, { expectedParamsHash: 'f'.repeat(64) }),
    (error) => error.status === 409 && /changed after they were reviewed/.test(error.message),
  );
  assert.equal(ledger.getAction(action.id).status, 'awaiting_approval');
  assert.equal(approve(ledger, action.id).status, 'queued');
});

test('approval CAS is the execution boundary and binds the current params hash', (t) => {
  const { db, ledger } = setup(t);
  const unapproved = declare(ledger, { actionSlot: 'unapproved' });

  // MUTATION: removing status/approval predicates from the claim CAS lets this reach executing.
  assert.equal(ledger.claimForExecution(unapproved.id), null);
  assert.equal(ledger.getAction(unapproved.id).status, 'awaiting_approval');

  assert.throws(
    () => ledger.approveAction(unapproved.id, {
      approvedBy: 'agent-1',
      authMethod: 'bearer',
      policyVersion: 'policy-v1',
      expiresAt: '2026-08-05T01:00:00.000Z',
      expectedParamsHash: unapproved.params_hash,
    }),
    (error) => error.status === 403,
  );

  const tampered = declare(ledger, { actionSlot: 'tampered' });
  const approved = approve(ledger, tampered.id);
  assert.equal(approved.status, 'queued');
  assert.equal(approved.approved_at, '2026-08-05T00:00:00.000Z');
  assert.equal(approved.approved_by, 'user-1');
  assert.equal(approved.approval_auth_method, 'cookie');
  assert.equal(approved.approved_params_hash, approved.params_hash);
  assert.equal(approved.approval_policy_version, 'policy-v1');
  assert.equal(approved.approval_expires_at, '2026-08-05T01:00:00.000Z');

  // MUTATION: removing the intent-immutable trigger permits an approved payload swap.
  assert.throws(
    () => db.prepare('UPDATE actions SET params_json = ? WHERE id = ?')
      .run('{"body":"tampered"}', tampered.id),
    /action intent columns are immutable/,
  );
  assert.equal(ledger.getAction(tampered.id).params_json, tampered.params_json);

  const valid = declare(ledger, { actionSlot: 'valid' });
  approve(ledger, valid.id);
  const attempt = ledger.claimForExecution(valid.id);
  assert.equal(attempt, 'attempt-1');
  const claimed = ledger.getAction(valid.id);
  assert.equal(claimed.status, 'executing');
  assert.equal(claimed.active_attempt_id, attempt);
  assert.equal(claimed.claimed_at, '2026-08-05T00:00:00.000Z');
});

test('attempt fencing makes a stale result evidence-only while the active attempt writes', (t) => {
  const { ledger } = setup(t);
  const action = declare(ledger);
  approve(ledger, action.id);
  const attempt = ledger.claimForExecution(action.id);
  const before = ledger.getAction(action.id);
  const eventsBefore = ledger.listEvents(action.id).length;

  // MUTATION: removing active_attempt_id from the result WHERE lets this overwrite the row.
  assert.equal(ledger.recordExecutionResult({
    id: action.id,
    attemptId: 'stale-attempt',
    status: 'succeeded',
    externalId: '99',
    externalNodeId: 'NODE_stale',
    receipt: { stale: true },
    verdict: 'wrong',
    event: { phase: 'caller.override.must.not_win' },
  }), false);
  assert.deepEqual(ledger.getAction(action.id), before);
  const afterStaleEvents = ledger.listEvents(action.id);
  assert.equal(afterStaleEvents.length, eventsBefore + 1);
  // MUTATION: using caller event.phase for a lost CAS misclassifies stale evidence.
  assert.equal(afterStaleEvents.at(-1).phase, 'execution.result.stale');
  assert.equal(afterStaleEvents.at(-1).attempt_id, 'stale-attempt');

  assert.equal(ledger.recordExecutionResult({
    id: action.id,
    attemptId: attempt,
    status: 'succeeded',
    externalId: '101',
    externalNodeId: 'NODE_current',
    receipt: { ok: true },
    verdict: 'full_get_valid',
  }), true);
  const completed = ledger.getAction(action.id);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.external_id, '101');
  assert.equal(completed.external_node_id, 'NODE_current');
  assert.equal(completed.receipt_json, '{"ok":true}');
  assert.equal(completed.verdict, 'full_get_valid');
  assert.equal(completed.active_attempt_id, null);
  assert.equal(completed.claimed_at, null);
});

test('database CHECKs reject invalid approval claims and live attempts on terminal rows', (t) => {
  const { db, ledger } = setup(t);
  const action = declare(ledger);
  approve(ledger, action.id);

  // MUTATION: removing the post-approval hash CHECK permits hand-written mismatched execution.
  assert.throws(
    () => db.prepare(`
      UPDATE actions
      SET status = 'executing', approved_params_hash = ?,
          active_attempt_id = 'raw-mismatch', claimed_at = ?
      WHERE id = ?
    `).run('f'.repeat(64), '2026-08-05T00:00:00.000Z', action.id),
    { code: 'SQLITE_CONSTRAINT_CHECK' },
  );

  // MUTATION: removing the claim-time expiry CHECK permits execution after approval expiry.
  assert.throws(
    () => db.prepare(`
      UPDATE actions
      SET status = 'executing', approval_expires_at = ?,
          active_attempt_id = 'raw-expired', claimed_at = ?
      WHERE id = ?
    `).run(
      '2026-08-05T00:00:00.000Z',
      '2026-08-05T00:00:00.000Z',
      action.id,
    ),
    { code: 'SQLITE_CONSTRAINT_CHECK' },
  );

  // MUTATION: weakening the bidirectional attempt CHECK leaves a live fence on terminal state.
  assert.throws(
    () => db.prepare(`
      UPDATE actions
      SET status = 'succeeded', active_attempt_id = 'raw-terminal', claimed_at = ?
      WHERE id = ?
    `).run('2026-08-05T00:00:00.000Z', action.id),
    { code: 'SQLITE_CONSTRAINT_CHECK' },
  );
  assert.equal(ledger.getAction(action.id).status, 'queued');
});

test('logical idempotency is task and slot, with params only a conflict detector', (t) => {
  const { db, ledger } = setup(t);
  const first = declare(ledger);
  const same = declare(ledger, {
    params: {
      labels: ['P1', 'security', 'P1'],
      body: 'Do not trim me  ',
      title: 'Ship évidence',
      repo: 'ACME/WIDGETS',
    },
  });

  // MUTATION: using params_hash as identity creates another row instead of returning this id.
  assert.equal(same.id, first.id);
  assert.equal(db.prepare('SELECT count(*) AS count FROM actions').get().count, 1);
  assert.equal(ledger.listEvents(first.id).filter((event) => event.phase === 'action.declared').length, 1);

  // MUTATION: INSERT OR REPLACE or updating a reused row destroys immutable params/provenance.
  assert.throws(
    () => declare(ledger, { params: { ...BASE_PARAMS, title: 'Different intent data' } }),
    (error) => error.status === 409,
  );
  assert.equal(ledger.getAction(first.id).params_json, first.params_json);

  const second = declare(ledger, { actionSlot: 'follow-up' });
  assert.notEqual(second.id, first.id);
  assert.equal(db.prepare('SELECT count(*) AS count FROM actions').get().count, 2);
});

test('expiry CAS requeues for approval, audits once, and claim atomically rejects expiry', (t) => {
  const { ledger, setTime } = setup(t);
  const swept = declare(ledger, { actionSlot: 'swept' });
  approve(ledger, swept.id, { expiresAt: '2026-08-05T00:10:00.000Z' });
  setTime('2026-08-05T00:10:00.000Z');

  // MUTATION: changing <= to < incorrectly treats exact expiry as still valid.
  assert.equal(ledger.expireStaleApprovals(), 1);
  const expired = ledger.getAction(swept.id);
  assert.equal(expired.status, 'awaiting_approval');
  assert.equal(expired.approved_by, 'user-1', 'old approval provenance remains on the row');
  assert.equal(ledger.listEvents(swept.id).at(-1).phase, 'approval.expired');
  assert.equal(ledger.expireStaleApprovals(), 0);
  assert.equal(
    ledger.listEvents(swept.id).filter((event) => event.phase === 'approval.expired').length,
    1,
  );
  approve(ledger, swept.id, {
    approvedBy: 'user-2',
    policyVersion: 'policy-v2',
    expiresAt: '2026-08-05T00:30:00.000Z',
  });
  const approvalEvents = ledger.listEvents(swept.id)
    .filter((event) => event.phase === 'approval.queued')
    .map((event) => JSON.parse(event.receipt_json));
  assert.deepEqual(approvalEvents.map((event) => event.approved_by), ['user-1', 'user-2']);
  assert.deepEqual(approvalEvents.map((event) => event.approval_policy_version), [
    'policy-v1',
    'policy-v2',
  ]);

  const claimExpired = declare(ledger, { actionSlot: 'claim-expired' });
  approve(ledger, claimExpired.id, { expiresAt: '2026-08-05T00:20:00.000Z' });
  setTime('2026-08-05T00:20:00.000Z');
  // MUTATION: removing the expiry CAS/predicate allows an expired queued action to execute.
  assert.equal(ledger.claimForExecution(claimExpired.id), null);
  assert.equal(ledger.getAction(claimExpired.id).status, 'awaiting_approval');
  assert.equal(ledger.listEvents(claimExpired.id).at(-1).phase, 'approval.expired');
});

test('events append while actions retains only current state, and evidence cannot be rewritten', (t) => {
  const { db, ledger } = setup(t);
  const action = declare(ledger);
  approve(ledger, action.id);
  const attempt = ledger.claimForExecution(action.id);
  ledger.appendEvent(action.id, { phase: 'transport.observed', transportClass: 'response' });
  ledger.recordExecutionResult({ id: action.id, attemptId: attempt, status: 'failed', error: 'no effect' });

  const events = ledger.listEvents(action.id);
  assert.deepEqual(events.map((event) => event.phase), [
    'action.declared',
    'approval.queued',
    'execution.claimed',
    'transport.observed',
    'execution.result',
  ]);
  assert.equal(ledger.listActions().length, 1);
  assert.equal(ledger.getAction(action.id).status, 'failed');

  // MUTATION: removing the migration triggers permits evidence rewrite/deletion.
  assert.throws(
    () => db.prepare('UPDATE action_events SET phase = ? WHERE id = ?').run('rewritten', events[0].id),
    /action_events is append-only/,
  );
  assert.throws(
    () => db.prepare('DELETE FROM action_events WHERE id = ?').run(events[0].id),
    /action_events is append-only/,
  );
  const originalEvent = { ...events[0] };
  const rowCount = events.length;
  assert.deepEqual(
    db.pragma('index_list(action_events)').filter((index) => index.unique === 1),
    [],
    'no secondary UNIQUE index can provide another REPLACE conflict target',
  );
  // MUTATION: removing the BEFORE INSERT collision guard lets REPLACE overwrite evidence.
  assert.throws(
    () => db.prepare(`
      INSERT OR REPLACE INTO action_events (id, action_id, phase, ts)
      VALUES (?, ?, 'replacement', ?)
    `).run(events[0].id, action.id, '2026-08-05T00:00:00.000Z'),
    /action_events is append-only/,
  );
  assert.deepEqual(ledger.listEvents(action.id)[0], originalEvent);
  assert.equal(ledger.listEvents(action.id).length, rowCount);

  db.prepare(`
    INSERT INTO action_events (action_id, phase, ts)
    VALUES (?, 'plain.append', ?)
  `).run(action.id, '2026-08-05T00:00:01.000Z');
  assert.equal(ledger.listEvents(action.id).length, rowCount + 1);
  assert.equal(ledger.listEvents(action.id).at(-1).phase, 'plain.append');

  // MUTATION: accepting arbitrary receipt strings bypasses the JSON evidence contract.
  assert.throws(
    () => ledger.appendEvent(action.id, { phase: 'bad.receipt', receipt: 'not json' }),
    (error) => error.status === 400,
  );
});

test('public mutations translate SQLite constraints into AppError subclasses', (t) => {
  const { ledger } = setup(t);
  const first = declare(ledger, { actionSlot: 'external-first' });
  approve(ledger, first.id);
  const firstAttempt = ledger.claimForExecution(first.id);
  ledger.recordExecutionResult({
    id: first.id,
    attemptId: firstAttempt,
    status: 'succeeded',
    externalNodeId: 'NODE_unique',
  });

  const second = declare(ledger, { actionSlot: 'external-second' });
  approve(ledger, second.id);
  const secondAttempt = ledger.claimForExecution(second.id);
  // MUTATION: exposing raw SqliteError violates the public service error contract.
  assert.throws(
    () => ledger.recordExecutionResult({
      id: second.id,
      attemptId: secondAttempt,
      status: 'succeeded',
      externalNodeId: 'NODE_unique',
    }),
    (error) => error.status === 409 && error.constructor.name === 'ConflictError',
  );
  assert.equal(ledger.getAction(second.id).status, 'executing');
});

test('migration 085 applies on a fresh DB and enforces status and identity constraints', (t) => {
  const { db } = setup(t);
  assert.ok(db.prepare('SELECT 1 FROM schema_version WHERE version = 85').get());

  const insert = db.prepare(`
    INSERT INTO actions (
      id, task_id, action_slot, connector, operation,
      params_json, params_hash, status, created_at, external_node_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const values = (id, slot, status = 'awaiting_approval', externalNodeId = null) => [
    id,
    'task-migration',
    slot,
    'github',
    'github.create_issue',
    '{"body":"b","labels":[],"repo":"a/b","title":"t"}',
    'a'.repeat(64),
    status,
    '2026-08-05T00:00:00.000Z',
    externalNodeId,
  ];

  // MUTATION: removing the status CHECK allows undefined state-machine phases.
  assert.throws(() => insert.run(...values('bad-status', 'bad-status', 'not_a_status')), {
    code: 'SQLITE_CONSTRAINT_CHECK',
  });
  insert.run(...values('first', 'same-slot'));
  // MUTATION: removing UNIQUE(task_id, action_slot) allows duplicate logical intent.
  assert.throws(() => insert.run(...values('duplicate', 'same-slot')), {
    code: 'SQLITE_CONSTRAINT_UNIQUE',
  });
  insert.run(...values('external-1', 'external-1', 'awaiting_approval', 'NODE_same'));
  assert.throws(
    () => insert.run(...values('external-2', 'external-2', 'awaiting_approval', 'NODE_same')),
    { code: 'SQLITE_CONSTRAINT_UNIQUE' },
  );
  assert.throws(
    () => insert.run(
      'bad-hash',
      'task-migration',
      'bad-hash',
      'github',
      'github.create_issue',
      '{"body":"b","labels":[],"repo":"a/b","title":"t"}',
      'G'.repeat(64),
      'awaiting_approval',
      '2026-08-05T00:00:00.000Z',
      null,
    ),
    { code: 'SQLITE_CONSTRAINT_CHECK' },
  );
});
