import { useEffect, useRef, useState } from '../../../vendor/hooks.module.js';
import { apiFetch } from '../api.js';

const BASE = '/api/session-hub/snapshots';

export function useSnapshotRefresh({ enabled = true, onComplete } = {}) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);
  const complete = useRef(onComplete);
  complete.current = onComplete;
  const accept = useRef(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let timer;
    let previous = null;
    const controller = new AbortController();
    const publish = value => {
      if (!active) return;
      if (!value || !Array.isArray(value.targets)) throw new Error('snapshot_status_invalid');
      const changed = previous && value.targets.some(target => {
        const before = previous.targets.find(item => item.name === target.name);
        return (before?.running && !target.running)
          || (target.last_success_at && before?.last_success_at !== target.last_success_at);
      });
      previous = value; setStatus(value); setError(false);
      if (changed) complete.current?.();
    };
    accept.current = publish;
    const poll = async () => {
      try { publish(await apiFetch(`${BASE}/status`, { signal: controller.signal })); }
      catch { if (active) setError(true); }
      finally { if (active) timer = setTimeout(poll, previous?.targets.some(item => item.running) ? 1000 : 10000); }
    };
    void poll();
    return () => { active = false; accept.current = null; controller.abort(); clearTimeout(timer); };
  }, [enabled]);
  const refresh = async targets => {
    setPending(true);
    try {
      const value = await apiFetch(`${BASE}/refresh`, { method: 'POST',
        body: JSON.stringify(targets ? { targets } : {}), expectedStatus: 202 });
      accept.current?.(value);
    } catch { setError(true); }
    finally { setPending(false); }
  };
  return { status, error, refresh, busy: pending || Boolean(status?.targets.some(target => target.running)) };
}
