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

// R2-A.1: AttentionBadge — needs_input + failed count on worker runs.
// Clamped to "9+" at 10+. Renders nothing when count is 0 (spec §14.1).
// Animation: badge-pulse 2s ease-in-out infinite (spec §14.1).
function AttentionBadge({ count, onClick }) {
  if (!count || count <= 0) return null;
  const label = count >= 10 ? '9+' : String(count);
  const title = `주의 필요: ${count}건 (needs_input + failed)`;
  return html`
    <button
      type="button"
      class="attention-badge"
      title=${title}
      aria-label=${title}
      onClick=${onClick}
    >${label}</button>
  `;
}

function NavSidebar({ route, connected, attentionCount, onAttentionClick }) {
  return html`
    <nav class="nav-sidebar">
      <div class="nav-brand" title="Palantir Console">\u2726</div>
      ${NAV_ITEMS.map(item => html`
        <button
          key=${item.hash}
          class="nav-item ${route.split('/')[0] === item.hash ? 'active' : ''}"
          aria-label=${item.label}
          aria-current=${route.split('/')[0] === item.hash ? 'page' : undefined}
          onClick=${() => navigate(item.hash)}
        >
          ${item.icon}
          <span class="nav-tooltip" aria-hidden="true">${item.label}</span>
        </button>
      `)}
      <div class="nav-spacer"></div>
      <div class="nav-attention">
        <${AttentionBadge} count=${attentionCount} onClick=${onAttentionClick} />
      </div>
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
      // Esc: every overlay (palette / drift drawer / RunInspector / Modal-
      // primitive modals) now routes through the shared `useEscape` stack so
      // the topmost one closes first. The earlier app-level fallbacks were
      // racing the stack and could close more than one layer per press —
      // Phase F removed them.
      // N: open new task modal only on board view (not in input/textarea, not when modal is open)
      const tag = (e.target.tagName || '').toLowerCase();
      const isInput = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
      if (!isInput && !inspectRun && !showPalette && e.key === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // Only the explicit `#board` hash enables the `n` shortcut — an
        // empty hash no longer defaults to dashboard here (R2-C.3 landed
        // manager as the default), but since we specifically gate on
        // 'board', the empty-hash case is still a safe no-op.
        const routeBase = (location.hash.slice(1) || '').split('/')[0];
        if (routeBase === 'board') {
          window.dispatchEvent(new CustomEvent('palantir:new-task'));
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showPalette, inspectRun]);

  const routeBase = route.split('/')[0];

  // R2-A.1: attention count = needs_input + failed across worker runs only.
  // v3 multi-layer note: is_manager=1 (Top + PM sessions) are excluded so
  // only worker runs contribute — aligns with DashboardView.workerRuns filter.
  const attentionCount = useMemo(() => (
    (runs || []).filter(r => !r.is_manager && (r.status === 'needs_input' || r.status === 'failed')).length
  ), [runs]);

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
      <a class="skip-link" href="#main-content" onClick=${(e) => {
        // Phase H: hash routing reads location.hash directly (see
        // app/lib/hooks/routing.js), so a literal `#main-content` jump
        // would change the route to "main-content" and fall back to
        // Dashboard via app.js's renderView default. Cancel the
        // navigation and move keyboard focus to the main landmark
        // ourselves — the link still works for assistive-tech users
        // with JS disabled because the href anchor is preserved.
        e.preventDefault();
        const main = document.getElementById('main-content');
        if (main) main.focus();
      }}>본문으로 건너뛰기</a>
      <${NavSidebar}
        route=${route}
        connected=${sseConnected}
        attentionCount=${attentionCount}
        onAttentionClick=${() => navigate('manager')}
      />
      <main id="main-content" class="main-area" tabIndex="-1">
        ${renderView()}
      </main>
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
