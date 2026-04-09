// server/services/managerRegistry.js
//
// v3 Phase 1.5: single source of truth for "which manager runs are active
// right now". Before 1.5, routes/manager.js kept `activeManagerRunId` in a
// module-local closure — fine when only one Top manager existed, but then
// the new /api/conversations router also needed to talk to the same live
// session. Two routers sharing mutable state via a global were the only
// options, so the state is lifted into a tiny registry that both import.
//
// The registry is intentionally narrow:
//   * keyed by conversation id ('top' | 'pm:<projectId>')
//   * stores runId + adapter reference
//   * probeActive() does the liveness + exit-code + cleanup dance that
//     routes/manager.js used to do inline, so both callers get identical
//     semantics.
//
// PM layer ('pm:<projectId>') is reserved for Phase 3a. Phase 1.5 only
// populates the 'top' slot. Enumerating PM now means the registry shape
// doesn't have to change later.

function createManagerRegistry({ runService }) {
  // conversationId -> { runId, adapter }
  const active = new Map();
  // listeners fired whenever a slot is cleared (explicit stop OR liveness
  // probe detecting a dead session OR replacement via setActive). Each
  // listener receives ({ conversationId, runId }). Consumers register
  // here to scrub auxiliary state keyed by the dying run id — e.g.,
  // conversationService.clearParentNotices — without this registry having
  // to import conversationService. v3 Phase 2 fixes a codex-R1 finding
  // where PM notice queues survived PM rotation and became undrainable.
  const slotClearedListeners = [];
  function notifySlotCleared(conversationId, runId) {
    for (const cb of slotClearedListeners) {
      try { cb({ conversationId, runId }); } catch { /* ignore */ }
    }
  }

  function setActive(conversationId, runId, adapter) {
    if (!conversationId) throw new Error('conversationId required');
    if (!runId) throw new Error('runId required');
    if (!adapter) throw new Error('adapter required');
    // If a previous entry existed for this slot, treat the swap as a
    // clear for the OLD run id so listeners can scrub per-runId state
    // before we overwrite. This covers PM slot rotation (new PM run
    // replaces an old one without anyone calling clearActive first).
    //
    // PR2 / P1-4: also dispose the previous adapter session. Prior to
    // this, a setActive() that implicitly replaced an earlier run (e.g.
    // PM re-spawn through pmSpawnService) left the old subprocess + its
    // working tmp dir behind. The registry is the only component that
    // actually sees the rotation, so disposal has to happen here.
    // Wrap in try/catch — dispose failure must NOT prevent the new run
    // from becoming active (that would strand the caller with no slot
    // at all and half-initialized state).
    const prev = active.get(conversationId);
    if (prev && prev.runId !== runId) {
      try {
        if (prev.adapter && typeof prev.adapter.disposeSession === 'function') {
          prev.adapter.disposeSession(prev.runId);
        }
      } catch (err) {
        // Log-and-continue: the new run still gets the slot. If the old
        // subprocess leaked, it will be caught by the next lifecycle
        // sweep or by shutdown (PR2 / P1-5).
        console.warn(`[managerRegistry] disposeSession failed during setActive replacement of ${conversationId}/${prev.runId}:`, err && err.message);
      }
      notifySlotCleared(conversationId, prev.runId);
    }
    active.set(conversationId, { runId, adapter });
  }

  function clearActive(conversationId) {
    const entry = active.get(conversationId);
    if (!entry) return;
    active.delete(conversationId);
    notifySlotCleared(conversationId, entry.runId);
  }

  // Register a slot-clear listener. Returns an unsubscribe function so
  // tests can unwire without globals.
  function onSlotCleared(cb) {
    if (typeof cb !== 'function') return () => {};
    slotClearedListeners.push(cb);
    return () => {
      const idx = slotClearedListeners.indexOf(cb);
      if (idx !== -1) slotClearedListeners.splice(idx, 1);
    };
  }

  function getActiveRunId(conversationId) {
    const entry = active.get(conversationId);
    return entry ? entry.runId : null;
  }

  function getActiveAdapter(conversationId) {
    const entry = active.get(conversationId);
    return entry ? entry.adapter : null;
  }

  // Liveness probe + cleanup. Returns the active run row or null. Side
  // effects mirror routes/manager.js's pre-1.5 getActiveManager():
  //   * if adapter reports the subprocess dead, update the run row's status
  //     based on the adapter's exit code (0 → completed, else → failed),
  //   * emit a normalized session_ended event if the adapter supports it,
  //   * clear the registry slot.
  function probeActive(conversationId) {
    const entry = active.get(conversationId);
    if (!entry) return null;
    const { runId, adapter } = entry;

    const alive = adapter.isSessionAlive(runId);
    if (!alive) {
      try {
        const exitCode = adapter.detectExitCode
          ? adapter.detectExitCode(runId)
          : null;
        if (exitCode !== null) {
          try {
            const status = exitCode === 0 ? 'completed' : 'failed';
            runService.updateRunStatus(runId, status, { force: true });
          } catch { /* already transitioned */ }
        }
      } catch { /* ignore */ }
      try {
        if (adapter.emitSessionEndedIfNeeded) {
          adapter.emitSessionEndedIfNeeded(runId, 'natural-exit');
        }
      } catch { /* ignore */ }
      // PR2 / NEW-B2: dispose the adapter session even on natural exit.
      // Prior to this, a dead subprocess left its tmp directory behind
      // on disk because nobody called disposeSession — the adapter
      // itself doesn't self-clean. disposeSession is idempotent
      // (adapters wrap streamJsonEngine.kill in try/catch and the
      // session-ended emit has an `endedEmitted` fence) so calling it
      // after we already emitted 'natural-exit' above is safe.
      try {
        if (typeof adapter.disposeSession === 'function') {
          adapter.disposeSession(runId);
        }
      } catch (err) {
        console.warn(`[managerRegistry] disposeSession failed during probeActive dead-session path of ${conversationId}/${runId}:`, err && err.message);
      }
      active.delete(conversationId);
      // Notify listeners so they can scrub per-runId auxiliary state
      // (e.g., pending parent notices keyed by this run id) before the
      // run id drifts out of the registry. Without this, PM rotation or
      // natural exit would strand notices targeting the old run id.
      notifySlotCleared(conversationId, runId);
      return null;
    }

    try {
      return runService.getRun(runId);
    } catch {
      // PR2 / P1-2: the pre-PR2 code silently deleted the slot here
      // without firing notifySlotCleared, so parent-notice queues keyed
      // by the dead run id never got scrubbed. Conversation service
      // already tolerates double-scrubs (map delete is idempotent), so
      // adding the notify is safe and closes the leak.
      active.delete(conversationId);
      notifySlotCleared(conversationId, runId);
      return null;
    }
  }

  // Introspection used by /api/manager/status (layer-aware shape).
  function snapshot() {
    const out = { top: null, pms: [] };
    for (const [key, entry] of active.entries()) {
      if (key === 'top') {
        out.top = { conversationId: 'top', runId: entry.runId };
      } else if (key.startsWith('pm:')) {
        out.pms.push({ conversationId: key, runId: entry.runId });
      }
    }
    return out;
  }

  return {
    setActive,
    clearActive,
    getActiveRunId,
    getActiveAdapter,
    probeActive,
    snapshot,
    onSlotCleared,
  };
}

module.exports = { createManagerRegistry };
