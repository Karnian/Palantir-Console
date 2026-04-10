/* global preact, preactHooks, htm, formatDuration, formatTime, timeAgo, renderMarkdown, apiFetch */
/* global dueState, formatDueDate, useNowTick, dueDateMeta */
/* global DashboardView, BoardView, CalendarView, DirectoryPicker, ProjectsView, AgentsView, SessionsView */
/* global NewTaskModal, ExecuteModal, TaskDetailPanel */
/* global requestNotificationPermission, showBrowserNotification, pulseTabTitle */
// Helpers (formatDuration / formatTime / timeAgo / renderMarkdown / apiFetch)
// are provided by app/main.js, which imports them from app/lib/* and bridges
// them onto window before this script runs. See app/main.js for the wiring
// and the Phase 4 refactor notes there.
//
// Due-date helpers (dueState, formatDueDate, useNowTick, dueDateMeta) —
// extracted to app/lib/dueDate.js (P5-1). Bridged onto window by
// app/components/DashboardView.js, which is loaded by main.js before app.js.
// Bare-identifier usage below resolves via global (window) scope.
//
// DashboardView — extracted to app/components/DashboardView.js (P5-1).
// BoardView, CalendarView, DirectoryPicker — extracted to app/components/BoardView.js (P5-2).
// ProjectsView (+ ProjectDetailModal) — extracted to app/components/ProjectsView.js (P5-3).
// AgentsView (+ AgentModal + AgentDetailModal) — extracted to app/components/AgentsView.js (P5-4).
// SessionsView (+ initLegacySessions) — extracted to app/components/SessionsView.js (P6-3).
// All bridged onto window by main.js before this script runs.
const { h, render } = preact;
const { useState, useEffect, useRef, useCallback, useMemo } = preactHooks;
const html = htm.bind(h);

// ─────────────────────────────────────────────────────────────────────────────
// Hash Router
// ─────────────────────────────────────────────────────────────────────────────

// All application hooks (useRoute, navigate, useEscape, useSSE, useTasks,
// useRuns, useProjects, useClaudeSessions, useAgents, useManager) live in
// app/lib/hooks.js — main.js imports them and bridges each onto window
// before app.js loads, so the call sites below resolve via global lookup.

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar Navigation
// ─────────────────────────────────────────────────────────────────────────────

const NAV_ITEMS = [
  { hash: 'dashboard', icon: '\u25C9', label: 'Dashboard' },
  { hash: 'manager',   icon: '\u2726', label: 'Manager' },
  { hash: 'board',     icon: '\u2592', label: 'Task Board' },
  { hash: 'projects',  icon: '\u25A3', label: 'Projects' },
  { hash: 'agents',    icon: '\u2699', label: 'Agents' },
];
// Bridge NAV_ITEMS for the extracted CommandPalette ESM module.
window.NAV_ITEMS = NAV_ITEMS;

function NavSidebar({ route, connected }) {
  return html`
    <nav class="nav-sidebar">
      <div class="nav-brand" title="Palantir Console">\u2726</div>
      ${NAV_ITEMS.map(item => html`
        <button
          key=${item.hash}
          class="nav-item ${route.split('/')[0] === item.hash ? 'active' : ''}"
          onClick=${() => navigate(item.hash)}
        >
          ${item.icon}
          <span class="nav-tooltip">${item.label}</span>
        </button>
      `)}
      <div class="nav-spacer"></div>
      <div class="nav-status" title=${connected ? 'SSE Connected' : 'SSE Disconnected'}>
        <span class="status-dot ${connected ? 'status-dot-ok' : 'status-dot-err'}"></span>
      </div>
    </nav>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading / Empty components
// ─────────────────────────────────────────────────────────────────────────────

function Loading() {
  return html`
    <div class="loading-spinner">
      <span class="spinner-dot"></span>
      <span class="spinner-dot"></span>
      <span class="spinner-dot"></span>
    </div>
  `;
}

// EmptyState — extracted to server/public/app/components/EmptyState.js (P3-2).
// Bridged onto window by main.js. The bare identifier `EmptyState` below
// in htm templates resolves via global scope.

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard View — extracted to app/components/DashboardView.js (P5-1).
// Bridged onto window by main.js. The bare identifier `DashboardView` in htm
// templates below resolves via global scope.
// ─────────────────────────────────────────────────────────────────────────────

// Dropdown — extracted to server/public/app/components/Dropdown.js (P3-2).
// Bridged onto window by main.js. The bare identifier `Dropdown` in htm
// templates below resolves via global scope.

// ─────────────────────────────────────────────────────────────────────────────
// Task Modals — NewTaskModal, ExecuteModal, TaskDetailPanel extracted to
// app/components/TaskModals.js (P7-1). Bridged onto window by main.js.
// Bare identifiers `NewTaskModal`, `ExecuteModal`, `TaskDetailPanel` in htm
// templates below resolve via global scope.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Run Inspector Modal
// ─────────────────────────────────────────────────────────────────────────────

// RunInspector lives in app/components/RunInspector.js — main.js imports it
// and bridges it onto window.RunInspector before app.js loads. The htm
// templates below reference it as a bare identifier (e.g. `<${RunInspector}>`),
// which resolves via the script-global lookup down to the window property.

// ─────────────────────────────────────────────────────────────────────────────
// Kanban Board View — BoardView, CalendarView, DirectoryPicker extracted to
// app/components/BoardView.js (P5-2). Bridged onto window by main.js.
// Bare identifiers `BoardView`, `CalendarView`, `DirectoryPicker` resolve
// via global scope.
//
// Projects View — ProjectDetailModal + ProjectsView extracted to
// app/components/ProjectsView.js (P5-3). Bridged onto window by main.js.
// Bare identifier `ProjectsView` resolves via global scope.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Sessions View — SessionsView + initLegacySessions extracted to
// app/components/SessionsView.js (P6-3). Bridged onto window by main.js.
// Bare identifier `SessionsView` resolves via global scope.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Toast Notification System
// ─────────────────────────────────────────────────────────────────────────────

// Toast system (addToast, useToasts, ToastContainer, apiFetchWithToast) lives
// in app/lib/toast.js — main.js imports it and bridges the symbols onto
// window before app.js loads, so the call sites here resolve via global
// lookup. See app/lib/toast.js for the implementation.

// ─────────────────────────────────────────────────────────────────────────────
// Browser Notifications + Tab Title Pulse — extracted to
// app/lib/notifications.js (P7-4). Bridged onto window by main.js.
// Bare identifiers `requestNotificationPermission`, `showBrowserNotification`,
// `pulseTabTitle` resolve via global scope. Permission side-effect (click /
// keydown listeners) runs inside the notifications module at import time.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Agent Config View — AgentModal + AgentDetailModal + AgentsView extracted to
// app/components/AgentsView.js (P5-4). Bridged onto window by main.js.
// Bare identifier `AgentsView` resolves via global scope.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Manager View — ManagerView + managerProfileAuthState extracted to
// app/components/ManagerView.js (P6-1). Bridged onto window by main.js.
// Bare identifier `ManagerView` resolves via global scope.
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Command Palette
//
// CommandPalette — extracted to app/components/CommandPalette.js
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// v3 Phase 7 — Drift Drawer
//
// Extracted to an ES module as the first step of P2-10 (ESM phase 1).
// See server/public/app/components/DriftDrawer.js for the component
// body. This file references `DriftDrawer` as a bare global identifier
// — main.js assigns window.DriftDrawer before app.js loads so the
// HTM templates that use `<${DriftDrawer} ... />` continue to resolve
// via a global lookup. Behavior and rendered output are unchanged.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// App Root
// ─────────────────────────────────────────────────────────────────────────────

function App() {
  const route = useRoute();
  const { tasks, setTasks, loading: tasksLoading, reload: reloadTasks } = useTasks();
  const { runs, setRuns, loading: runsLoading, reload: reloadRuns } = useRuns();
  const { projects, loading: projectsLoading, reload: reloadProjects } = useProjects();
  const { agents, loading: agentsLoading, error: agentsError, reload: reloadAgents } = useAgents();
  const { sessions: claudeSessions } = useClaudeSessions();
  const manager = useManager();
  // v3 Phase 7: drift badge + drawer + per-PM indicator shared state.
  const driftAudit = useDispatchAudit();
  const [showDriftDrawer, setShowDriftDrawer] = useState(false);
  const [inspectRun, setInspectRun] = useState(null);
  // Global task detail popup — opened from Dashboard, ProjectDetailModal, etc.
  // BoardView/CalendarView still manage their own local detail state because
  // they have richer interactions (drag, execute, etc.).
  const [inspectTask, setInspectTask] = useState(null);
  const [showPalette, setShowPalette] = useState(false);

  // Helper to look up task title for a run (used in notifications).
  //
  // v3 Phase 5: SSE payloads carry the full run row under `data.run`
  // plus hoisted envelope fields (task_id, project_id, from_status,
  // to_status, reason). PR3b / X3 makes this reader STRICT about the
  // envelope shape: the pre-PR3b fallback `data.taskId` (camelCase)
  // never existed in any Phase 5+ emitter — it was there to catch a
  // hypothetical legacy shape that we then confirmed doesn't ship. The
  // fallback masked real envelope drift (e.g. a new channel forgetting
  // to hoist `task_id`) because the camelCase branch silently returned
  // undefined instead of triggering the `run.title` fallback path.
  // Removing it forces every emitter to conform to the Phase 5 contract.
  const getRunTaskTitle = useCallback((data) => {
    const run = (data && data.run) || data || {};
    const taskId = (data && data.task_id) || run.task_id;
    if (taskId) {
      const task = tasks.find(t => t.id === taskId);
      if (task) return task.title;
    }
    return run.title || (data && data.title) || `Run ${(run.id || (data && data.id) || '').slice(0, 8)}`;
  }, [tasks]);

  // Debounced reloads to prevent SSE burst storms
  const _reloadTimers = useRef({});
  const debouncedReload = useCallback((key, fn, delay = 300) => {
    if (_reloadTimers.current[key]) clearTimeout(_reloadTimers.current[key]);
    _reloadTimers.current[key] = setTimeout(fn, delay);
  }, []);

  // SSE integration with browser notifications
  const { connected: sseConnected } = useSSE({
    'task:created': () => debouncedReload('tasks', reloadTasks),
    'task:updated': () => debouncedReload('tasks', reloadTasks),
    'task:deleted': () => debouncedReload('tasks', reloadTasks),
    'run:created': () => { debouncedReload('runs', reloadRuns); debouncedReload('tasks', reloadTasks); },
    'run:status': (data) => {
      debouncedReload('runs', reloadRuns);
      debouncedReload('tasks', reloadTasks);
      // v3 Phase 5: run:status is a generic reload-trigger channel.
      // Priority alerts (needs_input / failed) live on dedicated
      // channels (run:needs_input, run:completed) and are the sole
      // source of user-visible notifications. Surfacing needs_input
      // here would duplicate the alert emitted on run:needs_input
      // (codex R3 finding).
    },
    'run:completed': (data) => {
      debouncedReload('runs', reloadRuns);
      debouncedReload('tasks', reloadTasks);
      const status = data.to_status || (data.run && data.run.status) || data.status || 'completed';
      const title = getRunTaskTitle(data);
      if (status === 'failed') {
        showBrowserNotification('Run failed', title);
        pulseTabTitle('⚠ Run failed');
      } else {
        // Spec §9.8: only `needs_input` and `failed` qualify as
        // priority alerts. Success completions get the OS
        // notification but NO tab title pulse — otherwise routine
        // success spam would drown out the real alerts.
        showBrowserNotification('Run completed', title);
      }
    },
    // v3 Phase 5: dedicated priority-alert channel (spec §9.8). The
    // server emits this on idle timeouts. The spec mandates three
    // priority-alert mechanisms: OS notification + tab title change
    // + sound. We implement OS notification + tab title pulse here;
    // sound is deferred (browser autoplay restrictions require user
    // gesture to enable, which needs settings UI outside this phase).
    'run:needs_input': (data) => {
      debouncedReload('runs', reloadRuns);
      debouncedReload('tasks', reloadTasks);
      showBrowserNotification('Agent needs input', getRunTaskTitle(data));
      pulseTabTitle('⚠ Needs input');
    },
    // v3 Phase 7: live refresh of the drift badge / drawer on every
    // new audit row. Debounced so a burst of PM claims doesn't fan
    // out into dozens of refetches. The reload path is idempotent.
    'dispatch_audit:recorded': () => {
      debouncedReload('dispatch_audit', driftAudit.reload);
    },
  });

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      // Cmd+K / Ctrl+K: toggle command palette
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setShowPalette(prev => !prev);
        return;
      }
      // Esc: close any open modal/palette
      if (e.key === 'Escape') {
        if (showPalette) { setShowPalette(false); return; }
        if (showDriftDrawer) { setShowDriftDrawer(false); return; }
        if (inspectRun) { setInspectRun(null); return; }
        return;
      }
      // N: open new task modal only on board view (not in input/textarea, not when modal is open)
      const tag = (e.target.tagName || '').toLowerCase();
      const isInput = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
      if (!isInput && !inspectRun && !showPalette && e.key === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const routeBase = (location.hash.slice(1) || 'dashboard').split('/')[0];
        if (routeBase === 'board') {
          window.dispatchEvent(new CustomEvent('palantir:new-task'));
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showPalette, inspectRun, showDriftDrawer]);

  const routeBase = route.split('/')[0];

  const renderView = () => {
    if (routeBase === 'manager') {
      return html`<${ManagerView} manager=${manager} runs=${runs} tasks=${tasks} projects=${projects} agents=${agents} agentsError=${agentsError} agentsLoading=${agentsLoading} reloadAgents=${reloadAgents} driftAudit=${driftAudit} onOpenDrift=${() => setShowDriftDrawer(true)} />`;
    }
    if (routeBase === 'board') {
      if (tasksLoading) return html`<${Loading} />`;
      return html`
        <${BoardView}
          tasks=${tasks}
          setTasks=${setTasks}
          projects=${projects}
          agents=${agents}
          runs=${runs}
          onOpenRun=${(run) => setInspectRun(run)}
          reloadTasks=${reloadTasks}
        />
      `;
    }
    if (routeBase === 'calendar') {
      if (tasksLoading) return html`<${Loading} />`;
      return html`
        <${CalendarView}
          tasks=${tasks}
          projects=${projects}
          agents=${agents}
          runs=${runs}
          reloadTasks=${reloadTasks}
          onOpenRun=${(run) => setInspectRun(run)}
        />
      `;
    }
    if (routeBase === 'sessions') {
      return html`<${SessionsView} />`;
    }
    if (routeBase === 'projects') {
      if (projectsLoading) return html`<${Loading} />`;
      return html`<${ProjectsView} projects=${projects} tasks=${tasks} runs=${runs} reloadProjects=${reloadProjects} onOpenRun=${(run) => setInspectRun(run)} onOpenTask=${(task) => setInspectTask(task)} />`;
    }
    if (routeBase === 'agents') {
      return html`<${AgentsView} agents=${agents} loading=${agentsLoading} reloadAgents=${reloadAgents} />`;
    }
    if (routeBase === 'run') {
      const runId = route.split('/')[1];
      if (runId) {
        const run = runs.find(r => r.id === runId);
        if (run) return html`<${RunInspector} run=${run} onClose=${() => navigate('dashboard')} />`;
      }
    }
    // Default: dashboard
    return html`
      <${DashboardView}
        tasks=${tasks}
        runs=${runs}
        onOpenRun=${(run) => setInspectRun(run)}
        onOpenTask=${(task) => setInspectTask(task)}
        onDeleteRun=${async (id) => {
          try {
            await apiFetch('/api/runs/' + id, { method: 'DELETE' });
            reloadRuns();
          } catch (err) { addToast(err.message, 'error'); }
        }}
        claudeSessions=${claudeSessions}
        manager=${manager}
        driftAudit=${driftAudit}
        onOpenDrift=${() => setShowDriftDrawer(true)}
      />
    `;
  };

  // Always-fresh task reference (so live updates flow into the open popup)
  const currentInspectTask = inspectTask
    ? tasks.find(t => t.id === inspectTask.id) || inspectTask
    : null;

  return html`
    <div class="v2-shell">
      <${NavSidebar} route=${route} connected=${sseConnected} />
      <div class="main-area">
        ${renderView()}
      </div>
      ${inspectRun && html`
        <${RunInspector}
          run=${inspectRun}
          onClose=${() => setInspectRun(null)}
        />
      `}
      ${currentInspectTask && html`
        <${TaskDetailPanel}
          task=${currentInspectTask}
          onClose=${() => setInspectTask(null)}
          projects=${projects}
          agents=${agents}
          runs=${runs}
          onOpenRun=${(run) => { setInspectTask(null); setInspectRun(run); }}
          onExecute=${async () => {}}
          reloadTasks=${reloadTasks}
        />
      `}
      <${CommandPalette} open=${showPalette} onClose=${() => setShowPalette(false)} />
      <${DriftDrawer}
        open=${showDriftDrawer}
        onClose=${() => setShowDriftDrawer(false)}
        driftAudit=${driftAudit}
        projects=${projects}
      />
      <${ToastContainer} />
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mount
// ─────────────────────────────────────────────────────────────────────────────

function mount() {
  const target = document.getElementById('app');
  if (target) {
    render(html`<${App} />`, target);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}
