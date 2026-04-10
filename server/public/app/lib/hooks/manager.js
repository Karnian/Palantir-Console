// hooks/manager.js — useManagerLifecycle (P8-3).
// Handles start/stop/status only. Conversation (events + sendMessage)
// is now handled by useConversation('top').

import { apiFetch } from '../api.js';
import { addToast } from '../toast.js';

const { useState, useEffect, useCallback, useRef } = window.preactHooks;

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
      addToast('Manager session started', 'success');
      return data;
    } catch (err) {
      addToast('Failed to start manager: ' + err.message, 'error');
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const stop = useCallback(async () => {
    try {
      await apiFetch('/api/manager/stop', { method: 'POST' });
      setStatus({ active: false, run: null, usage: null });
      addToast('Manager session stopped', 'info');
    } catch (err) {
      addToast('Failed to stop manager: ' + err.message, 'error');
    }
  }, []);

  useEffect(() => {
    checkStatus();
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
