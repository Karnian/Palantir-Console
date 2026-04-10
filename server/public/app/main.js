// Palantir Console — module entry.
//
// Phase 4 (frontend ESM split) is being introduced incrementally. This file is
// the new ES-module entry point: it pulls Preact + hooks + htm via the vendor
// ESM bundles, exposes them on window globals (the same names app.js already
// uses — `preact`, `preactHooks`, `htm`), then loads the legacy app.js bundle
// as a classic script. The bridge lets us migrate helpers/hooks/components
// out of app.js into ES modules one at a time without rewriting the whole
// 3800-line file in a single commit.
//
// We deliberately use fully relative paths instead of an import map. The
// existing CSP (`script-src 'self'`) refuses any inline `<script>`, including
// `<script type="importmap">`, so an inline importmap would either need a
// hash entry per change or `'unsafe-inline'`. The bare `"preact"` specifier
// inside vendor/hooks.module.js was rewritten to a relative path for the
// same reason — see the patch comment in that file.

import * as preactNs from '../vendor/preact.module.js';
import * as preactHooksNs from '../vendor/hooks.module.js';
import htmFactory from '../vendor/htm.module.js';

import { formatDuration, formatTime, timeAgo } from './lib/format.js';
import { renderMarkdown, configureMarked } from './lib/markdown.js';
import { apiFetch } from './lib/api.js';
// NOTE: ./components/RunInspector.js dereferences window.preact / preactHooks
// / htm at module top level, so it MUST be imported AFTER those bridges are
// assigned below. The dynamic import below pushes RunInspector loading until
// after the window assignments — keep that order if you add more components.

// Re-expose the same globals app.js currently consumes. The shape mirrors
// the UMD bundles (window.preact, window.preactHooks, window.htm).
window.preact = preactNs;
window.preactHooks = preactHooksNs;
window.htm = htmFactory;

// Helpers extracted out of app.js into ES modules. We bridge them onto
// window so the legacy app.js (still a classic script) can keep using the
// same identifiers without changing every call site. As more of app.js
// migrates to ES modules, these bridges become straight imports.
window.formatDuration = formatDuration;
window.formatTime = formatTime;
window.timeAgo = timeAgo;
window.renderMarkdown = renderMarkdown;
window.apiFetch = apiFetch;

// Apply marked's global options once at boot. The CDN <script> for marked
// is `defer`, same as this module, and sits earlier in index.html, so by the
// time main.js runs `window.marked` is already loaded. configureMarked() is
// a no-op if it isn't, so timing failures degrade gracefully.
configureMarked();

// P8-1: dueDate helpers bridged for legacy app.js (TaskDetailPanel etc.)
import { dueState, formatDueDate, useNowTick, dueDateMeta } from './lib/dueDate.js';
window.dueState = dueState;
window.formatDueDate = formatDueDate;
window.useNowTick = useNowTick;
window.dueDateMeta = dueDateMeta;

// Modules extracted from app.js. Loaded via dynamic import so they resolve
// AFTER the window.preact / preactHooks / htm assignments above — these
// modules dereference those at module top level. Bridge each export onto
// window so the legacy app.js (which uses bare identifiers in htm templates
// and direct calls) can still reference them via global lookup.

const toast = await import('./lib/toast.js');
window.addToast = toast.addToast;
window.useToasts = toast.useToasts;
window.ToastContainer = toast.ToastContainer;
window.apiFetchWithToast = toast.apiFetchWithToast;

const hooks = await import('./lib/hooks.js');
window.useRoute = hooks.useRoute;
window.navigate = hooks.navigate;
window.useEscape = hooks.useEscape;
window.useSSE = hooks.useSSE;
window.useTasks = hooks.useTasks;
window.useRuns = hooks.useRuns;
window.useProjects = hooks.useProjects;
window.useClaudeSessions = hooks.useClaudeSessions;
window.useAgents = hooks.useAgents;
window.useManagerLifecycle = hooks.useManagerLifecycle;
window.useConversation = hooks.useConversation; // v3 Phase 1.5
window.useDispatchAudit = hooks.useDispatchAudit; // v3 Phase 7

const { RunInspector } = await import('./components/RunInspector.js');
window.RunInspector = RunInspector;

// P2-10 (ESM phase 1): DriftDrawer extracted from the legacy app.js
// monolith. Same window-bridge pattern as RunInspector — the legacy
// app.js references DriftDrawer as a bare global identifier inside
// its htm templates, so we assign the named export onto window here.
const { DriftDrawer } = await import('./components/DriftDrawer.js');
window.DriftDrawer = DriftDrawer;

// P3-2 (ESM phase 2): Dropdown + EmptyState extracted from app.js.
const { Dropdown } = await import('./components/Dropdown.js');
window.Dropdown = Dropdown;

const { EmptyState } = await import('./components/EmptyState.js');
window.EmptyState = EmptyState;

// P3-1 (ESM phase 2): MentionInput — @mention autocomplete textarea wrapper.
const { MentionInput } = await import('./components/MentionInput.js');
window.MentionInput = MentionInput;

// P4-3 (ESM phase 3): CommandPalette — Cmd+K navigation overlay.
const { CommandPalette } = await import('./components/CommandPalette.js');
window.CommandPalette = CommandPalette;

// P5-1 (ESM phase 4a): DashboardView — Attention Dashboard.
const { DashboardView } = await import('./components/DashboardView.js');
window.DashboardView = DashboardView;

// P5-2 (ESM phase 4a): BoardView + CalendarView + DirectoryPicker.
// CalendarView is exported for app.js to reference via window.CalendarView.
// DirectoryPicker is bridged for ProjectsView to use as a bare identifier.
const { BoardView, CalendarView, DirectoryPicker } = await import('./components/BoardView.js');
window.BoardView = BoardView;
window.CalendarView = CalendarView;
window.DirectoryPicker = DirectoryPicker;

// P5-3 (ESM phase 4b): ProjectsView — Projects management view.
// Also includes ProjectDetailModal (module-internal).
const { ProjectsView } = await import('./components/ProjectsView.js');
window.ProjectsView = ProjectsView;

// P5-4 (ESM phase 4b): AgentsView — Agent profiles management view.
// Also includes AgentModal + AgentDetailModal (module-internal).
const { AgentsView } = await import('./components/AgentsView.js');
window.AgentsView = AgentsView;

// P6-3 (ESM phase 5): SessionsView + initLegacySessions.
const { SessionsView } = await import('./components/SessionsView.js');
window.SessionsView = SessionsView;

// P6-1 (ESM phase 5a): ManagerView — Full-page manager chat + session grid.
// Also includes managerProfileAuthState (module-internal to ManagerView).
const { ManagerView } = await import('./components/ManagerView.js');
window.ManagerView = ManagerView;

// P7-4 (ESM phase 6): Notification utilities — requestNotificationPermission,
// showBrowserNotification, pulseTabTitle. Also registers the click/keydown
// permission-request side effect at module load time.
const notifications = await import('./lib/notifications.js');
window.requestNotificationPermission = notifications.requestNotificationPermission;
window.showBrowserNotification = notifications.showBrowserNotification;
window.pulseTabTitle = notifications.pulseTabTitle;

// P7-1 (ESM phase 6): TaskModals — NewTaskModal, ExecuteModal, TaskDetailPanel.
const { NewTaskModal, ExecuteModal, TaskDetailPanel } = await import('./components/TaskModals.js');
window.NewTaskModal = NewTaskModal;
window.ExecuteModal = ExecuteModal;
window.TaskDetailPanel = TaskDetailPanel;

// P8-2: app.js is now an ES module — import directly.
await import('../app.js');
