// Palantir Console — App shell (ES module, P8-2).
// All dependencies imported directly; no window globals needed.

import { h, render } from './vendor/preact.module.js';
import { useState, useEffect, useRef, useCallback, useMemo } from './vendor/hooks.module.js';
import htmFactory from './vendor/htm.module.js';
const html = htmFactory.bind(h);

// Helpers
import { formatDuration, formatTime, timeAgo } from './app/lib/format.js';
import { renderMarkdown } from './app/lib/markdown.js';
import { apiFetch } from './app/lib/api.js';
import { addToast, useToasts, ToastContainer, apiFetchWithToast } from './app/lib/toast.js';
import { useRoute, navigate, useEscape, useSSE, useTasks, useRuns, useProjects, useClaudeSessions, useAgents, useManagerLifecycle, useConversation, useDispatchAudit } from './app/lib/hooks.js';
import { dueState, formatDueDate, useNowTick, dueDateMeta } from './app/lib/dueDate.js';
import { requestNotificationPermission, showBrowserNotification, pulseTabTitle } from './app/lib/notifications.js';
import { NAV_ITEMS } from './app/lib/nav.js';

// Components
import { RunInspector } from './app/components/RunInspector.js';
import { DriftDrawer } from './app/components/DriftDrawer.js';
import { Dropdown } from './app/components/Dropdown.js';
import { EmptyState } from './app/components/EmptyState.js';
import { MentionInput } from './app/components/MentionInput.js';
import { CommandPalette } from './app/components/CommandPalette.js';
import { DashboardView } from './app/components/DashboardView.js';
import { BoardView, CalendarView, DirectoryPicker } from './app/components/BoardView.js';
import { ProjectsView } from './app/components/ProjectsView.js';
import { AgentsView } from './app/components/AgentsView.js';
import { SessionsView } from './app/components/SessionsView.js';
import { ManagerView } from './app/components/ManagerView.js';
import { NewTaskModal, ExecuteModal, TaskDetailPanel } from './app/components/TaskModals.js';
import { SkillPacksView } from './app/components/SkillPacksView.js';
import { PresetsView } from './app/components/PresetsView.js';
import { McpTemplatesView } from './app/components/McpTemplatesView.js';

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar Navigation
// ─────────────────────────────────────────────────────────────────────────────

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
// Loading component (inline — too small to extract)
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
  // P8-3: useManager split → lifecycle + conversation('top')
  const managerLifecycle = useManagerLifecycle();
  const topConv = useConversation('top', { poll: true, pollMs: 2000 });
  const manager = useMemo(() => ({
    status: managerLifecycle.status,
    events: topConv.events,
    loading: managerLifecycle.loading,
    start: managerLifecycle.start,
    sendMessage: topConv.sendMessage,
    stop: managerLifecycle.stop,
    checkStatus: managerLifecycle.checkStatus,
  }), [managerLifecycle.status, topConv.events, managerLifecycle.loading, managerLifecycle.start, topConv.sendMessage, managerLifecycle.stop, managerLifecycle.checkStatus]);
  const driftAudit = useDispatchAudit();
  const [showDriftDrawer, setShowDriftDrawer] = useState(false);
  const [inspectRun, setInspectRun] = useState(null);
  const [inspectTask, setInspectTask] = useState(null);
  const [showPalette, setShowPalette] = useState(false);

  // Resolve task title for SSE payloads (Phase 5 envelope: data.run + data.task_id).
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
      // run:status is a generic reload trigger; priority alerts live on run:needs_input / run:completed.
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
        // Success: OS notification only, no tab pulse (§9.8 — only needs_input/failed are priority alerts).
        showBrowserNotification('Run completed', title);
      }
    },
    'run:needs_input': (data) => {
      debouncedReload('runs', reloadRuns);
      debouncedReload('tasks', reloadTasks);
      showBrowserNotification('Agent needs input', getRunTaskTitle(data));
      pulseTabTitle('⚠ Needs input');
    },
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
    if (routeBase === 'skills') {
      return html`<${SkillPacksView} projects=${projects} />`;
    }
    if (routeBase === 'presets') {
      return html`<${PresetsView} />`;
    }
    if (routeBase === 'mcp-servers') {
      return html`<${McpTemplatesView} />`;
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
