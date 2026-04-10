// hooks/dispatch.js — useDispatchAudit (v3 Phase 7).
//
// Polls /api/dispatch-audit and listens for dispatch_audit:recorded SSE
// events so the Dashboard drift badge + DriftDrawer + per-PM indicator
// all stay in sync without each consumer maintaining its own fetch
// schedule. `dismissed` is a client-only set of audit ids kept in
// localStorage — the server rows remain intact (annotate-only); dismiss
// just hides them from the visible list for this browser profile.

import { apiFetch } from '../api.js';

const { useState, useEffect, useCallback, useRef } = window.preactHooks;

const DRIFT_DISMISS_STORAGE_KEY = 'palantir.drift.dismissed.v1';

function loadDismissedIds() {
  try {
    const raw = localStorage.getItem(DRIFT_DISMISS_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}
function saveDismissedIds(set) {
  try {
    localStorage.setItem(DRIFT_DISMISS_STORAGE_KEY, JSON.stringify(Array.from(set)));
  } catch { /* ignore quota */ }
}

export function useDispatchAudit({ pollMs = 15000, limit = 50 } = {}) {
  const [rows, setRows] = useState([]);
  const [dismissedIds, setDismissedIds] = useState(() => loadDismissedIds());
  const pollRef = useRef(null);
  // v3 Phase 7 R1 fix — stale-response fence. reload() is called from
  // three independent triggers (initial mount, 15s poll, SSE
  // dispatch_audit:recorded). Without a token, a slow poll response
  // that started before the SSE trigger can land after the fast SSE
  // response and revert rows to an older snapshot. Each call captures
  // its own sequence number; the commit is skipped if a newer request
  // has already superseded it.
  const requestSeqRef = useRef(0);
  const latestCommittedSeqRef = useRef(0);

  const reload = useCallback(async () => {
    const mySeq = ++requestSeqRef.current;
    try {
      // Server already caps to 500 max; we fetch the most recent N.
      const data = await apiFetch(`/api/dispatch-audit?incoherent_only=1&limit=${limit}`);
      // Only commit if this response is newer than anything already
      // committed. Out-of-order late responses are dropped.
      if (mySeq < latestCommittedSeqRef.current) return;
      latestCommittedSeqRef.current = mySeq;
      setRows(Array.isArray(data.audit) ? data.audit : []);
    } catch { /* silent — annotate-only feature must not toast on every failure */ }
  }, [limit]);

  const dismiss = useCallback((id) => {
    setDismissedIds(prev => {
      const next = new Set(prev);
      next.add(id);
      saveDismissedIds(next);
      return next;
    });
  }, []);

  const clearDismissed = useCallback(() => {
    setDismissedIds(new Set());
    saveDismissedIds(new Set());
  }, []);

  useEffect(() => {
    reload();
    pollRef.current = setInterval(reload, pollMs);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [reload, pollMs]);

  // Visible rows = server rows minus dismissed.
  const visibleRows = rows.filter(r => !dismissedIds.has(r.id));
  // Per-project count for the ManagerView indicator — operates on the
  // visible set so user dismissals remove the badge too.
  const countByProject = new Map();
  for (const r of visibleRows) {
    const key = r.project_id;
    countByProject.set(key, (countByProject.get(key) || 0) + 1);
  }

  return {
    rows: visibleRows,
    totalCount: visibleRows.length,
    countByProject,
    reload,
    dismiss,
    clearDismissed,
    dismissedCount: dismissedIds.size,
  };
}
