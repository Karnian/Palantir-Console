// DashboardView — Attention Dashboard component.
// Extracted from server/public/app.js as part of P5-1 (ESM phase 4a).
//
// Dependencies:
//   - window.timeAgo, window.formatDuration  (from app/lib/format.js)
//   - window.navigate                        (from app/lib/hooks.js)
//   - window.EmptyState                      (from app/components/EmptyState.js)
//
// Due-date helpers (dueState, formatDueDate, useNowTick, dueDateMeta) are
// imported from app/lib/dueDate.js. The window bridge lives in main.js
// (P8-1: "bridge는 main.js에서만" principle).

import { h } from '../../vendor/preact.module.js';
import { useState, useEffect } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { dueState, formatDueDate, useNowTick, dueDateMeta } from '../lib/dueDate.js';

export function DashboardView({ tasks, runs, onOpenRun, onOpenTask, onDeleteRun, claudeSessions, manager, driftAudit, onOpenDrift }) {
  // Resolve window globals at call time (set by main.js before this module runs)
  const timeAgo = window.timeAgo;
  const formatDuration = window.formatDuration;
  const navigate = window.navigate;
  const EmptyState = window.EmptyState;

  // Tick every minute so overdue/due-soon triage rolls over without a reload.
  // The hook itself returns a counter we don't read; calling it is enough to
  // force a re-render at each tick.
  useNowTick(60_000);
  // Manager session is tracked separately via /api/manager/status — exclude from worker dashboard counts
  const workerRuns = (runs || []).filter(r => !r.is_manager);
  const activeRuns = workerRuns.filter(r => r.status === 'running');
  const needsInputRuns = workerRuns.filter(r => r.status === 'needs_input');
  const failedRuns = workerRuns.filter(r => r.status === 'failed');
  const completedToday = workerRuns.filter(r => {
    if (r.status !== 'completed') return false;
    const d = new Date(r.ended_at || r.created_at);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  });
  const reviewTasks = tasks.filter(t => t.status === 'review');

  // Build triage items sorted by urgency.
  // Track task ids that already appear via due-date triage so we don't re-list
  // them as separate "Ready for review" rows — the overdue/due-soon row
  // already surfaces the same task with more actionable context.
  const dueDateTaskIds = new Set();
  const triageItems = [];

  const runTitle = (run, task) => {
    if (run.is_manager) return 'Manager Session';
    return task?.title || `Run ${run.id.slice(0, 8)}`;
  };

  if (manager?.status?.active && manager.status.run) {
    const mrun = manager.status.run;
    triageItems.push({
      type: 'manager',
      priority: -1,
      title: 'Manager Session',
      meta: `Active - ${timeAgo(mrun.started_at || mrun.created_at)}`,
      run: null,
      task: null,
    });
  }

  // Due-date triage: overdue and due-soon (excluding done tasks)
  tasks.forEach(t => {
    if (t.status === 'done') return;
    const due = dueDateMeta(t);
    if (!due) return;
    if (due.state === 'overdue') {
      triageItems.push({
        type: 'overdue',
        priority: 1.5, // between failed (1) and running (2)
        title: t.title,
        meta: `마감일 지남 ${due.formatted} (${due.label})`,
        run: null,
        task: t,
      });
      dueDateTaskIds.add(t.id);
    } else if (due.state === 'due-soon') {
      triageItems.push({
        type: 'due-soon',
        priority: 1.7,
        title: t.title,
        meta: `마감 임박 ${due.formatted} (${due.label})`,
        run: null,
        task: t,
      });
      dueDateTaskIds.add(t.id);
    }
  });

  needsInputRuns.forEach(run => {
    const task = tasks.find(t => t.id === run.task_id);
    triageItems.push({
      type: 'needs-input',
      priority: 0,
      title: runTitle(run, task),
      meta: `Waiting for input - ${timeAgo(run.updated_at || run.created_at)}`,
      run,
      task,
    });
  });

  failedRuns.forEach(run => {
    const task = tasks.find(t => t.id === run.task_id);
    triageItems.push({
      type: 'failed',
      priority: 1,
      title: runTitle(run, task),
      meta: `Failed - ${timeAgo(run.updated_at || run.created_at)}`,
      run,
      task,
    });
  });

  activeRuns.forEach(run => {
    const task = tasks.find(t => t.id === run.task_id);
    triageItems.push({
      type: 'running',
      priority: 2,
      title: runTitle(run, task),
      meta: `Running - ${timeAgo(run.created_at)}`,
      run,
      task,
    });
  });

  reviewTasks.forEach(task => {
    // Suppress review row if this task is already surfaced by a due-date row.
    if (dueDateTaskIds.has(task.id)) return;
    triageItems.push({
      type: 'review',
      priority: 3,
      title: task.title,
      meta: `Ready for review - ${timeAgo(task.updated_at || task.created_at)}`,
      run: null,
      task,
    });
  });

  triageItems.sort((a, b) => a.priority - b.priority);

  const iconMap = {
    'needs-input': '\u270B',
    'failed': '\u2718',
    'running': '\u25B6',
    'review': '\u2714',
    'done': '\u2713',
    'manager': '\u2726',
    'overdue': '\u23F0',
    'due-soon': '\u23F0',
  };

  return html`
    <div class="dashboard-view">
      <div class="dashboard-header">
        <h1 class="dashboard-title">Attention Dashboard</h1>
      </div>
      <div class="stats-bar">
        <div class="stat-chip stat-running">
          <div>
            <div class="stat-value">${activeRuns.length}</div>
            <div class="stat-label">Active</div>
          </div>
        </div>
        <div class="stat-chip stat-queued">
          <div>
            <div class="stat-value">${needsInputRuns.length}</div>
            <div class="stat-label">Needs Input</div>
          </div>
        </div>
        <div class="stat-chip stat-failed">
          <div>
            <div class="stat-value">${failedRuns.length}</div>
            <div class="stat-label">Failed</div>
          </div>
        </div>
        <div class="stat-chip stat-done">
          <div>
            <div class="stat-value">${completedToday.length}</div>
            <div class="stat-label">Done Today</div>
          </div>
        </div>
        ${/* v3 Phase 7: Drift badge. Hidden when zero so the bar stays
             calm. Clickable → opens the DriftDrawer at app level. */ ''}
        ${driftAudit && driftAudit.totalCount > 0 && html`
          <div
            class="stat-chip stat-failed"
            style="cursor:pointer"
            role="button"
            tabIndex=${0}
            title="PM hallucination / staleness incidents. Click to inspect."
            aria-label=${`Drift warnings: ${driftAudit.totalCount}. Activate to open the drift drawer.`}
            onClick=${() => onOpenDrift && onOpenDrift()}
            onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenDrift && onOpenDrift(); } }}
          >
            <div>
              <div class="stat-value">${driftAudit.totalCount}</div>
              <div class="stat-label">Drift \u26A0</div>
            </div>
          </div>
        `}
      </div>
      <div class="triage-feed">
        ${triageItems.length === 0 && html`
          <${EmptyState}
            icon="\u2726"
            text="All clear. No items need attention."
            sub="Tasks and runs will appear here when they need your input."
          />
        `}
        ${triageItems.map((item, i) => html`
          <div
            key=${item.run?.id || item.task?.id || `manager-${i}`}
            class="triage-item"
            onClick=${() => {
              if (item.type === 'manager') { navigate('manager'); return; }
              if (item.type === 'overdue' || item.type === 'due-soon' || item.type === 'review') {
                if (item.task && onOpenTask) onOpenTask(item.task);
                return;
              }
              if (item.run) onOpenRun(item.run);
            }}
          >
            <div class="triage-icon ${item.type}">${iconMap[item.type]}</div>
            <div class="triage-body">
              <div class="triage-title">${item.title}</div>
              <div class="triage-meta">${item.meta}</div>
            </div>
            <div class="triage-actions">
              ${item.type === 'needs-input' && html`
                <button class="ghost" onClick=${(e) => { e.stopPropagation(); item.run && onOpenRun(item.run); }}>
                  Respond
                </button>
              `}
              ${item.type === 'failed' && html`
                <button class="ghost" onClick=${(e) => { e.stopPropagation(); item.run && onDeleteRun(item.run.id); }}>
                  Dismiss
                </button>
              `}
              ${item.type === 'running' && html`
                <button class="ghost" onClick=${(e) => { e.stopPropagation(); item.run && onOpenRun(item.run); }}>
                  Inspect
                </button>
              `}
              ${item.type === 'review' && html`
                <button class="ghost" onClick=${(e) => { e.stopPropagation(); if (item.task && onOpenTask) onOpenTask(item.task); }}>
                  Review
                </button>
              `}
              ${item.type === 'manager' && html`
                <button class="ghost" onClick=${(e) => { e.stopPropagation(); navigate('manager'); }}>
                  Open
                </button>
              `}
              ${(item.type === 'overdue' || item.type === 'due-soon') && html`
                <button class="ghost" onClick=${(e) => { e.stopPropagation(); if (item.task && onOpenTask) onOpenTask(item.task); }}>
                  Open
                </button>
              `}
            </div>
          </div>
        `)}
      </div>
      ${claudeSessions && claudeSessions.length > 0 && html`
        <div style="padding: 0 28px 28px;">
          <div class="task-detail-section-title" style="margin-bottom:8px;">Active Claude Sessions (${claudeSessions.filter(s => s.alive).length})</div>
          <div style="display:flex;flex-direction:column;gap:6px;">
            ${claudeSessions.filter(s => s.alive).map(s => html`
              <div key=${s.pid} class="claude-session-item">
                <span class="run-status-dot running"></span>
                <div style="flex:1;min-width:0;">
                  <div style="font-size:13px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                    ${s.projectName}
                  </div>
                  <div style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title=${s.cwd}>
                    ${s.cwd}
                  </div>
                </div>
                <div style="text-align:right;flex-shrink:0;">
                  <div style="font-size:11px;color:var(--text-muted);">PID ${s.pid}</div>
                  <div style="font-size:11px;color:var(--text-secondary);">${formatDuration(s.runningFor)}</div>
                </div>
              </div>
            `)}
          </div>
        </div>
      `}
    </div>
  `;
}
