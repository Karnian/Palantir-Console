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

// ─────────────────────────────────────────────────────────────────────────────
// Kanban Board View — internal constants
// ─────────────────────────────────────────────────────────────────────────────

const BOARD_COLUMNS = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'todo', label: 'Todo' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'failed', label: 'Failed' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
];

function TaskCard({ task, projects, onDragStart, onClick }) {
  const project = projects.find(p => p.id === task.project_id);
  const due = dueDateMeta(task);

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
      onClick=${() => onClick(task)}
    >
      <div class="task-card-title">${task.title}</div>
      <div class="task-card-badges">
        ${project && html`<span class="task-badge project">${project.name}</span>`}
        ${task.priority && task.priority !== 'medium' && html`
          <span class="task-badge priority-${task.priority}">${task.priority}</span>
        `}
        ${task.agent_profile_id && html`
          <span class="task-badge agent">\u2699 agent</span>
        `}
        ${due && html`
          <span class="task-badge due-badge due-${due.state}" title=${`마감일 ${due.formatted}`}>
            \u23F0 ${due.label}
          </span>
        `}
        ${task.recurrence && html`
          <span class="task-badge recurrence" title=${`반복: ${task.recurrence}`}>\u21BB ${task.recurrence}</span>
        `}
      </div>
      ${task.updated_at && html`
        <div class="task-card-meta">${timeAgo(task.updated_at || task.created_at)}</div>
      `}
    </div>
  `;
}

// Tab toggle shown in both Board and Calendar toolbars so the user can flip
// between the two views without leaving the task workflow.
function BoardModeTabs({ active }) {
  return html`
    <div class="board-mode-tabs" role="tablist">
      <button
        role="tab"
        class="board-mode-tab ${active === 'board' ? 'active' : ''}"
        aria-selected=${active === 'board'}
        onClick=${() => navigate('board')}>
        \u2592 Board
      </button>
      <button
        role="tab"
        class="board-mode-tab ${active === 'calendar' ? 'active' : ''}"
        aria-selected=${active === 'calendar'}
        onClick=${() => navigate('calendar')}>
        \u2637 Calendar
      </button>
    </div>
  `;
}

export function BoardView({ tasks, setTasks, projects, agents, runs, onOpenRun, reloadTasks }) {
  const [showNewTask, setShowNewTask] = useState(false);
  const [executeTask, setExecuteTask] = useState(null);
  const [detailTask, setDetailTask] = useState(null);
  const [filterProject, setFilterProject] = useState('');
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

  const filtered = useMemo(() => {
    return tasks.filter(t => {
      if (filterProject && t.project_id !== filterProject) return false;
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
  }, [tasks, filterProject, filterPriority, filterDue, nowTick]);

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

  const handleDrop = async (columnId, e) => {
    e.preventDefault();
    setDragTarget(null);
    const taskId = e.dataTransfer.getData('text/plain');
    if (!taskId) return;

    const task = tasks.find(t => t.id === taskId);
    if (!task || task.status === columnId) return;

    // If moving to in_progress, open execute modal
    if (columnId === 'in_progress' && task.status !== 'in_progress') {
      // Store previous status so we can rollback if modal is cancelled
      setExecuteTask({ ...task, _previousStatus: task.status });
      return;
    }

    try {
      await apiFetch(`/api/tasks/${taskId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: columnId }),
      });
      reloadTasks();
    } catch (err) {
      addToast(err.message, 'error');
    }
  };

  const handleExecute = async (taskId, agentProfileId, prompt, skillPackIds) => {
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
        body: JSON.stringify({ agent_profile_id: agentProfileId, prompt: prompt || undefined, skill_pack_ids: skillPackIds }),
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
    <div class="board-view">
      <div class="board-toolbar">
        <h1 class="board-toolbar-title">Tasks</h1>
        <${BoardModeTabs} active="board" />
        <div class="board-toolbar-spacer"></div>
        <div class="board-filter">
          <select class="form-select" value=${filterProject} onChange=${e => setFilterProject(e.target.value)}>
            <option value="">All Projects</option>
            ${projects.map(p => html`<option key=${p.id} value=${p.id}>${p.name}</option>`)}
          </select>
          <select class="form-select" value=${filterPriority} onChange=${e => setFilterPriority(e.target.value)}>
            <option value="">All Priorities</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
          <select class="form-select" value=${filterDue} onChange=${e => setFilterDue(e.target.value)}
            title="마감일 필터">
            <option value="">전체 마감일</option>
            <option value="overdue">\u23F0 지난 마감</option>
            <option value="today">오늘 마감</option>
            <option value="this-week">이번 주 (7일 이내)</option>
            <option value="no-due">마감일 없음</option>
          </select>
          <select class="form-select" value=${sortMode} onChange=${e => setSortMode(e.target.value)}
            title="컬럼 내 카드 정렬 (드래그는 컬럼 이동에만 사용)">
            <option value="manual">수동 정렬</option>
            <option value="due-asc">마감일 \u2191 (임박순)</option>
            <option value="due-desc">마감일 \u2193 (먼 순)</option>
            <option value="priority">우선순위순</option>
          </select>
        </div>
        <button class="primary" onClick=${() => setShowNewTask(true)}>+ New Task</button>
      </div>
      <div class="board-columns">
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
                    onDragStart=${() => {}}
                    onClick=${handleTaskClick}
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
        <h1 class="board-toolbar-title">Tasks</h1>
        <${BoardModeTabs} active="calendar" />
        <div class="board-toolbar-spacer"></div>
        <div class="board-filter">
          <select class="form-select" value=${filterProject} onChange=${e => setFilterProject(e.target.value)}>
            <option value="">All Projects</option>
            ${projects.map(p => html`<option key=${p.id} value=${p.id}>${p.name}</option>`)}
          </select>
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
      <label class="form-label">Directory</label>
      <div class="dir-picker-row">
        <input
          class="form-input dir-picker-input"
          value=${value}
          readOnly
          placeholder="Select project directory..."
          onClick=${handleOpen}
        />
        <button type="button" class="ghost dir-picker-btn" onClick=${handleOpen}>Browse</button>
        ${value && html`
          <button type="button" class="ghost dir-picker-btn dir-picker-clear" onClick=${() => onSelect('')}>✕</button>
        `}
      </div>
    </div>

    ${open && html`
      <div class="directory-modal">
        <div class="directory-backdrop" onClick=${() => setOpen(false)}></div>
        <div class="directory-panel">
          <div class="directory-header">
            <span class="directory-title">Select Directory</span>
            <button class="ghost" onClick=${() => setOpen(false)}>Close</button>
          </div>
          <div class="directory-path">${currentPath || '...'}</div>
          <div class="directory-toggle">
            <label class="directory-toggle-label">
              <input type="checkbox" checked=${showHidden} onChange=${e => setShowHidden(e.target.checked)} />
              Show hidden
            </label>
          </div>
          <div class="directory-list" style="max-height: 300px;">
            ${currentPath !== rootPath && html`
              <button type="button" class="directory-item" onClick=${handleUp}>⬆ ..</button>
            `}
            ${loading && html`<div style="color: var(--text-secondary); font-size: 13px; padding: 8px;">Loading...</div>`}
            ${!loading && dirs.length === 0 && html`
              <div style="color: var(--text-secondary); font-size: 13px; padding: 8px;">No subfolders.</div>
            `}
            ${!loading && dirs.map(d => html`
              <button key=${d.path} type="button" class="directory-item" onClick=${() => loadDir(d.path)}>
                📁 ${d.name}
              </button>
            `)}
          </div>
          <div style="display: flex; justify-content: flex-end; gap: 8px; padding-top: 4px;">
            <button class="ghost" onClick=${() => setOpen(false)}>Cancel</button>
            <button class="primary" onClick=${handleConfirm}>Select</button>
          </div>
        </div>
      </div>
    `}
  `;
}
