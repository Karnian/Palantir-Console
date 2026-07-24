// hooks/manager.js — useManagerLifecycle (P8-3).
// Handles start/stop/status only. Conversation (events + sendMessage)
// is now handled by useConversation('top').

import { apiFetch } from '../api.js';
import { addToast } from '../toast.js';
import { sseBroker } from './sse.js';

import { useState, useEffect, useCallback, useRef } from '../../../vendor/hooks.module.js';

import { TOAST_LABELS } from '../copy.js';
export function useManagerLifecycle() {
  const [status, setStatus] = useState({ active: false, run: null, usage: null });
  const [loading, setLoading] = useState(false);
  const pollRef = useRef(null);

  const checkStatus = useCallback(async () => {
    try {
      const data = await apiFetch('/api/manager/status');
      setStatus(data);
      return data;
    } catch { return { active: false }; }
  }, []);

  const start = useCallback(async (opts = {}) => {
    setLoading(true);
    try {
      const data = await apiFetch('/api/manager/start', {
        method: 'POST',
        body: JSON.stringify(opts),
      });
      setStatus({ active: true, run: data.run, usage: null });
      addToast(TOAST_LABELS.managerStarted, 'success');
      return data;
    } catch (err) {
      addToast(`${TOAST_LABELS.managerStartFailed}: ${err.message}`, 'error');
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const stop = useCallback(async () => {
    try {
      await apiFetch('/api/manager/stop', { method: 'POST' });
      setStatus({ active: false, run: null, usage: null });
      addToast(TOAST_LABELS.managerStopped, 'info');
    } catch (err) {
      addToast(`${TOAST_LABELS.managerStopFailed}: ${err.message}`, 'error');
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  // The global SSE owner stays connected even while Top is inactive. Listen
  // for lifecycle edges here so a Top/Operator appearing in another tab or
  // process revives the status snapshot instead of waiting for a manual page
  // refresh. Polling below remains the steady-state fallback while active.
  useEffect(() => {
    const refresh = () => { checkStatus(); };
    const refreshManagerRun = (data) => {
      const run = data?.run || data;
      if (run?.is_manager) checkStatus();
    };
    const unsubscribeStarted = sseBroker.subscribe('manager:started', refresh);
    const unsubscribeStopped = sseBroker.subscribe('manager:stopped', refresh);
    const unsubscribeRunStatus = sseBroker.subscribe('run:status', refreshManagerRun);
    const unsubscribeRunCompleted = sseBroker.subscribe('run:completed', refreshManagerRun);
    return () => {
      unsubscribeStarted();
      unsubscribeStopped();
      unsubscribeRunStatus();
      unsubscribeRunCompleted();
    };
  }, [checkStatus]);

  useEffect(() => {
    if (!status.active) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    pollRef.current = setInterval(() => {
      checkStatus();
    }, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [status.active, checkStatus]);

  return { status, loading, start, stop, checkStatus };
}
