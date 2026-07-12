'use strict';

// G3 — pure verdict decision function (spec §4).
//
// Given the terminal facts of a goal attempt, decide what happens next. This is
// the SINGLE deterministic policy point; the harvest pipeline computes the
// inputs, CAS-persists the returned verdict, and drives task transition +
// retry + suppression from the PERSISTED value (never from a subscriber's own
// re-decision). Judge (Gate 1.5) is a separate flag (G3c) — not modeled here.
//
// verdict ∈ retry | gate2 | exhausted | error.  reason is a FIXED enum (never a
// raw exception string) so it is safe to surface in a webhook payload (§5d).
//
// Gate eligibility (§5k-3): only a HUMAN-provenance check that actually RAN and
// FAILED gates a verdict. An operator-authored (advisory) check, a skipped
// check, an absent check, or a passing check does NOT fail the gate — those go
// to Gate 2 (semantic review).

function decideGoalVerdict({
  status,                 // 'completed' | 'failed'
  acceptance = null,      // { gate, status:'ran'|'skipped', passed:bool|null, reason } | null
  judge = null,           // G3c §5k-4: { status:'pass'|'fail'|'error', ... } | null
  attemptsUsed = 1,
  budget = 3,
  fingerprintRepeat = false,
  sourceChanged = false,
  nonRetryable = false,
} = {}) {
  // Infra-level failures never retry (§5d): materialize fail-closed, preflight,
  // corrupt queued_args, etc. Checked first.
  if (status === 'failed' && nonRetryable) return { verdict: 'error', reason: 'non_retryable' };

  // Source moved under the attempt lineage — the diff/verdict base is invalid.
  if (sourceChanged) return { verdict: 'error', reason: 'source_changed' };

  const budgetLeft = Number(attemptsUsed) < Number(budget);

  // A retryable process failure: retry within budget, else exhausted.
  if (status === 'failed') {
    return budgetLeft ? { verdict: 'retry', reason: null } : { verdict: 'exhausted', reason: 'exhausted' };
  }

  // completed — evaluate Gate 1 (machine check) + Gate 1.5 (judge). Only a GATING
  // check that RAN and FAILED counts for Gate 1. For the judge, ONLY status==='fail'
  // gates — error/timeout/schema-mismatch/disabled/absent fail OPEN to Gate 2
  // (§5k-4). judge PASS never makes 'done' — it routes to Gate 2 (→ human final).
  const gateFailed = !!(acceptance && acceptance.gate && acceptance.status === 'ran' && acceptance.passed === false);
  const judgeFailed = !!(judge && judge.status === 'fail');
  if (gateFailed || judgeFailed) {
    // Same failure fingerprint twice → no progress → escalate to Gate 2 early.
    if (fingerprintRepeat) return { verdict: 'gate2', reason: 'no_progress' };
    // Judge FAIL loops retry within budget; at budget exhaustion it exhausts
    // (→ task failed), with Gate 2 still receiving the review. Reason surfaces a
    // judge-only failure (Gate 1 passed but the rubric judge rejected the content).
    if (budgetLeft) return { verdict: 'retry', reason: (judgeFailed && !gateFailed) ? 'judge_fail' : null };
    return { verdict: 'exhausted', reason: 'exhausted' };
  }

  // completed + (gate passed | no gate | advisory-only | check skipped) + (judge
  // pass | error | skipped | absent) → Gate 2. A skipped machine check is surfaced
  // (not a silent pass) via the reason.
  const reason = (acceptance && acceptance.status === 'skipped')
    ? (acceptance.reason || 'runner_unavailable')
    : null;
  return { verdict: 'gate2', reason };
}

// Task status a verdict drives (§5g). error → review (human judgement needed).
const VERDICT_TO_TASK_STATUS = {
  retry: 'in_progress',
  gate2: 'review',
  exhausted: 'failed',
  error: 'review',
};

module.exports = { decideGoalVerdict, VERDICT_TO_TASK_STATUS };
