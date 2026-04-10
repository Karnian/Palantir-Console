// hooks/data.js — Collection data hooks (useTasks, useRuns, useProjects,
// useClaudeSessions, useAgents).
//
// All follow the same shape: load on mount, expose { collection, setX,
// loading, reload }. Errors get surfaced through the toast system; failures
// don't poison the rest of the page.

import { apiFetch } from '../api.js';
import { addToast } from '../toast.js';

const { useState, useEffect, useCallback } = window.preactHooks;

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
