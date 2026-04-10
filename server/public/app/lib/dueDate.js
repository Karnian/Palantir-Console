// Due-date helpers — shared between DashboardView and BoardView.
// Extracted as a standalone ES module so both components can import
// without duplicating logic.

import { useState, useEffect } from '../../vendor/hooks.module.js';

// Returns: 'overdue' | 'due-soon' | 'on-track' | null.
// `dueSoonDays` defaults to 2 (today + tomorrow).
// Tasks already in 'done' status are treated as on-track.
export function dueState(task, dueSoonDays = 2) {
  if (!task || !task.due_date) return null;
  if (task.status === 'done') return 'on-track';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(task.due_date);
  if (!m) return null;
  const due = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((due - today) / 86400000);
  if (diffDays < 0) return 'overdue';
  if (diffDays <= dueSoonDays - 1) return 'due-soon';
  return 'on-track';
}

export function formatDueDate(d) {
  if (!d) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return d;
  return `${m[1]}.${m[2]}.${m[3]}`;
}

// Re-render every `intervalMs` to reflect time-based state (overdue rolls over
// at midnight, "N일 남음" decrements daily). Pauses while tab is hidden and
// fires immediately on visibility return so coming back from sleep is fresh.
export function useNowTick(intervalMs = 60_000) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let id = null;
    const start = () => {
      if (id != null) return;
      id = setInterval(() => setTick(t => t + 1), intervalMs);
    };
    const stop = () => { if (id != null) { clearInterval(id); id = null; } };
    const onVis = () => {
      if (document.hidden) { stop(); }
      else { setTick(t => t + 1); start(); }
    };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVis);
    return () => { stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [intervalMs]);
  return tick;
}

export function dueDateMeta(task) {
  const state = dueState(task);
  if (!state) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(task.due_date);
  if (!m) return null;
  const due = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((due - today) / 86400000);
  let label;
  if (state === 'overdue') label = `${Math.abs(diffDays)}일 지남`;
  else if (diffDays === 0) label = '오늘';
  else if (diffDays === 1) label = '내일';
  else label = `${diffDays}일 남음`;
  return { state, label, formatted: formatDueDate(task.due_date), diffDays };
}
