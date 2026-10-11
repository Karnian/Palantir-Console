import { useEffect, useRef, useState } from '../../../vendor/hooks.module.js';
import { apiFetch } from '../api.js';

const BASE = '/api/session-hub/snapshots';

export function useSnapshotRefresh({ enabled = true, onComplete } = {}) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);
  const complete = useRef(onComplete);
  complete.current = onComplete;
  const generation = useRef(0);
  const session = useRef(null);
  useEffect(() => {
    const epoch = ++generation.current;
    setStatus(null); setError(false); setPending(false);
    if (!enabled) { session.current = null; return; }
    const context = { epoch, active: true, sequence: 0, postSequence: 0, previous: null,
      controllers: new Set(), posts: new Set() };
    session.current = context;
    let timer;
    const poll = async () => {
      if (!live(context)) return;
      if (context.posts.has(context.postSequence)) { timer = setTimeout(poll, 1000); return; }
      const request = begin(context);
      try { publish(request, await apiFetch(`${BASE}/status`, { signal: request.controller.signal })); }
      catch { if (current(request)) setError(true); }
      finally {
        context.controllers.delete(request.controller);
        if (live(context)) {
          timer = setTimeout(poll, context.previous?.targets.some(item => item.running) ? 1000 : 10000);
        }
      }
    };
    void poll();
    return () => {
      context.active = false;
      if (session.current === context) session.current = null;
      for (const controller of context.controllers) controller.abort();
      clearTimeout(timer);
    };
  }, [enabled]);
  function live(context) {
    return context.active && session.current === context && generation.current === context.epoch;
  }
  function begin(context) {
    const controller = new AbortController();
    context.controllers.add(controller);
    return { context, controller, sequence: ++context.sequence };
  }
  function current(request) {
    return live(request.context) && request.sequence === request.context.sequence;
  }
  function publish(request, value) {
    if (!current(request)) return;
    if (!value || !Array.isArray(value.targets)) throw new Error('snapshot_status_invalid');
    const previous = request.context.previous;
    const changed = previous && value.targets.some(target => {
      const before = previous.targets.find(item => item.name === target.name);
      return (before?.running && !target.running)
        || (target.last_success_at && before?.last_success_at !== target.last_success_at);
    });
    request.context.previous = value; setStatus(value); setError(false);
    if (changed) complete.current?.();
  }
  const refresh = async targets => {
    const context = session.current;
    if (!context || !live(context)) return;
    const request = begin(context);
    context.postSequence = request.sequence; context.posts.add(request.sequence);
    setPending(true);
    try {
      const value = await apiFetch(`${BASE}/refresh`, { method: 'POST', signal: request.controller.signal,
        body: JSON.stringify(targets ? { targets } : {}), expectedStatus: 202 });
      publish(request, value);
    } catch { if (current(request)) setError(true); }
    finally {
      context.controllers.delete(request.controller); context.posts.delete(request.sequence);
      if (live(context) && context.postSequence === request.sequence) setPending(false);
    }
  };
  return { status, error, refresh, busy: pending || Boolean(status?.targets.some(target => target.running)) };
}
