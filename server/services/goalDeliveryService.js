'use strict';

// G4b §5j — goal 산출물 전달. When a goal task is marked 'done' (Operator/human
// accepted the gate2 attempt), promote that accepted attempt's surviving branch
// onto a stable `palantir/goal/<taskId>` ref (code mode) or record the deliverable
// bundle (deliverable mode) so a human always has a clear artifact to review/merge.
//
// SAFETY (codex plan-review): delivery is annotate-only + never-throws and runs
// AFTER the done transition, so it can never block or revert 'done'.
//   B1 (unaccepted code): the delivering attempt is the LINEAGE TIP (newest goal
//       run) and it MUST be verdict='gate2' — never an older gate2 or an
//       exhausted/error branch.
//   B2 (done-race): the tasks.goal_delivery_json column is a DB-CAS claim that
//       captures the accepted run identity + serializes concurrent deliveries
//       (the task:updated trigger + the manual re-deliver route). Promoting the
//       immutable accepted attempt is correct even if new work starts.
//   B3 (override): there is NO path to promote a non-gate2 attempt — the manual
//       route just re-runs deliver(), which enforces the gate2-tip rule.

const ACTIVE_STATUSES = ['queued', 'materializing', 'running', 'needs_input', 'paused'];

function createGoalDeliveryService({
  runService,
  taskService,
  projectService = null,
  worktreeService = null,
  goalFeatureActive = () => false,
  logger = console,
  now = () => new Date().toISOString(),
} = {}) {
  if (!runService || !taskService) throw new Error('goalDeliveryService requires runService + taskService');

  function warn(msg) { try { (logger && logger.warn ? logger.warn : console.warn)(msg); } catch { /* ignore */ } }
  function safeTaskSeg(id) { return String(id || '').replace(/[^a-zA-Z0-9_-]/g, ''); }
  function emit(runId, type, payload) {
    if (!runId) return;
    try { runService.addRunEvent(runId, type, JSON.stringify(payload)); } catch { /* annotate-only */ }
  }
  function getProject(projectId) {
    if (!projectId || !projectService) return null;
    try { return projectService.getProject(projectId); } catch { return null; }
  }
  function listGoalRuns(taskId) {
    let runs = [];
    try { runs = runService.listRuns({ task_id: taskId }) || []; } catch { return []; }
    return runs.filter((r) => r && r.goal_active && !r.is_manager);
  }
  // The lineage TIP — query-backed (rowid DESC) so tip selection never depends on
  // a JS reduce over a possibly-absent _seq (codex BLOCKER). fail-closed to null.
  function newestGoalRun(taskId) {
    try { return runService.getNewestGoalRun(taskId) || null; } catch { return null; }
  }
  function hasActiveGoalRun(taskId) {
    return listGoalRuns(taskId).some((r) => ACTIVE_STATUSES.includes(r.status));
  }
  // Record a pre-claim failure ONLY when the CAS wins (don't report failure while
  // a concurrent caller is delivering/delivered — codex MINOR). Emits the event
  // only on a successful record.
  function recordPreFailure(taskId, runId, reason) {
    const rec = JSON.stringify({ mode: null, run_id: runId || null, state: 'failed', reason, at: now() });
    let recorded = false;
    try { recorded = taskService.recordGoalDeliveryPreFailure(taskId, rec); } catch { recorded = false; }
    if (recorded) emit(runId, 'goal:deliver_failed', { task_id: taskId, run_id: runId || null, reason });
    return recorded;
  }
  // Settle the claim to 'failed' (scoped to run_id + 'delivering') + emit. Used
  // when promotion or a delivered-settlement fails — leaves a reclaimable 'failed'
  // record so a manual re-deliver can retry (git branch -f is idempotent).
  function recordPostFailure(taskId, runId, reason, { mode = 'branch', err = null } = {}) {
    const rec = JSON.stringify({ mode, run_id: runId, state: 'failed', reason, error: err ? String((err && err.message) || err).slice(0, 500) : undefined, at: now() });
    try { taskService.settleGoalDelivery(taskId, runId, rec); } catch { /* best-effort recovery */ }
    emit(runId, 'goal:deliver_failed', { task_id: taskId, run_id: runId, reason });
  }

  // deliver(taskId): idempotent, never-throws. Returns a small status object.
  async function deliver(taskId) {
    try {
      if (!goalFeatureActive()) return { delivered: false, reason: 'goal_mode_off' };
      let task;
      try { task = taskService.getTask(taskId); } catch { return { delivered: false, reason: 'no_task' }; }
      if (!task || !task.goal_enabled) return { delivered: false, reason: 'not_goal_task' };
      if (task.status !== 'done') return { delivered: false, reason: 'not_done' };

      let existing = null;
      try { existing = task.goal_delivery_json ? JSON.parse(task.goal_delivery_json) : null; } catch { existing = null; }
      if (existing && existing.state === 'delivered') return { delivered: true, reason: 'already_delivered' };

      // B3-race: a retry / fresh attempt in flight → defer (a premature done that
      // syncTaskStatus may revert; don't promote mid-flight work).
      if (hasActiveGoalRun(taskId)) return { delivered: false, reason: 'active_run' };

      // B1: the accepted attempt is the tip and MUST be gate2.
      const tip = newestGoalRun(taskId);
      if (!tip || tip.goal_verdict !== 'gate2') {
        recordPreFailure(taskId, tip ? tip.id : null, 'no_accepted_attempt');
        return { delivered: false, reason: 'no_accepted_attempt' };
      }

      const project = getProject(task.project_id);
      const isRepoSource = !!(project && project.source_type === 'git');

      // Materialized git-source projects: branch lives in a per-run cache that may
      // be gone — repo delivery is a follow-up (§5e/repo). Surface as failed.
      if (isRepoSource) {
        recordPreFailure(taskId, tip.id, 'repo_delivery_deferred');
        return { delivered: false, reason: 'repo_delivery_deferred' };
      }

      const codeMode = !!(tip.branch && project && project.directory && worktreeService && typeof worktreeService.promoteGoalBranch === 'function');
      const deliverableMode = !codeMode && !!(task.deliverable_json || tip.goal_workspace_path);

      if (!codeMode && !deliverableMode) {
        recordPreFailure(taskId, tip.id, 'no_deliverable');
        return { delivered: false, reason: 'no_deliverable' };
      }

      // CLAIM (B2): capture the accepted run identity + serialize. Loses to a
      // concurrent deliver that already claimed (delivering/delivered).
      const claimRec = JSON.stringify({ mode: codeMode ? 'branch' : 'deliverable', run_id: tip.id, state: 'delivering', started_at: now() });
      if (!taskService.claimGoalDelivery(taskId, claimRec)) {
        return { delivered: false, reason: 'claim_lost' };
      }

      // Helper: settle the 'delivered' record in ISOLATION (codex SERIOUS). A
      // settle that throws/returns-false after a successful side effect must NOT
      // fall into a retry loop or strand the claim as 'delivering' forever — it
      // recovers to a reclaimable 'failed' so a manual re-deliver can retry.
      const finishDelivered = (record, okResult) => {
        let settled = false;
        try { settled = taskService.settleGoalDelivery(taskId, tip.id, JSON.stringify(record)); } catch { settled = false; }
        if (settled) {
          emit(tip.id, 'goal:delivered', { task_id: taskId, run_id: tip.id, mode: record.mode, branch: record.branch });
          return okResult;
        }
        recordPostFailure(taskId, tip.id, 'settle_failed', { mode: record.mode });
        return { delivered: false, reason: 'settle_failed' };
      };

      if (codeMode) {
        let result;
        try {
          result = await worktreeService.promoteGoalBranch(
            project.directory,
            tip.branch,
            `palantir/goal/${safeTaskSeg(taskId)}`,
          );
        } catch (err) {
          recordPostFailure(taskId, tip.id, 'promote_failed', { mode: 'branch', err });
          return { delivered: false, reason: 'promote_failed' };
        }
        // Promotion succeeded (idempotent) — settlement is isolated below.
        return finishDelivered(
          { mode: 'branch', run_id: tip.id, state: 'delivered', branch: result.branch, base: result.base, stat: result.stat, delivered_at: now() },
          { delivered: true, mode: 'branch', branch: result.branch },
        );
      }

      // deliverable mode: the bundle already survives (G2 copied it out); record it.
      let bundle = null;
      try { bundle = task.deliverable_json ? JSON.parse(task.deliverable_json) : null; } catch { bundle = null; }
      return finishDelivered(
        { mode: 'deliverable', run_id: tip.id, state: 'delivered', bundle, delivered_at: now() },
        { delivered: true, mode: 'deliverable' },
      );
    } catch (err) {
      warn(`[goalDelivery] deliver failed task=${taskId}: ${err && err.message}`);
      return { delivered: false, reason: 'internal_error' };
    }
  }

  return { deliver };
}

module.exports = { createGoalDeliveryService, ACTIVE_STATUSES };
