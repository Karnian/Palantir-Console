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

export function useEscape(open, onClose) {
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);
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

  const load = useCallback(async () => {
    try {
      const data = await apiFetch('/api/agents');
      setAgents(data.agents || []);
    } catch (err) { addToast('Failed to load agents: ' + (err.message || 'unknown'), 'error'); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return { agents, loading, reload: load };
}

// ---- Manager session ----

export function useManager() {
  const [status, setStatus] = useState({ active: false, run: null, usage: null });
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const pollRef = useRef(null);

  const checkStatus = useCallback(async () => {
    try {
      const data = await apiFetch('/api/manager/status');
      setStatus(data);
      return data;
    } catch { return { active: false }; }
  }, []);

  const loadEvents = useCallback(async () => {
    try {
      const data = await apiFetch('/api/manager/events');
      setEvents(data.events || []);
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
    loadEvents();
    pollRef.current = setInterval(() => {
      checkStatus();
      loadEvents();
    }, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [status.active, checkStatus, loadEvents]);

  return { status, events, loading, start, sendMessage, stop, checkStatus };
}
