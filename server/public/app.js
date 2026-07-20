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
import { operatorConversationId } from './app/lib/conversationId.js';
import { THEME_TOGGLE_LABELS, NAV_LABELS } from './app/lib/copy.js';
import { clickableProps } from './app/lib/a11y.js';

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
import { ModelPoliciesView } from './app/components/ModelPoliciesView.js';
import { NodesView } from './app/components/NodesView.js';
import { MemoryView } from './app/components/MemoryView.js';
import { SpecialistView } from './app/components/SpecialistView.js';
import { OperatorProfilesView } from './app/components/OperatorProfilesView.js';
import { OperatorsView } from './app/components/OperatorsView.js';
import { TabGroupView } from './app/components/TabGroupView.js';

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

// Phase K-2c (2026-04-28): theme toggle button.
//
// Three-state cycle: system → light → dark → system. The cycle is
// chosen so the very first click from the historical default (no
// preference set; matches `system`) takes a dark-OS user into light
// mode — exposing the new theme without a hidden config dive.
//
// Persists to `localStorage.palantir.theme`; theme-init.js reads it
// on the next page load to avoid FOUC. The `data-theme` attribute on
// `<html>` is the single source the CSS selector contract checks.
const THEME_CYCLE = ['system', 'light', 'dark'];
const THEME_ICONS = { system: '◑', light: '☀', dark: '☽' };
function applyThemeColorMeta(mode) {
  // K-2d (Codex r1 P2): keep `<meta name="theme-color">` in sync with
  // the active theme so mobile chrome doesn't disagree with the
  // toggle. `system` restores the original media-scoped pair so the
  // OS pref drives chrome color again; `light` / `dark` collapse to
  // a single unscoped tag with the matching color.
  const headEl = document.head;
  if (!headEl) return;
  const existing = headEl.querySelectorAll('meta[name="theme-color"]');
  for (let i = existing.length - 1; i >= 0; i--) {
    headEl.removeChild(existing[i]);
  }
  if (mode === 'system') {
    const dark = document.createElement('meta');
    dark.setAttribute('name', 'theme-color');
    dark.setAttribute('content', '#09090b');
    dark.setAttribute('media', '(prefers-color-scheme: dark)');
    headEl.appendChild(dark);
    const light = document.createElement('meta');
    light.setAttribute('name', 'theme-color');
    light.setAttribute('content', '#fafafa');
    light.setAttribute('media', '(prefers-color-scheme: light)');
    headEl.appendChild(light);
  } else {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    meta.setAttribute('content', mode === 'light' ? '#fafafa' : '#09090b');
    headEl.appendChild(meta);
  }
}

function applyTheme(mode) {
  const html = document.documentElement;
  if (mode === 'light' || mode === 'dark') {
    html.setAttribute('data-theme', mode);
  } else {
    html.removeAttribute('data-theme');
  }
  try {
    if (mode === 'system') {
      window.localStorage.removeItem('palantir.theme');
    } else {
      window.localStorage.setItem('palantir.theme', mode);
    }
  } catch (e) { /* localStorage unavailable — no persistence */ }
  applyThemeColorMeta(mode);
}
function readTheme() {
  try {
    const v = window.localStorage.getItem('palantir.theme');
    if (v === 'light' || v === 'dark') return v;
  } catch (e) { /* fall through */ }
  return 'system';
}

function ThemeToggle() {
  const [mode, setMode] = useState(readTheme);
  const next = THEME_CYCLE[(THEME_CYCLE.indexOf(mode) + 1) % THEME_CYCLE.length];
  const onClick = () => {
    applyTheme(next);
    setMode(next);
  };
  return html`
    <button
      type="button"
      class="theme-toggle"
      data-mode=${mode}
      aria-label=${THEME_TOGGLE_LABELS.ariaLabel}
      title=${THEME_TOGGLE_LABELS.tooltip(mode, next)}
      onClick=${onClick}
    >${THEME_ICONS[mode]}</button>
  `;
}

function NavSidebar({ route, connected, attentionCount, onAttentionClick }) {
  return html`
    <nav class="nav-sidebar">
      <div
        class="nav-brand ${route.split('/')[0] === 'dashboard' ? 'active' : ''}"
        aria-label=${NAV_LABELS.dashboard}
        title=${NAV_LABELS.dashboard}
        aria-current=${route.split('/')[0] === 'dashboard' ? 'page' : undefined}
        ...${clickableProps(() => navigate('dashboard'))}
      >\u2726</div>
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
      <${ThemeToggle} />
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

  // Phase J: surface SSE disconnects + recoveries as toasts.
  //
  // Single 10 s timer covers both the page-load grace window and the
  // sustained-disconnect threshold. On mount `sseConnected` is `false`
  // because the EventSource hasn't opened yet, but a healthy server
  // sets `connected: true` within ~1 s — so the timer is started right
  // away and harmlessly cleared by the first successful connect. If
  // the server is down or the network is broken at page load, the
  // 10 s window expires and the toast surfaces. After a successful
  // first connect, any later disconnect path retains the same
  // semantics: 10 s of unrecovered disconnect → toast.
  //
  // Recovery toast is only emitted if a disconnect toast was actually
  // surfaced — silent flapping reconnects below the 10 s threshold
  // produce no notifications either way.
  const _sseDisconnectTimerRef = useRef(null);
  const _sseDisconnectShownRef = useRef(false);
  useEffect(() => {
    if (sseConnected) {
      if (_sseDisconnectTimerRef.current) {
        clearTimeout(_sseDisconnectTimerRef.current);
        _sseDisconnectTimerRef.current = null;
      }
      if (_sseDisconnectShownRef.current) {
        addToast('SSE 연결 복구됨', 'success');
        _sseDisconnectShownRef.current = false;
      }
    } else if (!_sseDisconnectTimerRef.current && !_sseDisconnectShownRef.current) {
      _sseDisconnectTimerRef.current = setTimeout(() => {
        addToast('SSE 연결 끊김 — 재시도 중...', 'error');
        _sseDisconnectShownRef.current = true;
        _sseDisconnectTimerRef.current = null;
      }, 10000);
    }
  }, [sseConnected]);

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
        // empty hash no longer defaults to dashboard here (Operator roster
        // is the default), but since we specifically gate on
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

  // Legacy hash redirect — map old top-level hashes to their new canonical
  // sub-route form so bookmarks / external links don't break.
  // Only the 5 exact legacy bases are redirected; no wildcard to avoid loops.
  useEffect(() => {
    const LEGACY_MAP = {
      'skills':            'resources/skills',
      'presets':           'resources/presets',
      'mcp-servers':       'resources/mcp-servers',
      'nodes':             'resources/nodes',
      'specialist':        'operator/specialist',
      'operator-profiles': 'operator/profiles',
    };
    const current = (window.location.hash.slice(1) || '').split('/');
    const base = current[0];
    if (base === 'projects') {
      const projectSuffix = current.length > 1 ? '/' + current.slice(1).join('/') : '';
      window.location.replace('#operator/codebases' + projectSuffix);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(LEGACY_MAP, base) && current.length === 1) {
      window.location.replace('#' + LEGACY_MAP[base]);
    }
  }, [route]);

  // R2-A.1: attention count = needs_input + failed across worker runs only.
  // v3 multi-layer note: is_manager=1 (Top + PM sessions) are excluded so
  // only worker runs contribute — aligns with DashboardView.workerRuns filter.
  const attentionCount = useMemo(() => (
    (runs || []).filter(r => !r.is_manager && (r.status === 'needs_input' || r.status === 'failed')).length
  ), [runs]);

  const renderView = () => {
    if (routeBase === 'manager') {
      const routeParts = route.split('/');
      const rawProjectId = routeParts[1] === 'operator' ? (routeParts.slice(2).join('/') || null) : null;
      let managerInitialTarget;
      if (rawProjectId) {
        let projectId = rawProjectId;
        try { projectId = decodeURIComponent(rawProjectId); } catch { projectId = rawProjectId; }
        managerInitialTarget = operatorConversationId(projectId);
      }
      return html`<${ManagerView} manager=${manager} runs=${runs} tasks=${tasks} projects=${projects} agents=${agents} agentsError=${agentsError} agentsLoading=${agentsLoading} reloadAgents=${reloadAgents} driftAudit=${driftAudit} onOpenDrift=${() => setShowDriftDrawer(true)} initialTarget=${managerInitialTarget} />`;
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
      return html`<${Loading} />`;
    }
    if (routeBase === 'agents') {
      return html`<${AgentsView} agents=${agents} loading=${agentsLoading} reloadAgents=${reloadAgents} />`;
    }
    if (routeBase === 'resources') {
      const routeParts = route.split('/');
      const sub = routeParts[1] || 'nodes';
      // Detail links encode node.id (encodeURIComponent), so the route part
      // must be decoded before DB-id comparison / re-encoding in apiFetch —
      // ids with space/%/slash would otherwise miss or double-encode
      // (Codex U-2 review S1). Malformed escapes fall back to the raw part.
      const rawDetailId = sub === 'nodes' ? (routeParts.slice(2).join('/') || null) : null;
      let nodeDetailId = rawDetailId;
      if (rawDetailId) {
        try { nodeDetailId = decodeURIComponent(rawDetailId); } catch { nodeDetailId = rawDetailId; }
      }
      return html`<${TabGroupView}
        groupHash="resources"
        subRoute=${sub}
        tabs=${[
          { key: 'nodes',       label: NAV_LABELS.nodes,           render: () => html`<${NodesView} detailId=${nodeDetailId} />` },
          { key: 'skills',      label: NAV_LABELS.skills,          render: () => html`<${SkillPacksView} projects=${projects} />` },
          { key: 'presets',     label: NAV_LABELS.presets,         render: () => html`<${PresetsView} />` },
          { key: 'mcp-servers', label: NAV_LABELS['mcp-servers'],  render: () => html`<${McpTemplatesView} />` },
          { key: 'models',      label: NAV_LABELS.models,          render: () => html`<${ModelPoliciesView} projects=${projects} />` },
        ]}
      />`;
    }
    if (routeBase === 'memory') {
      return html`<${MemoryView} projects=${projects} />`;
    }
    if (routeBase === 'operator') {
      const routeParts = route.split('/');
      const sub = routeParts[1] || 'roster';
      const rawProjectId = sub === 'codebases' ? (routeParts.slice(2).join('/') || null) : null;
      const rawSpecialistProfileId = sub === 'specialist' ? (routeParts.slice(2).join('/') || null) : null;
      let highlightProjectId = rawProjectId;
      if (rawProjectId) {
        try { highlightProjectId = decodeURIComponent(rawProjectId); } catch { highlightProjectId = rawProjectId; }
      }
      let initialSpecialistProfileId = rawSpecialistProfileId;
      if (rawSpecialistProfileId) {
        try { initialSpecialistProfileId = decodeURIComponent(rawSpecialistProfileId); } catch { initialSpecialistProfileId = rawSpecialistProfileId; }
      }
      return html`<${TabGroupView}
        groupHash="operator"
        subRoute=${sub}
        tabs=${[
          { key: 'roster',     label: NAV_LABELS['operator-roster'],     render: () => html`<${OperatorsView} runs=${runs} projects=${projects} tasks=${tasks} />` },
          { key: 'codebases',  label: NAV_LABELS['operator-codebases'],  render: () => projectsLoading ? html`<${Loading} />` : html`<${ProjectsView} projects=${projects} tasks=${tasks} runs=${runs} reloadProjects=${reloadProjects} onOpenRun=${(run) => setInspectRun(run)} onOpenTask=${(task) => setInspectTask(task)} highlightProjectId=${highlightProjectId} />` },
          { key: 'profiles',   label: NAV_LABELS['operator-profiles'],   render: () => html`<${OperatorProfilesView} />` },
          { key: 'specialist', label: NAV_LABELS.specialist,             render: () => html`<${SpecialistView} runs=${runs} initialProfileId=${initialSpecialistProfileId} />` },
        ]}
      />`;
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
