// server/services/pmCleanupService.js
//
// v3 Phase 3a: single owner of PM cleanup (spec §5 책임 분담표,
// docs/specs/manager-v3-multilayer.md). Before 3a the responsibility was
// distributed across UI handlers, project delete paths, and ad-hoc reset
// buttons — which is exactly how Codex review flagged it as a책임 공백
// risk. This module centralizes all four termination paths:
//
//   reset(projectId)   — manual reset OR adapter switch. Clears
//                        pm_thread_id/pm_adapter in project_briefs,
//                        disposes any live adapter session for the PM,
//                        and drops the managerRegistry slot. A follow-up
//                        message will trigger lazy spawn → fresh thread.
//
//   dispose(projectId) — pm_enabled=false toggle OR project delete
//                        cascade. Semantically identical to reset for
//                        now; the distinction exists so we can evolve
//                        them independently (e.g., dispose could also
//                        delete the brief row in future cleanups).
//
// NOT in scope (per spec §10 risk table):
//   - Vendor-side orphan thread cleanup (Codex keeps its own server-side
//     thread state; we can only drop OUR references). Documented as
//     accepted risk.
//   - pm_enabled=false toggling itself (that's projectService's job —
//     this service only reacts to it by tearing down PM state).

function createPmCleanupService({
  projectService,
  projectBriefService,
  managerRegistry,
  managerAdapterFactory,
  runService,
  logger,
}) {
  const log = logger || ((msg) => console.log(`[pmCleanup] ${msg}`));

  // Core termination routine shared by reset and dispose. Idempotent —
  // safe to call when no PM is live. Returns { disposed: boolean,
  // clearedBrief: boolean } so callers (routes/tests) can report exactly
  // what happened.
  function _terminate(projectId, reason) {
    if (!projectId) throw new Error('projectId is required');

    const slotKey = `pm:${projectId}`;
    let disposed = false;
    let clearedBrief = false;
    let cancelledRunId = null;

    // 1. Dispose the live adapter session (if any). We read the registry
    //    BEFORE clearActive so we have the adapter reference — the slot
    //    clear listener in app.js will scrub the pending-notice queue
    //    keyed by the dying run id.
    //
    // Codex R2 blocker: disposeSession errors MUST propagate. Previously
    // we logged and continued, which made the DELETE route's 502 refusal
    // unreachable and turned `/reset` into a false-success. The whole
    // point of single-owner cleanup is that the caller (route handler)
    // can trust success: if it returns normally, the PM is truly gone.
    // If adapter teardown fails we throw immediately — BEFORE clearing
    // the registry slot or the brief — so the caller's retry (manual
    // /reset or retry DELETE) is meaningful. Partial state is worse
    // than a clean failure.
    const liveRunId = managerRegistry.getActiveRunId(slotKey);
    const liveAdapter = managerRegistry.getActiveAdapter(slotKey);
    if (liveRunId && liveAdapter) {
      try {
        liveAdapter.disposeSession(liveRunId);
      } catch (err) {
        log(`dispose failed for ${slotKey} (run=${liveRunId}): ${err.message}`);
        const wrap = new Error(`PM adapter disposeSession failed for ${slotKey} (run=${liveRunId}): ${err.message}`);
        wrap.httpStatus = 502;
        wrap.cause = err;
        throw wrap;
      }
      // Persist the run row as cancelled so it stops appearing in "active
      // managers" lists. Force bypasses the state machine — we may be
      // tearing down a run that's stuck in needs_input.
      try {
        if (runService) runService.updateRunStatus(liveRunId, 'cancelled', { force: true });
      } catch { /* already terminal */ }
      cancelledRunId = liveRunId;
      disposed = true;
    }

    // 2. Drop the registry slot. This fires the onSlotCleared listener
    //    wired in app.js, which scrubs conversationService's pending
    //    parent-notice queue keyed by the old runId. If no slot existed
    //    this is a no-op.
    managerRegistry.clearActive(slotKey);

    // 3. Clear the persisted pm_thread_id / pm_adapter on the brief row
    //    so the next lazy spawn starts a fresh thread. Idempotent — the
    //    brief service's clearPmThread returns null if no row exists.
    try {
      if (projectBriefService) {
        const before = projectBriefService.getBrief(projectId);
        if (before && before.pm_thread_id) {
          projectBriefService.clearPmThread(projectId);
          clearedBrief = true;
        }
      }
    } catch (err) {
      log(`brief clear failed for ${projectId}: ${err.message}`);
    }

    log(`${reason} projectId=${projectId} disposed=${disposed} clearedBrief=${clearedBrief}`);
    return { disposed, clearedBrief, cancelledRunId };
  }

  function reset(projectId) {
    return _terminate(projectId, 'reset');
  }

  function dispose(projectId) {
    return _terminate(projectId, 'dispose');
  }

  return { reset, dispose };
}

module.exports = { createPmCleanupService };
