'use strict';

// G3 — the goal verdict RECONCILER (spec §5d). Turns a terminal goal attempt
// into exactly one durable verdict and drives its side effects idempotently from
// PERSISTED state, so a duplicate harvest, a concurrent reconciler, or a crash
// mid-flight all converge to the same single outcome.
//
// Model (codex plan-review R1→R4):
//   settle(runId)   — compute inputs → decide verdict → ONE atomic tx
//                     (verdict CAS + retry child + link + pending outbox) → if
//                     this call won the CAS, reconcile.
//   reconcile(runId)— from the persisted verdict: transition the task, dispatch
//                     pending outbox effects, and (retry) scheduleDrain a still-
//                     queued child. Idempotent — safe to re-run at boot/runtime.
//   dispatchEffects — replayable outbox pump: pending → emit → mark 'sent'. A
//                     crash before 'sent' re-drives next time (AT-LEAST-ONCE,
//                     never-lost); webhook subscribers dedup on the stable key
//                     `${run_id}:${effect_type}`.
//   sweep()         — boot: settle every unverdicted terminal goal run, then
//                     reconcile every verdicted one (redrive undelivered effects).
//
// The verdict decision itself is the pure decideGoalVerdict (§4). This layer only
// gathers inputs + persists + dispatches; it never re-decides a settled verdict.

const crypto = require('node:crypto');
const { decideGoalVerdict, VERDICT_TO_TASK_STATUS } = require('./goalVerdict');

const DEFAULT_BUDGET = 3;

// Terminal infra failures that a fresh attempt cannot fix — a goal run carrying
// one is non-retryable (→ error/review), never looped. Fixed set (cardinality
// discipline): materialize fail-closed + preset preflight blockers.
const NON_RETRYABLE_EVENT_TYPES = new Set([
  'run:repo_materialize_unavailable',
  'preset:mcp_invalid',
  'preset:mcp_unreachable',
]);

function sha256Short(str) {
  return crypto.createHash('sha256').update(String(str)).digest('hex').slice(0, 16);
}

function createGoalVerdictService({
  runService,
  taskService = null,
  eventBus = null,
  scheduleDrain = null,
  // Optional predicate: has the repo source moved under this attempt's lineage?
  // Default false (legacy/deliverable runs never move; repo drift is also caught
  // by the Operator 409 guard). Kept injectable for the repo wiring + tests.
  isSourceChanged = null,
  decide = decideGoalVerdict,
  verdictToTaskStatus = VERDICT_TO_TASK_STATUS,
  logger = console,
} = {}) {
  if (!runService) throw new Error('goalVerdictService requires runService');

  function warn(msg) {
    try { (logger && logger.warn ? logger.warn : console.warn)(msg); } catch { /* ignore */ }
  }

  function parseAcceptance(run) {
    if (!run || run.acceptance_json == null) return null;
    try {
      const a = typeof run.acceptance_json === 'string' ? JSON.parse(run.acceptance_json) : run.acceptance_json;
      return (a && typeof a === 'object') ? a : null;
    } catch { return null; }
  }

  function computeFingerprint(run, acceptance) {
    // The failure SIGNATURE — comparing this attempt's to the previous attempt's
    // detects "same failure twice → no progress". For a gate-failed completed run
    // the signature is the acceptance shape; for a process failure it is the
    // terminal status + exit code.
    const sig = acceptance
      ? { g: acceptance.gate ?? null, k: acceptance.kind ?? null, s: acceptance.status ?? null, p: acceptance.passed ?? null, r: acceptance.reason ?? null }
      : { st: run.status, ex: run.exit_code ?? null };
    return sha256Short(JSON.stringify(sig));
  }

  function isNonRetryable(run) {
    // A failure that never entered execution (no started_at) is a setup/infra
    // failure — mirror B-lite's "only started runs retry" and route it to review.
    if (run.status === 'failed' && !run.started_at) return true;
    let events = [];
    try { events = runService.getRunEvents(run.id) || []; } catch { events = []; }
    return events.some((e) => NON_RETRYABLE_EVENT_TYPES.has(e.event_type));
  }

  function taskBudget(run) {
    if (!taskService || !run.task_id) return DEFAULT_BUDGET;
    try {
      const t = taskService.getTask(run.task_id);
      const n = Number(t && t.goal_max_attempts);
      return Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET;
    } catch { return DEFAULT_BUDGET; }
  }

  function computeInputs(run) {
    const acceptance = parseAcceptance(run);
    const attemptsUsed = Number(run.retry_count || 0) + 1;
    const budget = taskBudget(run);
    const fingerprint = computeFingerprint(run, acceptance);
    const priorFp = runService.getGoalRetryParentFingerprint(run.id);
    const fingerprintRepeat = !!(priorFp && priorFp === fingerprint);
    let sourceChanged = false;
    if (typeof isSourceChanged === 'function') {
      try { sourceChanged = !!isSourceChanged(run); } catch { sourceChanged = false; }
    }
    const nonRetryable = run.status === 'failed' && isNonRetryable(run);
    return { acceptance, attemptsUsed, budget, fingerprint, fingerprintRepeat, sourceChanged, nonRetryable };
  }

  function buildRetryChild(run) {
    return {
      task_id: run.task_id,
      agent_profile_id: run.agent_profile_id,
      prompt: run.prompt || '',
      node_id: run.node_id || 'local',
      queued_args: run.queued_args || null,
      retry_count: Number(run.retry_count || 0) + 1,
      operator_instance_id: run.operator_instance_id || null,
      parent_run_id: run.parent_run_id || null,
      retry_root_run_id: run.retry_root_run_id || run.id,
    };
  }

  function effectTypesFor(verdict) {
    const types = ['goal:verdict'];
    if (verdict === 'exhausted') types.push('goal:exhausted');
    if (verdict === 'error') types.push('goal:error');
    return types;
  }

  // The replayable outbox pump. pending → emit → mark 'sent'. Never throws; an
  // emit that throws leaves the effect 'pending' for the next drive.
  function dispatchEffects(runId) {
    let run = null;
    try { run = runService.getRun(runId); } catch { return; }
    let pending = [];
    try { pending = runService.listPendingGoalEffects(runId); } catch { pending = []; }
    for (const effectType of pending) {
      const payload = {
        run_id: runId,
        task_id: run.task_id || null,
        project_id: run.project_id || null,
        node_id: run.node_id || null,
        verdict: run.goal_verdict || null,
        reason: run.goal_verdict_reason || null,
        attempt: Number(run.retry_count || 0) + 1,
        // Stable idempotency key — webhook receivers dedup on this across
        // at-least-once re-drives (reboot / crash before 'sent').
        idempotency_key: `${runId}:${effectType}`,
      };
      try {
        if (eventBus) eventBus.emit(effectType, payload);
        runService.markGoalEffectSent(runId, effectType);
      } catch (err) {
        // Leave 'pending' — the next reconcile/boot re-drives it.
        warn(`[goalVerdict] effect dispatch failed run=${runId} effect=${effectType}: ${err && err.message}`);
      }
    }
  }

  // Idempotent reconciliation from the persisted verdict.
  function reconcile(runId) {
    let run = null;
    try { run = runService.getRun(runId); } catch { return; }
    if (!run.goal_verdict) return;

    const target = verdictToTaskStatus[run.goal_verdict];
    if (target && run.task_id && taskService) {
      try { taskService.updateTaskStatus(run.task_id, target); } catch { /* task may be gone */ }
    }

    dispatchEffects(runId);

    if (run.goal_verdict === 'retry' && run.goal_retry_run_id && scheduleDrain) {
      let child = null;
      try { child = runService.getRun(run.goal_retry_run_id); } catch { child = null; }
      // Always re-drive a still-queued child (a missed post-commit drain, or a
      // concurrent reconciler, self-heals here). Actual spawn stays single via
      // claimQueuedRun's queued→running CAS.
      if (child && child.status === 'queued') {
        try { scheduleDrain(child.agent_profile_id); } catch (err) { warn(`[goalVerdict] scheduleDrain failed: ${err && err.message}`); }
      }
    }
  }

  // Settle a terminal goal attempt: decide → persist (atomic) → reconcile if won.
  // Safe to call multiple times (already-verdicted → straight to reconcile). Only
  // ever acts on a goal-active, terminal run.
  function settle(runId) {
    let run = null;
    try { run = runService.getRun(runId); } catch { return { settled: false }; }
    if (!run || run.is_manager || !run.goal_active || !run.task_id) return { settled: false };
    const terminal = ['completed', 'failed', 'cancelled', 'stopped'].includes(run.status);
    if (!terminal) return { settled: false };

    // Already settled → just (re)reconcile idempotently.
    if (run.goal_verdict) { reconcile(runId); return { settled: true, winner: false, verdict: run.goal_verdict }; }

    // cancelled/stopped are NOT attempts (§5d matrix) — no verdict; the task
    // goes to review via checkTaskCompletion. Leave goal_verdict NULL.
    if (run.status === 'cancelled' || run.status === 'stopped') return { settled: false };

    const inputs = computeInputs(run);
    let decision;
    try {
      decision = decide({
        status: run.status,
        acceptance: inputs.acceptance,
        attemptsUsed: inputs.attemptsUsed,
        budget: inputs.budget,
        fingerprintRepeat: inputs.fingerprintRepeat,
        sourceChanged: inputs.sourceChanged,
        nonRetryable: inputs.nonRetryable,
      });
    } catch (err) {
      warn(`[goalVerdict] decide threw run=${runId}: ${err && err.message}`);
      return { settled: false };
    }

    const retryChild = decision.verdict === 'retry' ? buildRetryChild(run) : null;
    let result;
    try {
      result = runService.persistGoalVerdictTx({
        runId,
        verdict: decision.verdict,
        reason: decision.reason,
        fingerprint: inputs.fingerprint,
        effectTypes: effectTypesFor(decision.verdict),
        retryChild,
      });
    } catch (err) {
      warn(`[goalVerdict] persist tx failed run=${runId}: ${err && err.message}`);
      return { settled: false };
    }

    if (!result.winner) {
      // Another settle won the CAS — it (or a reconcile) drives the effects.
      return { settled: true, winner: false };
    }

    try {
      runService.addRunEvent(runId, 'goal:verdict', JSON.stringify({
        verdict: decision.verdict,
        reason: decision.reason,
        attempt: inputs.attemptsUsed,
        budget: inputs.budget,
        retry_run_id: result.childId || null,
      }));
    } catch { /* annotate-only */ }

    reconcile(runId);
    return { settled: true, winner: true, verdict: decision.verdict, childId: result.childId || null };
  }

  // Boot sweeper (§5d): settle every unverdicted terminal goal run (crash mid-
  // harvest), then reconcile every verdicted one to redrive any 'pending' effect
  // + repair a missed transition/drain. Never throws.
  function sweep() {
    let unverdicted = [];
    let verdicted = [];
    try { unverdicted = runService.listUnverdictedTerminalGoalRunIds(); } catch { unverdicted = []; }
    for (const id of unverdicted) {
      try { settle(id); } catch (err) { warn(`[goalVerdict] sweep settle failed run=${id}: ${err && err.message}`); }
    }
    try { verdicted = runService.listVerdictedTerminalGoalRunIds(); } catch { verdicted = []; }
    for (const id of verdicted) {
      try { reconcile(id); } catch (err) { warn(`[goalVerdict] sweep reconcile failed run=${id}: ${err && err.message}`); }
    }
    // Belt-and-suspenders (codex R4 residual): directly redrive ANY run still
    // carrying a 'pending' outbox effect, even one the verdicted scan missed.
    let pendingRuns = [];
    try { pendingRuns = runService.listRunIdsWithPendingGoalEffects(); } catch { pendingRuns = []; }
    for (const id of pendingRuns) {
      try { dispatchEffects(id); } catch (err) { warn(`[goalVerdict] sweep dispatch failed run=${id}: ${err && err.message}`); }
    }
    return { swept: unverdicted.length, reconciled: verdicted.length, redriven: pendingRuns.length };
  }

  return {
    settle,
    reconcile,
    dispatchEffects,
    sweep,
    // exposed for tests
    computeInputs,
    effectTypesFor,
  };
}

module.exports = { createGoalVerdictService, NON_RETRYABLE_EVENT_TYPES };
