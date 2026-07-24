// BoardView + CalendarView + DirectoryPicker — Task Board components.
// Extracted from server/public/app.js as part of P5-2 (ESM phase 4a).

import { h } from '../../vendor/preact.module.js';
import { useState, useEffect, useMemo } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { timeAgo } from '../lib/format.js';
import { navigate } from '../lib/hooks.js';
import { apiFetch } from '../lib/api.js';
import { addToast } from '../lib/toast.js';
import { dueDateMeta, useNowTick } from '../lib/dueDate.js';
import { NewTaskModal, ExecuteModal, TaskDetailPanel } from './TaskModals.js';
import { Dropdown } from './Dropdown.js';
import { Modal } from './Modal.js';
import { clickableProps } from '../lib/a11y.js';
import { latestRunForTask, nodeDetailHref, shouldRenderNodeBadge } from '../lib/nodeUi.js';
import {
  TASK_STATUS_LABELS,
  FILTER_LABELS,
  COMMON_ACTIONS,
  MANAGER_LABELS,
  DIRECTORY_PICKER_LABELS,
  statusLabel,
} from '../lib/copy.js';

// ─────────────────────────────────────────────────────────────────────────────
// Kanban Board View — internal constants
// ─────────────────────────────────────────────────────────────────────────────

// Phase K-1a: column labels resolved from `TASK_STATUS_LABELS` so the
// inline status Dropdown in TaskCard, the SessionGrid status pills, and the
// board column headers all show the same Korean phrase. Adding a new
// status only needs a single edit in `app/lib/copy.js`.
//
// K-low-1 (Codex NIT): switched the lookup to `statusLabel(map, id)`
// so a transient status not yet present in the map (server-side state
// machine drift) falls back to the raw key instead of `undefined`,
// matching ProjectsView / SessionGrid call sites.
const BOARD_COLUMNS = [
  { id: 'backlog', label: statusLabel(TASK_STATUS_LABELS, 'backlog') },
  { id: 'todo', label: statusLabel(TASK_STATUS_LABELS, 'todo') },
  { id: 'in_progress', label: statusLabel(TASK_STATUS_LABELS, 'in_progress') },
  { id: 'failed', label: statusLabel(TASK_STATUS_LABELS, 'failed') },
  { id: 'review', label: statusLabel(TASK_STATUS_LABELS, 'review') },
  { id: 'done', label: statusLabel(TASK_STATUS_LABELS, 'done') },
];

const LOCAL_PLACEMENT_NODE_ID = 'local';

function normalizePlacementNodeId(nodeId) {
  const value = String(nodeId ?? '').trim();
  return value || LOCAL_PLACEMENT_NODE_ID;
}

function placementNodeOptionLabel(nodeId) {
  if (nodeId === LOCAL_PLACEMENT_NODE_ID) return FILTER_LABELS.localPlacementNode;
  return `${FILTER_LABELS.placementNodePrefix} ${nodeId}`;
}

function NodeBadge({ run }) {
  if (!shouldRenderNodeBadge(run)) return null;
  const nodeId = run.node_id;
  return html`
    <a
      class="task-badge node"
      data-role="node-badge"
      href=${nodeDetailHref(nodeId)}
      title=${`노드 ${nodeId}`}
      onClick=${(e) => e.stopPropagation()}
    >노드 ${nodeId}</a>
  `;
}

function TaskCard({ task, projects, runs, onDragStart, onClick, onMoveStatus }) {
  const project = projects.find(p => p.id === task.project_id);
  const due = dueDateMeta(task);
  const latestRun = latestRunForTask(runs, task.id);
  // Phase G — drag-and-drop needs a keyboard equivalent (WCAG 2.1.1).
  // Earlier draft put `role="button"` on the card itself, but that
  // nests an interactive control inside a button (ARIA anti-pattern).
  // Instead the card stays a generic container and surfaces TWO actual
  // interactive children in the natural Tab order: an `Open` button
  // and a status Dropdown. They are always visible (the original
  // hover-reveal opacity trick was rejected in review — invisible
  // controls still consume hit-area/layout and broke on coarse-pointer
  // / no-hover environments). Mouse users still click anywhere on the
  // card to open the detail panel — the card-level `onClick` is
  // preserved for that path.

  return html`
    <div
      class="task-card ${due ? `due-${due.state}` : ''}"
      draggable="true"
      onDragStart=${(e) => {
        e.dataTransfer.setData('text/plain', task.id);
        e.dataTransfer.effectAllowed = 'move';
        e.currentTarget.classList.add('dragging');
        onDragStart(task);
      }}
      onDragEnd=${(e) => e.currentTarget.classList.remove('dragging')}
      onClick=${(e) => {
        // Don't open the detail panel when the click originated inside
        // an inline action — those handle their own behaviour.
        if (e.target.closest('.task-card-status-select')) return;
        if (e.target.closest('.task-card-open')) return;
        onClick(task);
      }}
    >
      <div class="task-card-title">${task.title}</div>
      <div class="task-card-badges">
        ${project && html`<span class="task-badge project">${project.name}</span>`}
        ${task.priority && task.priority !== 'medium' && html`
          <span class="task-badge priority-${task.priority}">${task.priority}</span>
        `}
        ${due && html`
          <span class="task-badge due-badge due-${due.state}" title=${`마감일 ${due.formatted}`}>
            \u23F0 ${due.label}
          </span>
        `}
        ${task.recurrence && html`
          <span class="task-badge recurrence" title=${`반복: ${task.recurrence}`}>\u21BB ${task.recurrence}</span>
        `}
        <${NodeBadge} run=${latestRun} />
      </div>
      ${task.updated_at && html`
        <div class="task-card-meta">${timeAgo(task.updated_at || task.created_at)}</div>
      `}
      <div class="task-card-actions">
        <button
          type="button"
          class="task-card-open"
          aria-label=${`작업 "${task.title}" 상세 열기`}
          onClick=${(e) => { e.stopPropagation(); onClick(task); }}>
          ${COMMON_ACTIONS.open}
        </button>
        ${onMoveStatus && html`
          <div class="task-card-status-select" onClick=${(e) => e.stopPropagation()} onKeyDown=${(e) => e.stopPropagation()}>
            <${Dropdown}
              className="dropdown-compact"
              ariaLabel=${`작업 "${task.title}" 상태 변경`}
              value=${task.status || 'backlog'}
              onChange=${(next) => { if (next && next !== task.status) onMoveStatus(task, next); }}
              options=${BOARD_COLUMNS.map(col => ({ value: col.id, label: col.label }))}
            />
          </div>
        `}
      </div>
    </div>
  `;
}

// Tab toggle shown in both Board and Calendar toolbars so the user can flip
// between the two views without leaving the task workflow.
function BoardModeTabs({ active }) {
  // Phase G: this control switches between two ROUTES (`#board` ↔
  // `#calendar`), not panels under one page. The earlier `role="tab"`
  // tablist pattern is wrong for that — a real tablist requires Arrow-key
  // roving across simultaneously-mounted panels, which we don't have.
  // We therefore use plain navigation buttons with `aria-current="page"`
  // marking the active route, which is the WAI-ARIA pattern for in-app
  // navigation. Both buttons stay in the natural Tab order so keyboard
  // users can hit either with Tab alone.
  return html`
    <div class="board-mode-tabs" role="group" aria-label="작업 뷰">
      <button
        class="board-mode-tab ${active === 'board' ? 'active' : ''}"
        aria-current=${active === 'board' ? 'page' : undefined}
        onClick=${() => navigate('board')}>
        \u2592 보드
      </button>
      <button
        class="board-mode-tab ${active === 'calendar' ? 'active' : ''}"
        aria-current=${active === 'calendar' ? 'page' : undefined}
        onClick=${() => navigate('calendar')}>
        \u2637 캘린더
      </button>
    </div>
  `;
}

export function BoardView({ tasks, setTasks, projects, agents, runs, onOpenRun, reloadTasks }) {
  const [showNewTask, setShowNewTask] = useState(false);
  const [executeTask, setExecuteTask] = useState(null);
  const [detailTask, setDetailTask] = useState(null);
  const [filterProject, setFilterProject] = useState('');
  const [filterPlacementNode, setFilterPlacementNode] = useState('');
  const [filterPriority, setFilterPriority] = useState('');
  const [filterDue, setFilterDue] = useState('');
  const [sortMode, setSortMode] = useState('manual'); // 'manual' | 'due-asc' | 'due-desc' | 'priority'
  const [dragTarget, setDragTarget] = useState(null);
  const nowTick = useNowTick(60_000);

  // Listen for 'N' key shortcut to open new task modal
  useEffect(() => {
    const handler = () => setShowNewTask(true);
    window.addEventListener('palantir:new-task', handler);
    return () => window.removeEventListener('palantir:new-task', handler);
  }, []);

  // Helper: days from today to a YYYY-MM-DD string (local time, midnight-aligned)
  const daysUntilDue = (due) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due || '');
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((d - today) / 86400000);
  };

  const projectById = useMemo(() => {
    return new Map(projects.map(project => [project.id, project]));
  }, [projects]);

  const placementNodeOptions = useMemo(() => {
    const nodes = new Set([LOCAL_PLACEMENT_NODE_ID]);
    projects.forEach(project => {
      nodes.add(normalizePlacementNodeId(project.node_id));
    });
    // Stable order (local first, then remote ids sorted) so the filter option
    // list doesn't reshuffle as project order changes (Codex N2 review NIT).
    const sorted = Array.from(nodes).sort((a, b) => {
      if (a === LOCAL_PLACEMENT_NODE_ID) return -1;
      if (b === LOCAL_PLACEMENT_NODE_ID) return 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return [
      { value: '', label: FILTER_LABELS.allPlacementNodes },
      ...sorted.map(nodeId => ({
        value: nodeId,
        label: placementNodeOptionLabel(nodeId),
      })),
    ];
  }, [projects]);

  const filtered = useMemo(() => {
    return tasks.filter(t => {
      if (filterProject && t.project_id !== filterProject) return false;
      if (filterPlacementNode) {
        const project = t.project_id ? projectById.get(t.project_id) : null;
        const taskPlacementNode = normalizePlacementNodeId(project?.node_id);
        if (taskPlacementNode !== filterPlacementNode) return false;
      }
      if (filterPriority && t.priority !== filterPriority) return false;
      if (filterDue) {
        if (filterDue === 'no-due') {
          if (t.due_date) return false;
        } else {
          const days = daysUntilDue(t.due_date);
          if (days === null) return false;
          // 'done' tasks are excluded from due-state filters (no longer actionable)
          if (t.status === 'done') return false;
          if (filterDue === 'overdue' && days >= 0) return false;
          if (filterDue === 'today' && days !== 0) return false;
          if (filterDue === 'this-week' && (days < 0 || days > 6)) return false;
        }
      }
      return true;
    });
    // nowTick re-runs the filter at every tick so date-based filters
    // (overdue/today/this-week) update without a server reload.
  }, [tasks, projectById, filterProject, filterPlacementNode, filterPriority, filterDue, nowTick]);

  const columnTasks = useMemo(() => {
    const map = {};
    BOARD_COLUMNS.forEach(c => { map[c.id] = []; });
    filtered.forEach(t => {
      const col = map[t.status] ? t.status : 'backlog';
      map[col].push(t);
    });
    // Comparators. Manual = persisted sort_order (drag-friendly).
    // Other modes are display-only — drag-to-reorder is disabled in those modes.
    const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
    const cmpManual = (a, b) => (a.sort_order || 0) - (b.sort_order || 0);
    const cmpDueAsc = (a, b) => {
      const da = daysUntilDue(a.due_date);
      const db = daysUntilDue(b.due_date);
      // null (no due date) sinks to bottom
      if (da === null && db === null) return cmpManual(a, b);
      if (da === null) return 1;
      if (db === null) return -1;
      if (da !== db) return da - db;
      return cmpManual(a, b);
    };
    const cmpDueDesc = (a, b) => {
      const da = daysUntilDue(a.due_date);
      const db = daysUntilDue(b.due_date);
      if (da === null && db === null) return cmpManual(a, b);
      if (da === null) return 1;
      if (db === null) return -1;
      if (da !== db) return db - da;
      return cmpManual(a, b);
    };
    const cmpPriority = (a, b) => {
      const pa = PRIORITY_RANK[a.priority] ?? 99;
      const pb = PRIORITY_RANK[b.priority] ?? 99;
      if (pa !== pb) return pa - pb;
      return cmpManual(a, b);
    };
    const cmp = sortMode === 'due-asc' ? cmpDueAsc
      : sortMode === 'due-desc' ? cmpDueDesc
      : sortMode === 'priority' ? cmpPriority
      : cmpManual;
    Object.values(map).forEach(arr => arr.sort(cmp));
    return map;
  }, [filtered, sortMode, nowTick]);

  // Phase G: extracted from handleDrop so the inline keyboard `select` on
  // each TaskCard can move a task without going through a drag/drop event
  // payload. The two paths share identical semantics — including the
  // "in_progress requires execute confirmation" branch.
  const moveTaskToStatus = async (task, columnId) => {
    if (!task || task.status === columnId) return;
    if (columnId === 'in_progress' && task.status !== 'in_progress') {
      setExecuteTask({ ...task, _previousStatus: task.status });
      return;
    }
    try {
      await apiFetch(`/api/tasks/${task.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: columnId }),
      });
      reloadTasks();
    } catch (err) {
      addToast(err.message, 'error');
    }
  };

  const handleDrop = async (columnId, e) => {
    e.preventDefault();
    setDragTarget(null);
    const taskId = e.dataTransfer.getData('text/plain');
    if (!taskId) return;
    const task = tasks.find(t => t.id === taskId);
    await moveTaskToStatus(task, columnId);
  };

  const handleExecute = async (taskId, agentProfileId, prompt, skillPackIds, presetId) => {
    const prevStatus = executeTask?._previousStatus || 'todo';
    // Move task to in_progress first, then execute
    try {
      await apiFetch(`/api/tasks/${taskId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'in_progress' }),
      });
    } catch (statusErr) {
      // If task is already in_progress, continue with execution
      if (!statusErr.message?.includes('in_progress')) throw statusErr;
    }
    try {
      await apiFetch(`/api/tasks/${taskId}/execute`, {
        method: 'POST',
        body: JSON.stringify({ agent_profile_id: agentProfileId, prompt: prompt || undefined, skill_pack_ids: skillPackIds, preset_id: presetId || undefined }),
      });
    } catch (err) {
      // Rollback: if execution failed, revert to previous status
      try {
        await apiFetch(`/api/tasks/${taskId}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status: prevStatus }),
        });
      } catch { /* best effort rollback */ }
      reloadTasks();
      throw err;
    }
    reloadTasks();
  };

  const handleTaskCreated = (task) => {
    reloadTasks();
  };

  const handleTaskClick = (task) => {
    // Always open the task detail panel
    setDetailTask(task);
  };

  // Keep detailTask in sync with latest task data
  const currentDetailTask = detailTask ? tasks.find(t => t.id === detailTask.id) || detailTask : null;

  return html`
    <div class="board-view" data-view="board">
      <div class="board-toolbar">
        <h1 class="board-toolbar-title">작업</h1>
        <${BoardModeTabs} active="board" />
        <div class="board-toolbar-spacer"></div>
        <div class="board-filter">
          <${Dropdown}
            wide
            value=${filterProject}
            onChange=${setFilterProject}
            options=${[
              { value: '', label: FILTER_LABELS.allProjects },
              ...projects.map(p => ({ value: p.id, label: p.name })),
            ]}
            ariaLabel="프로젝트 폴더 필터"
          />
          <div data-role="node-filter" title="배치 노드 필터 (프로젝트 폴더 바인딩 기준)">
            <${Dropdown}
              wide
              value=${filterPlacementNode}
              onChange=${setFilterPlacementNode}
              options=${placementNodeOptions}
              title="배치 노드 필터 (프로젝트 폴더 바인딩 기준)"
              ariaLabel="배치 노드 필터"
            />
          </div>
          <${Dropdown}
            wide
            value=${filterPriority}
            onChange=${setFilterPriority}
            options=${[
              { value: '', label: FILTER_LABELS.allPriorities },
              { value: 'low', label: FILTER_LABELS.priorityLow },
              { value: 'medium', label: FILTER_LABELS.priorityMedium },
              { value: 'high', label: FILTER_LABELS.priorityHigh },
              { value: 'critical', label: FILTER_LABELS.priorityCritical },
            ]}
            ariaLabel="우선순위 필터"
          />
          <${Dropdown}
            wide
            value=${filterDue}
            onChange=${setFilterDue}
            options=${[
              { value: '', label: FILTER_LABELS.allDueDates },
              { value: 'overdue', label: '\u23F0 지난 마감' },
              { value: 'today', label: FILTER_LABELS.dueToday },
              { value: 'this-week', label: FILTER_LABELS.dueThisWeek },
              { value: 'no-due', label: FILTER_LABELS.noDueDate },
            ]}
            title="마감일 필터"
            ariaLabel="마감일 필터"
          />
          <${Dropdown}
            wide
            value=${sortMode}
            onChange=${setSortMode}
            options=${[
              { value: 'manual', label: '수동 정렬' },
              { value: 'due-asc', label: '마감일 \u2191 (임박순)' },
              { value: 'due-desc', label: '마감일 \u2193 (먼 순)' },
              { value: 'priority', label: '우선순위순' },
            ]}
            title="컬럼 내 카드 정렬 (드래그는 컬럼 이동에만 사용)"
            ariaLabel="정렬 방식"
          />
        </div>
        <button class="primary" onClick=${() => setShowNewTask(true)}>+ ${MANAGER_LABELS.newTask}</button>
      </div>
      <!-- scrollable-region-focusable: an EMPTY board (fresh DB) has no focusable
           cards inside this scroll container, which axe flags as serious. Same
           fix pattern as DashboardView .triage-feed (K-4 followup). -->
      <div class="board-columns" tabindex="0" role="region" aria-label="작업 보드 컬럼">
        ${BOARD_COLUMNS.map(col => {
          const colTasks = columnTasks[col.id] || [];
          return html`
            <div
              key=${col.id}
              class="board-column ${dragTarget === col.id ? 'drag-over' : ''}"
              onDragOver=${(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragTarget(col.id); }}
              onDragLeave=${(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragTarget(null); }}
              onDrop=${(e) => handleDrop(col.id, e)}
            >
              <div class="column-header">
                <span class="column-title">${col.label}</span>
                <span class="column-count">${colTasks.length}</span>
              </div>
              <div class="column-cards">
                ${colTasks.map(task => html`
                  <${TaskCard}
                    key=${task.id}
                    task=${task}
                    projects=${projects}
                    runs=${runs}
                    onDragStart=${() => {}}
                    onClick=${handleTaskClick}
                    onMoveStatus=${moveTaskToStatus}
                  />
                `)}
              </div>
            </div>
          `;
        })}
      </div>
      <${NewTaskModal}
        open=${showNewTask}
        onClose=${() => setShowNewTask(false)}
        projects=${projects}
        agents=${agents}
        onCreated=${handleTaskCreated}
      />
      <${ExecuteModal}
        open=${!!executeTask}
        task=${executeTask}
        agents=${agents}
        onClose=${() => setExecuteTask(null)}
        onExecute=${handleExecute}
      />
      ${currentDetailTask && html`
        <${TaskDetailPanel}
          task=${currentDetailTask}
          onClose=${() => setDetailTask(null)}
          projects=${projects}
          agents=${agents}
          runs=${runs}
          onOpenRun=${onOpenRun}
          onExecute=${handleExecute}
          reloadTasks=${reloadTasks}
        />
      `}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Calendar View — month grid showing tasks by due_date
// ─────────────────────────────────────────────────────────────────────────────

export function CalendarView({ tasks, projects, agents, runs, reloadTasks, onOpenRun }) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [cursor, setCursor] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [detailTask, setDetailTask] = useState(null);
  const [filterProject, setFilterProject] = useState('');
  useNowTick(60_000);

  // Filter tasks by project before grouping by date
  const filteredTasks = useMemo(() => {
    if (!filterProject) return tasks;
    return tasks.filter(t => t.project_id === filterProject);
  }, [tasks, filterProject]);

  // Build 6-week grid starting from the Sunday on/before the 1st of cursor month
  const grid = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const start = new Date(first);
    start.setDate(first.getDate() - first.getDay()); // back to Sunday
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      cells.push({
        date: d,
        iso,
        inMonth: d.getMonth() === cursor.getMonth(),
        isToday: d.getTime() === today.getTime(),
      });
    }
    return cells;
  }, [cursor]);

  // Group tasks by due_date string for fast lookup
  const tasksByDate = useMemo(() => {
    const map = {};
    filteredTasks.forEach(t => {
      if (!t.due_date) return;
      (map[t.due_date] ||= []).push(t);
    });
    // Sort within day by priority (critical first), then title
    const PRI = { critical: 0, high: 1, medium: 2, low: 3 };
    Object.values(map).forEach(arr => arr.sort((a, b) => {
      const pa = PRI[a.priority] ?? 99;
      const pb = PRI[b.priority] ?? 99;
      if (pa !== pb) return pa - pb;
      return (a.title || '').localeCompare(b.title || '');
    }));
    return map;
  }, [filteredTasks]);

  const monthLabel = `${cursor.getFullYear()}년 ${cursor.getMonth() + 1}월`;
  const goPrev = () => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1));
  const goNext = () => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1));
  const goToday = () => setCursor(new Date(today.getFullYear(), today.getMonth(), 1));

  const currentDetailTask = detailTask ? tasks.find(t => t.id === detailTask.id) || detailTask : null;
  const weekdayLabels = ['일', '월', '화', '수', '목', '금', '토'];

  return html`
    <div class="calendar-view">
      <div class="board-toolbar">
        <h1 class="board-toolbar-title">작업</h1>
        <${BoardModeTabs} active="calendar" />
        <div class="board-toolbar-spacer"></div>
        <div class="board-filter">
          <${Dropdown}
            wide
            value=${filterProject}
            onChange=${setFilterProject}
            options=${[
              { value: '', label: FILTER_LABELS.allProjects },
              ...projects.map(p => ({ value: p.id, label: p.name })),
            ]}
            ariaLabel="프로젝트 폴더 필터"
          />
        </div>
        <div class="calendar-nav">
          <button class="ghost" onClick=${goPrev} title="이전 달">\u2039</button>
          <button class="ghost" onClick=${goToday}>오늘</button>
          <button class="ghost" onClick=${goNext} title="다음 달">\u203A</button>
          <span class="calendar-month-label">${monthLabel}</span>
        </div>
      </div>
      <div class="calendar-grid">
        <div class="calendar-weekday-row">
          ${weekdayLabels.map((w, i) => html`
            <div key=${w} class="calendar-weekday ${i === 0 ? 'sun' : ''} ${i === 6 ? 'sat' : ''}">${w}</div>
          `)}
        </div>
        <div class="calendar-cells">
          ${grid.map(cell => {
            const dayTasks = tasksByDate[cell.iso] || [];
            return html`
              <div key=${cell.iso}
                class="calendar-cell ${cell.inMonth ? '' : 'out-month'} ${cell.isToday ? 'today' : ''}">
                <div class="calendar-cell-header">
                  <span class="calendar-cell-day">${cell.date.getDate()}</span>
                  ${dayTasks.length > 0 && html`
                    <span class="calendar-cell-count">${dayTasks.length}</span>
                  `}
                </div>
                <div class="calendar-cell-tasks">
                  ${dayTasks.slice(0, 4).map(t => {
                    const due = dueDateMeta(t);
                    return html`
                      <button key=${t.id}
                        class="calendar-task ${due ? `due-${due.state}` : ''} ${t.status === 'done' ? 'is-done' : ''}"
                        title=${t.title}
                        onClick=${() => setDetailTask(t)}>
                        ${t.title}
                      </button>
                    `;
                  })}
                  ${dayTasks.length > 4 && html`
                    <div class="calendar-task-more">+${dayTasks.length - 4} more</div>
                  `}
                </div>
              </div>
            `;
          })}
        </div>
      </div>
      ${currentDetailTask && html`
        <${TaskDetailPanel}
          task=${currentDetailTask}
          onClose=${() => setDetailTask(null)}
          projects=${projects}
          agents=${agents}
          runs=${runs}
          onOpenRun=${onOpenRun}
          onExecute=${async () => {}}
          reloadTasks=${reloadTasks}
        />
      `}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Directory Picker (Preact component — reuses existing directory-* CSS classes)
// ─────────────────────────────────────────────────────────────────────────────

export function DirectoryPicker({ value, onSelect }) {
  const [open, setOpen] = useState(false);
  const [currentPath, setCurrentPath] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [dirs, setDirs] = useState([]);
  const [showHidden, setShowHidden] = useState(false);
  const [loading, setLoading] = useState(false);

  const loadDir = async (targetPath) => {
    setLoading(true);
    try {
      const hq = showHidden ? 'showHidden=1' : 'showHidden=0';
      const url = targetPath
        ? `/api/fs?path=${encodeURIComponent(targetPath)}&${hq}`
        : `/api/fs?${hq}`;
      const data = await apiFetch(url);
      setRootPath(data.root);
      setCurrentPath(data.path);
      setDirs(data.directories || []);
    } catch (err) {
      addToast(err.message, 'error');
    }
    setLoading(false);
  };

  const handleOpen = () => {
    setOpen(true);
    loadDir(value || null);
  };

  const handleUp = () => {
    if (currentPath && currentPath !== rootPath) {
      const parent = currentPath.split('/').slice(0, -1).join('/') || '/';
      loadDir(parent);
    }
  };

  const handleConfirm = () => {
    if (currentPath) {
      onSelect(currentPath);
      setOpen(false);
    }
  };

  // Reload when toggling hidden
  useEffect(() => {
    if (open && currentPath) loadDir(currentPath);
  }, [showHidden]);

  return html`
    <div class="form-field">
      <label class="form-label">${DIRECTORY_PICKER_LABELS.fieldLabel}</label>
      <div class="dir-picker-row">
        <input
          class="form-input dir-picker-input"
          value=${value}
          readOnly
          placeholder=${DIRECTORY_PICKER_LABELS.inputPlaceholder}
          onClick=${handleOpen}
        />
        <button type="button" class="ghost dir-picker-btn" onClick=${handleOpen}>${DIRECTORY_PICKER_LABELS.browse}</button>
        ${value && html`
          <button type="button" class="ghost dir-picker-btn dir-picker-clear" aria-label=${DIRECTORY_PICKER_LABELS.clear} onClick=${() => onSelect('')}>✕</button>
        `}
      </div>
    </div>

    <${Modal} open=${!!open} onClose=${() => setOpen(false)}
              labelledBy="dir-picker-title" panelClass="directory-panel">
      <div class="directory-header">
        <h2 class="directory-title" id="dir-picker-title">${DIRECTORY_PICKER_LABELS.modalTitle}</h2>
        <button class="ghost" onClick=${() => setOpen(false)}>${COMMON_ACTIONS.close}</button>
      </div>
      <div class="directory-path">${currentPath || '...'}</div>
      <div class="directory-toggle">
        <label class="directory-toggle-label">
          <input type="checkbox" checked=${showHidden} onChange=${e => setShowHidden(e.target.checked)} />
          ${DIRECTORY_PICKER_LABELS.showHidden}
        </label>
      </div>
      <div class="directory-list" style="max-height: 300px;">
        ${currentPath !== rootPath && html`
          <button type="button" class="directory-item" aria-label=${DIRECTORY_PICKER_LABELS.upHint} onClick=${handleUp}>⬆ ..</button>
        `}
        ${loading && html`<div style="color: var(--text-secondary); font-size: 13px; padding: 8px;">${DIRECTORY_PICKER_LABELS.loading}</div>`}
        ${!loading && dirs.length === 0 && html`
          <div style="color: var(--text-secondary); font-size: 13px; padding: 8px;">${DIRECTORY_PICKER_LABELS.empty}</div>
        `}
        ${!loading && dirs.map(d => html`
          <button key=${d.path} type="button" class="directory-item" onClick=${() => loadDir(d.path)}>
            📁 ${d.name}
          </button>
        `)}
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 8px; padding-top: 4px;">
        <button class="ghost" onClick=${() => setOpen(false)}>${COMMON_ACTIONS.cancel}</button>
        <button class="primary" onClick=${handleConfirm}>${DIRECTORY_PICKER_LABELS.select}</button>
      </div>
    </Modal>
  `;
}
