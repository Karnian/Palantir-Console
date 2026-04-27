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
import { AttentionStrip } from './AttentionStrip.js';
import { TASK_STATUS_LABELS, RUN_STATUS_LABELS, MANAGER_LABELS, COMMON_ACTIONS, statusLabel } from '../lib/copy.js';

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

// Use CSS var() strings so these values stay in sync with the tokens in
// styles/tokens.css and follow theme changes (dark/light, status recoloring)
// without touching this file. Prior hardcoded hex values drifted from tokens
// (e.g. `#22c55e` vs `--status-done: #10b981`, `#8b5cf6` review vs #f59e0b)
// and were flagged in the 2026-04-24 a11y review (P1-3).
const runStatusColor = (status) => {
  switch (status) {
    case 'running': return 'var(--status-running)';
    case 'completed': return 'var(--status-done)';
    case 'failed': return 'var(--status-failed)';
    case 'needs_input': return 'var(--status-needs-input)';
    case 'queued':
    case 'cancelled':
    case 'stopped':
    default: return 'var(--status-queued)';
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
      const pname = (projects || []).find(p => p.id === t.project_id)?.name || '프로젝트 없음';
      if (!projMap.has(pid)) projMap.set(pid, { key: pid, name: pname, tasks: [] });
      const taskRuns = runsMap.get(t.id) || [];
      runsMap.delete(t.id);
      projMap.get(pid).tasks.push({ task: t, runs: taskRuns });
    }

    // Orphan runs (no task)
    const orphanRuns = runsMap.get('_orphan') || [];
    runsMap.delete('_orphan');

    // Group tasks by status within each project. Phase K-1a: section
    // labels resolved from `TASK_STATUS_LABELS` so they match the
    // Board column headers exactly.
    const STATUS_SECTIONS = [
      { key: 'backlog', label: TASK_STATUS_LABELS.backlog, statuses: ['backlog'] },
      { key: 'todo', label: TASK_STATUS_LABELS.todo, statuses: ['todo'] },
      { key: 'in_progress', label: TASK_STATUS_LABELS.in_progress, statuses: ['in_progress'] },
      { key: 'failed', label: TASK_STATUS_LABELS.failed, statuses: ['failed'] },
      { key: 'review', label: TASK_STATUS_LABELS.review, statuses: ['review'] },
      { key: 'done', label: TASK_STATUS_LABELS.done, statuses: ['done'] },
    ];
    const STATUS_COLORS = {
      in_progress: 'var(--status-running)',
      todo: 'var(--status-queued)',
      review: 'var(--status-review)',
      failed: 'var(--status-failed)',
      backlog: 'var(--status-queued)',
      done: 'var(--status-done)',
    };

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
        group.sections.push({ key: '_orphan', label: '미할당', color: 'var(--status-queued)', tasks: orphanTasks });
      }
    }

    const result = Array.from(projMap.values());

    // Add orphan runs as a virtual group if any
    if (orphanRuns.length > 0) {
      const noneGroup = result.find(g => g.key === '_none') || { key: '_none', name: '프로젝트 없음', tasks: [], sections: [] };
      if (!result.includes(noneGroup)) result.push(noneGroup);
      noneGroup.tasks.push({ task: null, runs: orphanRuns });
      // R2-C incidental fix: ensure the orphan-runs group gets a sections
      // array too. A newly-created noneGroup (no _none in the task projMap)
      // would otherwise hit line ~181 (`group.sections.map`) as undefined.
      // We push a single 'Unassigned' section containing the task-less
      // orphan runs so the render loop stays uniform.
      if (!noneGroup.sections) noneGroup.sections = [];
      if (!noneGroup.sections.some(s => s.key === '_orphan')) {
        noneGroup.sections.push({
          key: '_orphan',
          label: '미할당',
          color: 'var(--status-queued)',
          tasks: [{ task: null, runs: orphanRuns }],
        });
      }
    }

    return result;
  }, [tasks, workerRuns, projects]);

  return html`
    <div class="manager-grid-side">
      <div class="manager-grid-header">
        <h3>${MANAGER_LABELS.taskSessions}</h3>
        <div class="manager-grid-stats">
          <span class="mgr-stat" style="color: var(--status-running)">\u25CF ${workerRuns.filter(r => r.status === 'running').length} 실행 중</span>
          <span class="mgr-stat" style="color: var(--status-needs-input)">\u23F8 ${workerRuns.filter(r => r.status === 'needs_input').length} 대기</span>
          <span class="mgr-stat" style="color: var(--status-failed)">\u2717 ${workerRuns.filter(r => r.status === 'failed').length} 실패</span>
        </div>
      </div>

      <div class="manager-grid-body">
        ${/* R2-A.3: AttentionStrip surfaces needs_input + failed worker runs
             above the task sessions list. Self-hiding when empty (spec §12.1). */ ''}
        <${AttentionStrip}
          runs=${runs}
          tasks=${tasks}
          onOpenRun=${(run) => setInspectRun(run)}
        />
        ${managerStatus?.active && (() => {
          const isSelected = conversationTarget === 'top';
          return html`
            <div class="manager-session-row ${isSelected ? 'selected' : ''}" ...${clickableProps(() => onSelectConversation && onSelectConversation('top'))}>
              <span class="manager-session-icon">\u2726</span>
              <span class="manager-session-label">${MANAGER_LABELS.managerSession}</span>
              <span class="manager-session-badge running">${MANAGER_LABELS.active}</span>
            </div>
          `;
        })()}
        ${projectGroups.length === 0 && !managerStatus?.active && html`
          <${EmptyState} icon="\u2699" text="아직 작업이 없습니다" sub="매니저를 시작하고 작업을 할당하세요" />
        `}
        ${projectGroups.map(group => {
          const projCollapsed = collapsedProjects[group.key];
          const activeCount = group.tasks.reduce((n, t) => n + t.runs.filter(r => ['running', 'needs_input'].includes(r.status)).length, 0);
          return html`
          <div class="worker-project-group">
            <div class="worker-project-label" onClick=${() => toggleProject(group.key)} style="cursor:pointer">
              <span class="worker-project-chevron">${projCollapsed ? '\u25B6' : '\u25BC'}</span>
              <span>${group.name}</span>
              <span class="worker-project-count">작업 ${group.tasks.length}개${activeCount > 0 ? `\u00B7 ${activeCount}개 활성` : ''}</span>
            </div>
            ${!projCollapsed && (() => {
              const pm = activePms.find(p => p.conversationId === `pm:${group.key}`);
              const pmStatus = pm?.run?.status;
              // Phase K-1a (rev3): PM row label and ManagerChat header
              // share a single source via `statusLabel(RUN_STATUS_LABELS, ...)`.
              // The earlier hand-mapped chain diverged from ManagerChat
              // for `queued` / `cancelled` / unknown enums; using the
              // helper keeps both surfaces consistent and folds new
              // states into the same map automatically.
              const pmLabel = pmStatus
                ? statusLabel(RUN_STATUS_LABELS, pmStatus)
                : MANAGER_LABELS.idle;
              const pmColor = pmStatus === 'running' ? 'var(--status-running)'
                : pmStatus === 'needs_input' ? 'var(--status-needs-input)'
                : pmStatus === 'completed' ? 'var(--status-done)'
                : pmStatus === 'failed' ? 'var(--status-failed)'
                : 'var(--status-queued)';
              const pmSelected = conversationTarget === `pm:${group.key}`;
              return pm ? html`
                <div class="pm-session-row ${pmSelected ? 'selected' : ''}" ...${clickableProps(() => onSelectPm && onSelectPm(`pm:${group.key}`))}>
                  <span class="pm-session-dot" style="background:${pmColor}"></span>
                  <span class="pm-session-label">PM 세션</span>
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
                  if (running) parts.push(html`<span style="color:var(--status-running)">${running} 실행 중</span>`);
                  if (waiting) parts.push(html`<span style="color:var(--status-needs-input)">${waiting} 대기</span>`);
                  if (failed) parts.push(html`<span style="color:var(--status-failed)">${failed} 실패</span>`);
                  if (done) parts.push(html`<span style="color:var(--status-done)">${done} 완료</span>`);
                  return html`
                    <div class="task-session-group">
                      <div class="task-session-header">
                        <span class="task-session-title">${task?.title || '미할당 런'}</span>
                        <span class="task-session-meta">
                          ${parts.length > 0 ? parts.reduce((acc, el, i) => i === 0 ? [el] : [...acc, ', ', el], []) : (taskRuns.length > 0 ? `런 ${taskRuns.length}개` : '')}
                        </span>
                        ${task && html`<button class="task-session-detail-btn" onClick=${(e) => { e.stopPropagation(); setSelectedTask(task); }}>상세</button>`}
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
