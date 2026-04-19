// SessionGrid — Right task sessions grid of the Manager view.
// Extracted from ManagerView.js as part of P8-5.

import { h } from '../../vendor/preact.module.js';
import { useState, useMemo } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { EmptyState } from './EmptyState.js';
import { RunInspector } from './RunInspector.js';
import { clickableProps } from '../lib/a11y.js';
import { TaskDetailPanel } from './TaskModals.js';

const runStatusIcon = (status) => {
  switch (status) {
    case 'running': return '\u25CF'; // ●
    case 'completed': return '\u2713'; // ✓
    case 'failed': return '\u2717'; // ✗
    case 'needs_input': return '\u23F8'; // ⏸
    case 'queued': return '\u25CB'; // ○
    case 'cancelled': return '\u2015'; // ―
    case 'stopped': return '\u23F9'; // ⏹
    default: return '\u25CB';
  }
};

const runStatusColor = (status) => {
  switch (status) {
    case 'running': return '#3b82f6';
    case 'completed': return '#22c55e';
    case 'failed': return '#ef4444';
    case 'needs_input': return '#f59e0b';
    case 'queued': return '#6b7280';
    case 'cancelled': return '#6b7280';
    case 'stopped': return '#6b7280';
    default: return '#6b7280';
  }
};

export function SessionGrid({ tasks, runs, projects, activePms = [], managerStatus, conversationTarget, onSelectConversation }) {
  const onSelectPm = onSelectConversation;
  const [inspectRun, setInspectRun] = useState(null);
  const [selectedTask, setSelectedTask] = useState(null);
  const [collapsedProjects, setCollapsedProjects] = useState({});
  const toggleProject = (key) => setCollapsedProjects(prev => ({ ...prev, [key]: !prev[key] }));
  const [collapsedSections, setCollapsedSections] = useState({});
  const toggleSection = (key) => setCollapsedSections(prev => ({ ...prev, [key]: !prev[key] }));

  const workerRuns = useMemo(() => (runs || []).filter(r => !r.is_manager), [runs]);

  // Group: Project → Task → Runs
  const projectGroups = useMemo(() => {
    // Build runs map by task
    const runsMap = new Map();
    for (const r of workerRuns) {
      const tid = r.task_id || '_orphan';
      if (!runsMap.has(tid)) runsMap.set(tid, []);
      runsMap.get(tid).push(r);
    }

    // Build project groups with tasks
    const projMap = new Map();
    for (const t of (tasks || [])) {
      const pid = t.project_id || '_none';
      const pname = (projects || []).find(p => p.id === t.project_id)?.name || 'No Project';
      if (!projMap.has(pid)) projMap.set(pid, { key: pid, name: pname, tasks: [] });
      const taskRuns = runsMap.get(t.id) || [];
      runsMap.delete(t.id);
      projMap.get(pid).tasks.push({ task: t, runs: taskRuns });
    }

    // Orphan runs (no task)
    const orphanRuns = runsMap.get('_orphan') || [];
    runsMap.delete('_orphan');

    // Group tasks by status within each project
    const STATUS_SECTIONS = [
      { key: 'backlog', label: 'Backlog', statuses: ['backlog'] },
      { key: 'todo', label: 'Todo', statuses: ['todo'] },
      { key: 'in_progress', label: 'In Progress', statuses: ['in_progress'] },
      { key: 'failed', label: 'Failed', statuses: ['failed'] },
      { key: 'review', label: 'Review', statuses: ['review'] },
      { key: 'done', label: 'Done', statuses: ['done'] },
    ];
    const STATUS_COLORS = { in_progress: '#3b82f6', todo: '#6b7280', review: '#f59e0b', failed: '#ef4444', backlog: '#6b7280', done: '#22c55e' };

    for (const group of projMap.values()) {
      group.sections = STATUS_SECTIONS
        .map(sec => ({
          ...sec,
          color: STATUS_COLORS[sec.key],
          tasks: group.tasks.filter(t => t.task && sec.statuses.includes(t.task.status)),
        }))
        .filter(sec => sec.tasks.length > 0);
      // Keep orphan tasks (no status match)
      const orphanTasks = group.tasks.filter(t => !t.task);
      if (orphanTasks.length > 0) {
        group.sections.push({ key: '_orphan', label: 'Unassigned', color: '#6b7280', tasks: orphanTasks });
      }
    }

    const result = Array.from(projMap.values());

    // Add orphan runs as a virtual group if any
    if (orphanRuns.length > 0) {
      const noneGroup = result.find(g => g.key === '_none') || { key: '_none', name: 'No Project', tasks: [] };
      if (!result.includes(noneGroup)) result.push(noneGroup);
      noneGroup.tasks.push({ task: null, runs: orphanRuns });
    }

    return result;
  }, [tasks, workerRuns, projects]);

  return html`
    <div class="manager-grid-side">
      <div class="manager-grid-header">
        <h3>Task Sessions</h3>
        <div class="manager-grid-stats">
          <span class="mgr-stat" style="color: #3b82f6">\u25CF ${workerRuns.filter(r => r.status === 'running').length} running</span>
          <span class="mgr-stat" style="color: #f59e0b">\u23F8 ${workerRuns.filter(r => r.status === 'needs_input').length} waiting</span>
          <span class="mgr-stat" style="color: #ef4444">\u2717 ${workerRuns.filter(r => r.status === 'failed').length} failed</span>
        </div>
      </div>

      <div class="manager-grid-body">
        ${managerStatus?.active && (() => {
          const isSelected = conversationTarget === 'top';
          return html`
            <div class="manager-session-row ${isSelected ? 'selected' : ''}" ...${clickableProps(() => onSelectConversation && onSelectConversation('top'))}>
              <span class="manager-session-icon">\u2726</span>
              <span class="manager-session-label">Manager Session</span>
              <span class="manager-session-badge running">Active</span>
            </div>
          `;
        })()}
        ${projectGroups.length === 0 && !managerStatus?.active && html`
          <${EmptyState} icon="\u2699" text="No tasks yet" sub="Start a manager and assign tasks" />
        `}
        ${projectGroups.map(group => {
          const projCollapsed = collapsedProjects[group.key];
          const activeCount = group.tasks.reduce((n, t) => n + t.runs.filter(r => ['running', 'needs_input'].includes(r.status)).length, 0);
          return html`
          <div class="worker-project-group">
            <div class="worker-project-label" onClick=${() => toggleProject(group.key)} style="cursor:pointer">
              <span class="worker-project-chevron">${projCollapsed ? '\u25B6' : '\u25BC'}</span>
              <span>${group.name}</span>
              <span class="worker-project-count">${group.tasks.length} task${group.tasks.length !== 1 ? 's' : ''}${activeCount > 0 ? ` \u00B7 ${activeCount} active` : ''}</span>
            </div>
            ${!projCollapsed && (() => {
              const pm = activePms.find(p => p.conversationId === `pm:${group.key}`);
              const pmStatus = pm?.run?.status;
              const pmLabel = pmStatus === 'running' ? 'Running'
                : pmStatus === 'needs_input' ? 'Waiting'
                : pmStatus === 'queued' ? 'Starting...'
                : pmStatus === 'completed' ? 'Done'
                : pmStatus === 'stopped' ? 'Stopped'
                : pmStatus === 'failed' ? 'Failed'
                : 'Idle';
              const pmColor = pmStatus === 'running' ? '#3b82f6'
                : pmStatus === 'needs_input' ? '#f59e0b'
                : pmStatus === 'completed' ? '#22c55e'
                : pmStatus === 'failed' ? '#ef4444'
                : '#6b7280';
              const pmSelected = conversationTarget === `pm:${group.key}`;
              return pm ? html`
                <div class="pm-session-row ${pmSelected ? 'selected' : ''}" ...${clickableProps(() => onSelectPm && onSelectPm(`pm:${group.key}`))}>
                  <span class="pm-session-dot" style="background:${pmColor}"></span>
                  <span class="pm-session-label">PM Session</span>
                  <span class="pm-session-status" style="color:${pmColor}">${pmLabel}${pmStatus === 'running' ? html` <span class="pm-spinner"></span>` : ''}</span>
                </div>
              ` : null;
            })()}
            ${!projCollapsed && group.sections.map(sec => {
              const secKey = `${group.key}::${sec.key}`;
              const secCollapsed = secKey in collapsedSections ? collapsedSections[secKey] : sec.key === 'done';
              return html`
              <div class="task-status-section">
                <div class="task-status-divider" onClick=${() => toggleSection(secKey)} style="cursor:pointer">
                  <span class="task-status-divider-chevron">${secCollapsed ? '\u25B6' : '\u25BC'}</span>
                  <span class="task-status-divider-dot" style="background:${sec.color}"></span>
                  <span class="task-status-divider-label">${sec.label}</span>
                  <span class="task-status-divider-count">${sec.tasks.length}</span>
                  <span class="task-status-divider-line"></span>
                </div>
                ${!secCollapsed && sec.tasks.map(({ task, runs: taskRuns }) => {
                  const running = taskRuns.filter(r => r.status === 'running').length;
                  const waiting = taskRuns.filter(r => r.status === 'needs_input').length;
                  const done = taskRuns.filter(r => r.status === 'completed').length;
                  const failed = taskRuns.filter(r => r.status === 'failed').length;
                  const parts = [];
                  if (running) parts.push(html`<span style="color:#3b82f6">${running} running</span>`);
                  if (waiting) parts.push(html`<span style="color:#f59e0b">${waiting} waiting</span>`);
                  if (failed) parts.push(html`<span style="color:#ef4444">${failed} failed</span>`);
                  if (done) parts.push(html`<span style="color:#22c55e">${done} done</span>`);
                  return html`
                    <div class="task-session-group">
                      <div class="task-session-header">
                        <span class="task-session-title">${task?.title || 'Unassigned Runs'}</span>
                        <span class="task-session-meta">
                          ${parts.length > 0 ? parts.reduce((acc, el, i) => i === 0 ? [el] : [...acc, ', ', el], []) : (taskRuns.length > 0 ? `${taskRuns.length} run${taskRuns.length > 1 ? 's' : ''}` : '')}
                        </span>
                        ${task && html`<button class="task-session-detail-btn" onClick=${(e) => { e.stopPropagation(); setSelectedTask(task); }}>Detail</button>`}
                      </div>
                    </div>
                  `;
                })}
              </div>
            `; })}
          </div>
        `;})}
      </div>

      ${inspectRun && html`
        <${RunInspector} run=${inspectRun} onClose=${() => setInspectRun(null)} />
      `}
      ${selectedTask && html`
        <${TaskDetailPanel}
          task=${selectedTask}
          onClose=${() => setSelectedTask(null)}
          projects=${projects}
          agents=${[]}
          runs=${workerRuns}
          onOpenRun=${(run) => { setSelectedTask(null); setInspectRun(run); }}
          onExecute=${() => {}}
          reloadTasks=${() => {}}
        />
      `}
    </div>
  `;
}
