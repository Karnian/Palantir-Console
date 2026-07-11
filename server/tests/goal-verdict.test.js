// G3 — decideGoalVerdict pure function: the §4 verdict table, exhaustively.

const test = require('node:test');
const assert = require('node:assert/strict');
const { decideGoalVerdict, VERDICT_TO_TASK_STATUS } = require('../services/goalVerdict');

const gateFail = { gate: true, status: 'ran', passed: false };
const gatePass = { gate: true, status: 'ran', passed: true };
const advisoryFail = { gate: false, status: 'ran', passed: false };
const skipped = { gate: true, status: 'skipped', reason: 'runner_unavailable' };

test('error: failed + nonRetryable → error/non_retryable (checked first)', () => {
  assert.deepEqual(decideGoalVerdict({ status: 'failed', nonRetryable: true, attemptsUsed: 1, budget: 3 }),
    { verdict: 'error', reason: 'non_retryable' });
  // nonRetryable wins even with budget left
  assert.equal(decideGoalVerdict({ status: 'failed', nonRetryable: true, sourceChanged: true }).reason, 'non_retryable');
});

test('error: sourceChanged → error/source_changed', () => {
  assert.deepEqual(decideGoalVerdict({ status: 'completed', sourceChanged: true, acceptance: gatePass }),
    { verdict: 'error', reason: 'source_changed' });
});

test('failed (retryable): retry within budget, exhausted at/over budget', () => {
  assert.deepEqual(decideGoalVerdict({ status: 'failed', attemptsUsed: 1, budget: 3 }), { verdict: 'retry', reason: null });
  assert.deepEqual(decideGoalVerdict({ status: 'failed', attemptsUsed: 3, budget: 3 }), { verdict: 'exhausted', reason: 'exhausted' });
  assert.deepEqual(decideGoalVerdict({ status: 'failed', attemptsUsed: 4, budget: 3 }), { verdict: 'exhausted', reason: 'exhausted' });
});

test('completed + gate FAIL: retry (budget, no repeat) / gate2 no_progress (repeat) / exhausted (over budget)', () => {
  assert.deepEqual(decideGoalVerdict({ status: 'completed', acceptance: gateFail, attemptsUsed: 1, budget: 3 }),
    { verdict: 'retry', reason: null });
  assert.deepEqual(decideGoalVerdict({ status: 'completed', acceptance: gateFail, fingerprintRepeat: true, attemptsUsed: 1, budget: 3 }),
    { verdict: 'gate2', reason: 'no_progress' });
  assert.deepEqual(decideGoalVerdict({ status: 'completed', acceptance: gateFail, attemptsUsed: 3, budget: 3 }),
    { verdict: 'exhausted', reason: 'exhausted' });
});

test('completed + gate PASS / no check / advisory-fail / skipped → gate2', () => {
  assert.deepEqual(decideGoalVerdict({ status: 'completed', acceptance: gatePass }), { verdict: 'gate2', reason: null });
  assert.deepEqual(decideGoalVerdict({ status: 'completed', acceptance: null }), { verdict: 'gate2', reason: null });
  // advisory (operator) check failing does NOT gate → still gate2
  assert.deepEqual(decideGoalVerdict({ status: 'completed', acceptance: advisoryFail }), { verdict: 'gate2', reason: null });
  // skipped machine check surfaces its reason (not a silent pass)
  assert.deepEqual(decideGoalVerdict({ status: 'completed', acceptance: skipped }), { verdict: 'gate2', reason: 'runner_unavailable' });
});

test('VERDICT_TO_TASK_STATUS map (§5g)', () => {
  assert.deepEqual(VERDICT_TO_TASK_STATUS, { retry: 'in_progress', gate2: 'review', exhausted: 'failed', error: 'review' });
});
