// Application hooks. Lifted out of app.js as part of Phase 4 (B3) so each
// hook has a single owner and component code can stop reaching at them via
// the script-global namespace.
//
// Module-time dependencies (preact hooks) come off `window`, so this file
// MUST be loaded AFTER main.js has bridged the preact globals. main.js
// guarantees that ordering by dynamic-importing this module.
//
// apiFetch and addToast are imported directly from sibling lib modules so
// the import graph is honest and the legacy `window.apiFetch`/`addToast`
// indirection isn't required here.

import { apiFetch } from './api.js';
import { addToast } from './toast.js';

const { useState, useEffect, useCallback, useRef } = window.preactHooks;

// ---- Routing ----

export function useRoute() {
  const getHash = () => location.hash.slice(1) || 'dashboard';
  const [route, setRoute] = useState(getHash);
  useEffect(() => {
    const onHash = () => setRoute(getHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

export function navigate(hash) {
  location.hash = hash;
}

// ---- UI hooks ----

// Module-level stack so nested modals don't all react to the same Escape key.
// When two modals are open (e.g. ProjectDetailModal -> TaskDetailPanel on top),
// pressing Escape should only close the topmost one. We track each active
// useEscape registration in mount order; the handler short-circuits unless its
// own entry is at the top of the stack.
//
// IMPORTANT: the effect dep list intentionally OMITS `onClose`. Call sites
// usually pass a fresh inline arrow on every render, which would otherwise
// tear down and re-push the entry on every parent rerender (SSE reloads,
// minute tickers, etc.) and shuffle the stack — making Escape close the
// wrong modal layer. We read `onClose` through a ref so the registration
// lifetime stays bound to the modal's actual mount lifetime.
const _escapeStack = [];

export function useEscape(open, onClose) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const entry = { fire: () => onCloseRef.current?.() };
    _escapeStack.push(entry);
    const handler = (e) => {
      if (e.key !== 'Escape') return;
      if (_escapeStack[_escapeStack.length - 1] !== entry) return;
      entry.fire();
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
      const idx = _escapeStack.indexOf(entry);
      if (idx >= 0) _escapeStack.splice(idx, 1);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

// ---- SSE ----

export function useSSE(listeners) {
  const listenersRef = useRef(listeners);
  listenersRef.current = listeners;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let source;
    try {
      source = new EventSource('/api/events');
    } catch {
      return;
    }
    source.onopen = () => setConnected(true);
    const channels = [
      'task:created', 'task:updated', 'task:deleted',
      'run:created', 'run:status', 'run:completed', 'run:event',
      'manager:started', 'manager:stopped', 'run:output', 'run:result',
    ];
    channels.forEach((ch) => {
      source.addEventListener(ch, (e) => {
        try {
          const data = JSON.parse(e.data);
          const fn = listenersRef.current[ch];
          if (fn) fn(data);
        } catch { /* ignore parse errors */ }
      });
    });
    source.onerror = () => {
      setConnected(false);
      // EventSource auto-reconnects
    };
    return () => { source.close(); setConnected(false); };
  }, []);

  return { connected };
}

// ---- Data hooks ----
//
// All four follow the same shape: load on mount, expose { collection, setX,
// loading, reload }. Errors get surfaced through the toast system; failures
// don't poison the rest of the page.

export function useTasks() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch('/api/tasks');
      setTasks(data.tasks || []);
    } catch (err) { addToast('Failed to load tasks: ' + (err.message || 'unknown'), 'error'); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return { tasks, setTasks, loading, reload: load };
}

export function useRuns() {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch('/api/runs');
      setRuns(data.runs || []);
    } catch (err) { addToast('Failed to load runs: ' + (err.message || 'unknown'), 'error'); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return { runs, setRuns, loading, reload: load };
}

export function useProjects() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch('/api/projects');
      setProjects(data.projects || []);
    } catch (err) { addToast('Failed to load projects: ' + (err.message || 'unknown'), 'error'); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return { projects, setProjects, loading, reload: load };
}

// Polled list — refreshes every 15s. Failures are silently swallowed
// (this is a sidebar indicator, not core data).
export function useClaudeSessions() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const data = await apiFetch('/api/claude-sessions');
      setSessions(data.sessions || []);
    } catch {
      setSessions([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
    const timer = setInterval(reload, 15000);
    return () => clearInterval(timer);
  }, [reload]);

  return { sessions, loading, reload };
}

export function useAgents() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  // PR5: expose an error flag so consumers (manager picker) can tell a
  // "transient fetch failure" apart from a real "no agents registered"
  // state and avoid locking the user out on a flaky network.
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch('/api/agents');
      setAgents(data.agents || []);
      setError(null);
    } catch (err) {
      setError(err.message || 'unknown');
      addToast('Failed to load agents: ' + (err.message || 'unknown'), 'error');
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return { agents, loading, error, reload: load };
}

// ---- Conversations (v3 Phase 1.5) ----
//
// Conversation identity is the new 1st-class surface. A conversation id
// is one of: 'top' | 'pm:<projectId>' (Phase 3a) | 'worker:<runId>'.
// useConversation() polls /api/conversations/:id/events with an
// incremental cursor (same pattern as useManager), and exposes a
// sendMessage() that hits /api/conversations/:id/message.
//
// useManager() below is PRESERVED unchanged — it still consumes the
// legacy /api/manager/* routes, which now internally go through the
// same conversationService. The intent is that new UI surfaces
// (worker direct chat, future PM panel) use useConversation() while
// the existing ManagerView keeps running on useManager() until a
// later phase needs to dismantle it.

export function useConversation(conversationId, { poll = true, pollMs = 2000 } = {}) {
  const [events, setEvents] = useState([]);
  const [run, setRun] = useState(null);
  const [loading, setLoading] = useState(false);
  const pollRef = useRef(null);
  const lastEventIdRef = useRef(0);
  const activeIdRef = useRef(conversationId);
  activeIdRef.current = conversationId;

  const resolve = useCallback(async () => {
    if (!conversationId) return;
    // v3 Phase 6 R2 fix — fence late responses. Capture the id that
    // this fetch targets BEFORE awaiting, then only commit the state
    // update if `activeIdRef.current` still matches. Without this,
    // a slow response for PM A can land after the user switched to
    // PM B and overwrite B's state (A→B race) — which would briefly
    // flash the Reset PM button and stale Active badge back onto B
    // even though Phase 6's synchronous clear already wiped it.
    const myId = conversationId;
    try {
      const data = await apiFetch(`/api/conversations/${encodeURIComponent(myId)}`);
      if (activeIdRef.current !== myId) return; // user already moved
      setRun(data.conversation?.run || null);
    } catch { /* 4xx — leave run null */ }
  }, [conversationId]);

  const loadEvents = useCallback(async (opts = {}) => {
    if (!conversationId) return;
    const myId = conversationId;
    try {
      if (opts.reset) {
        lastEventIdRef.current = 0;
        setEvents([]);
      }
      const after = lastEventIdRef.current;
      const base = `/api/conversations/${encodeURIComponent(myId)}/events`;
      const url = after > 0 ? `${base}?after=${after}` : base;
      const data = await apiFetch(url);
      // v3 Phase 6 R2 fix — same fence as resolve(). Late events
      // batches from a previous id must not leak into the current
      // conversation's render state.
      if (activeIdRef.current !== myId) return;
      const incoming = Array.isArray(data.events) ? data.events : [];
      if (incoming.length === 0) return;
      let maxId = lastEventIdRef.current;
      for (const ev of incoming) {
        if (typeof ev.id === 'number' && ev.id > maxId) maxId = ev.id;
      }
      lastEventIdRef.current = maxId;
      setEvents(prev => {
        if (prev.length === 0) return incoming;
        const seen = new Set(prev.map(e => e.id));
        const merged = prev.slice();
        for (const ev of incoming) {
          if (!seen.has(ev.id)) merged.push(ev);
        }
        return merged;
      });
    } catch { /* ignore */ }
  }, [conversationId]);

  const sendMessage = useCallback(async (text, images) => {
    if (!conversationId) return;
    // v3 Phase 6 R3 fix — fence loading writes on the conversation id
    // captured at call time so a late resolve/finally from a previous
    // conversation (A.sendMessage in flight, user switched to B) cannot
    // stomp on B's loading state. Same class of race as resolve()/
    // loadEvents() above.
    const myId = conversationId;
    setLoading(true);
    try {
      const body = { text };
      if (images && images.length > 0) body.images = images;
      const data = await apiFetch(`/api/conversations/${encodeURIComponent(myId)}/message`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return data;
    } catch (err) {
      addToast('Failed to send: ' + err.message, 'error');
      throw err;
    } finally {
      if (activeIdRef.current === myId) {
        setLoading(false);
      }
    }
  }, [conversationId]);

  useEffect(() => {
    // v3 Phase 6 R1 fix — clear stale run/events SYNCHRONOUSLY on
    // every id change so consumers that derive UI affordances from
    // `run` (e.g., Phase 6 "Reset PM" button + active badge) never
    // see the previous PM's state while the async resolve() for the
    // new id is in flight. Without this, switching from an active
    // PM A to an idle PM B would briefly render B as active and
    // expose a Reset that then operates on B based on A's stale
    // state. resolve() will repopulate run/events asynchronously.
    //
    // R4 fix — also reset `loading` here. sendMessage() now fences its
    // `finally` by id (R3), which means a mid-flight A send whose
    // finally is skipped would otherwise leave B stuck at loading=true
    // forever. Clearing on id switch is correct because loading is a
    // per-conversation concept tied to "am I waiting for my own
    // response", not a global app state.
    setRun(null);
    setEvents([]);
    setLoading(false);
    lastEventIdRef.current = 0;

    resolve();
    loadEvents({ reset: true });
    if (!poll) return;
    pollRef.current = setInterval(() => {
      if (activeIdRef.current !== conversationId) return;
      resolve();
      loadEvents();
    }, pollMs);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      lastEventIdRef.current = 0;
    };
  }, [conversationId, poll, pollMs, resolve, loadEvents]);

  return { run, events, loading, sendMessage, reload: () => loadEvents({ reset: true }) };
}

// ---- Manager session ----

export function useManager() {
  const [status, setStatus] = useState({ active: false, run: null, usage: null });
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const pollRef = useRef(null);
  const lastEventIdRef = useRef(0); // PR1c: incremental polling cursor

  const checkStatus = useCallback(async () => {
    try {
      const data = await apiFetch('/api/manager/status');
      setStatus(data);
      return data;
    } catch { return { active: false }; }
  }, []);

  // PR1c: incremental polling. Server caps GET /api/manager/events at 1000 rows
  // (the underlying runService.getEvents query). Now that PR1b dual-emits
  // normalized events, the row count effectively doubled — so we MUST stop
  // refetching from row 0 every poll. Pass ?after=<lastSeenId> and append.
  const loadEvents = useCallback(async (opts = {}) => {
    try {
      const reset = !!opts.reset;
      if (reset) {
        lastEventIdRef.current = 0;
        setEvents([]);
      }
      const after = lastEventIdRef.current;
      const url = after > 0
        ? `/api/manager/events?after=${after}`
        : '/api/manager/events';
      const data = await apiFetch(url);
      const incoming = Array.isArray(data.events) ? data.events : [];
      if (incoming.length === 0) return;
      // Track high-water mark for next poll.
      let maxId = lastEventIdRef.current;
      for (const ev of incoming) {
        if (typeof ev.id === 'number' && ev.id > maxId) maxId = ev.id;
      }
      lastEventIdRef.current = maxId;
      // Append (with dedupe by id in case the cap window slid past an event).
      setEvents(prev => {
        if (prev.length === 0) return incoming;
        const seen = new Set(prev.map(e => e.id));
        const merged = prev.slice();
        for (const ev of incoming) {
          if (!seen.has(ev.id)) merged.push(ev);
        }
        return merged;
      });
    } catch { /* ignore */ }
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

  const sendMessage = useCallback(async (text, images) => {
    try {
      const body = { text };
      if (images && images.length > 0) body.images = images;
      await apiFetch('/api/manager/message', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    } catch (err) {
      addToast('Failed to send message: ' + err.message, 'error');
      throw err;
    }
  }, []);

  const stop = useCallback(async () => {
    try {
      await apiFetch('/api/manager/stop', { method: 'POST' });
      setStatus({ active: false, run: null, usage: null });
      setEvents([]);
      lastEventIdRef.current = 0;
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
      // Reset cursor when session goes inactive so a fresh start re-fetches.
      lastEventIdRef.current = 0;
      return;
    }
    // First load on activation: full backlog.
    loadEvents({ reset: true });
    pollRef.current = setInterval(() => {
      checkStatus();
      loadEvents();
    }, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [status.active, checkStatus, loadEvents]);

  return { status, events, loading, start, sendMessage, stop, checkStatus };
}
