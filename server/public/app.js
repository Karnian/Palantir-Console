/* global preact, preactHooks, htm, formatDuration, formatTime, timeAgo, renderMarkdown, apiFetch */
// Helpers (formatDuration / formatTime / timeAgo / renderMarkdown / apiFetch)
// are provided by app/main.js, which imports them from app/lib/* and bridges
// them onto window before this script runs. See app/main.js for the wiring
// and the Phase 4 refactor notes there.
const { h, render } = preact;
const { useState, useEffect, useRef, useCallback, useMemo } = preactHooks;
const html = htm.bind(h);

// ─────────────────────────────────────────────────────────────────────────────
// Hash Router
// ─────────────────────────────────────────────────────────────────────────────

function useRoute() {
  const getHash = () => location.hash.slice(1) || 'dashboard';
  const [route, setRoute] = useState(getHash);
  useEffect(() => {
    const onHash = () => setRoute(getHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

function navigate(hash) {
  location.hash = hash;
}

// ─────────────────────────────────────────────────────────────────────────────
// Escape Key Hook — reusable for all modals
// ─────────────────────────────────────────────────────────────────────────────

function useEscape(open, onClose) {
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE Hook
// ─────────────────────────────────────────────────────────────────────────────

function useSSE(listeners) {
  const listenersRef = useRef(listeners);
  listenersRef.current = listeners;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let source;
    try {
      source = new EventSource('/api/events');
    } catch {
      return;
    }
    source.onopen = () => setConnected(true);
    const channels = [
      'task:created', 'task:updated', 'task:deleted',
      'run:created', 'run:status', 'run:completed', 'run:event',
      'manager:started', 'manager:stopped', 'run:output', 'run:result',
    ];
    channels.forEach((ch) => {
      source.addEventListener(ch, (e) => {
        try {
          const data = JSON.parse(e.data);
          const fn = listenersRef.current[ch];
          if (fn) fn(data);
        } catch { /* ignore parse errors */ }
      });
    });
    source.onerror = () => {
      setConnected(false);
      // EventSource auto-reconnects
    };
    return () => { source.close(); setConnected(false); };
  }, []);

  return { connected };
}

// ─────────────────────────────────────────────────────────────────────────────
// Data Hooks
// ─────────────────────────────────────────────────────────────────────────────

function useTasks() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch('/api/tasks');
      setTasks(data.tasks || []);
    } catch (err) { addToast('Failed to load tasks: ' + (err.message || 'unknown'), 'error'); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return { tasks, setTasks, loading, reload: load };
}

function useRuns() {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch('/api/runs');
      setRuns(data.runs || []);
    } catch (err) { addToast('Failed to load runs: ' + (err.message || 'unknown'), 'error'); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return { runs, setRuns, loading, reload: load };
}

function useProjects() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch('/api/projects');
      setProjects(data.projects || []);
    } catch (err) { addToast('Failed to load projects: ' + (err.message || 'unknown'), 'error'); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return { projects, setProjects, loading, reload: load };
}

function useClaudeSessions() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const data = await apiFetch('/api/claude-sessions');
      setSessions(data.sessions || []);
    } catch {
      setSessions([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
    const timer = setInterval(reload, 15000);
    return () => clearInterval(timer);
  }, [reload]);

  return { sessions, loading, reload };
}

function useAgents() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch('/api/agents');
      setAgents(data.agents || []);
    } catch (err) { addToast('Failed to load agents: ' + (err.message || 'unknown'), 'error'); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return { agents, loading, reload: load };
}

// ─────────────────────────────────────────────────────────────────────────────
// Manager Session Hook
// ─────────────────────────────────────────────────────────────────────────────

function useManager() {
  const [status, setStatus] = useState({ active: false, run: null, usage: null });
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const pollRef = useRef(null);

  const checkStatus = useCallback(async () => {
    try {
      const data = await apiFetch('/api/manager/status');
      setStatus(data);
      return data;
    } catch { return { active: false }; }
  }, []);

  const loadEvents = useCallback(async () => {
    try {
      const data = await apiFetch('/api/manager/events');
      setEvents(data.events || []);
    } catch { /* ignore */ }
  }, []);

  const start = useCallback(async (opts = {}) => {
    setLoading(true);
    try {
      const data = await apiFetch('/api/manager/start', {
        method: 'POST',
        body: JSON.stringify(opts),
      });
      setStatus({ active: true, run: data.run, usage: null });
      addToast('Manager session started', 'success');
      return data;
    } catch (err) {
      addToast('Failed to start manager: ' + err.message, 'error');
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const sendMessage = useCallback(async (text, images) => {
    try {
      const body = { text };
      if (images && images.length > 0) body.images = images;
      await apiFetch('/api/manager/message', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    } catch (err) {
      addToast('Failed to send message: ' + err.message, 'error');
      throw err;
    }
  }, []);

  const stop = useCallback(async () => {
    try {
      await apiFetch('/api/manager/stop', { method: 'POST' });
      setStatus({ active: false, run: null, usage: null });
      setEvents([]);
      addToast('Manager session stopped', 'info');
    } catch (err) {
      addToast('Failed to stop manager: ' + err.message, 'error');
    }
  }, []);

  // Poll for status and events when active
  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  useEffect(() => {
    if (!status.active) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    // Poll events every 2s when active
    loadEvents();
    pollRef.current = setInterval(() => {
      checkStatus();
      loadEvents();
    }, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [status.active, checkStatus, loadEvents]);

  return { status, events, loading, start, sendMessage, stop, checkStatus };
}

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

function EmptyState({ icon, text, sub }) {
  return html`
    <div class="empty-state">
      <div class="empty-state-icon">${icon}</div>
      <div class="empty-state-text">${text}</div>
      ${sub && html`<div class="empty-state-sub">${sub}</div>`}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard View
// ─────────────────────────────────────────────────────────────────────────────

function DashboardView({ tasks, runs, onOpenRun, onDeleteRun, claudeSessions }) {
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

  // Build triage items sorted by urgency
  const triageItems = [];

  const runTitle = (run, task) => {
    if (run.is_manager) return 'Manager Session';
    return task?.title || `Run ${run.id.slice(0, 8)}`;
  };

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
            key=${item.run?.id || item.task?.id || i}
            class="triage-item"
            onClick=${() => item.run && onOpenRun(item.run)}
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
                <button class="ghost" onClick=${(e) => { e.stopPropagation(); navigate('board'); }}>
                  Review
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

// ─────────────────────────────────────────────────────────────────────────────
// New Task Modal
// ─────────────────────────────────────────────────────────────────────────────

function NewTaskModal({ open, onClose, projects, agents, onCreated }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [projectId, setProjectId] = useState('');
  const [priority, setPriority] = useState('medium');
  const [agentProfileId, setAgentProfileId] = useState('');
  const [saving, setSaving] = useState(false);
  useEscape(open, onClose);

  // Reset form state when modal opens
  useEffect(() => {
    if (open) {
      setTitle(''); setDescription(''); setProjectId('');
      setPriority('medium'); setAgentProfileId('');
    }
  }, [open]);

  if (!open) return null;

  const handleSubmit = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      const body = {
        title: title.trim(),
        description: description.trim() || undefined,
        project_id: projectId || undefined,
        priority,
        agent_profile_id: agentProfileId || undefined,
      };
      const data = await apiFetch('/api/tasks', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      onCreated(data.task);
      setTitle(''); setDescription(''); setProjectId(''); setPriority('medium'); setAgentProfileId('');
      onClose();
    } catch (err) {
      addToast(err.message, 'error');
    }
    setSaving(false);
  };

  return html`
    <div class="modal-overlay">
      <div class="modal-backdrop" onClick=${onClose}></div>
      <div class="modal-panel">
        <div class="modal-header">
          <h2 class="modal-title">New Task</h2>
          <button class="ghost" onClick=${onClose}>Close</button>
        </div>
        <div class="modal-body">
          <div class="form-field">
            <label class="form-label">Title</label>
            <input class="form-input" value=${title} onInput=${e => setTitle(e.target.value)} placeholder="Task title" />
          </div>
          <div class="form-field">
            <label class="form-label">Description</label>
            <textarea class="form-textarea" value=${description} onInput=${e => setDescription(e.target.value)} placeholder="Optional description" rows="3"></textarea>
          </div>
          <div class="form-field">
            <label class="form-label">Project</label>
            <select class="form-select" value=${projectId} onChange=${e => setProjectId(e.target.value)}>
              <option value="">None</option>
              ${projects.map(p => html`<option key=${p.id} value=${p.id}>${p.name}</option>`)}
            </select>
          </div>
          <div class="form-field">
            <label class="form-label">Priority</label>
            <select class="form-select" value=${priority} onChange=${e => setPriority(e.target.value)}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </div>
          <div class="form-field">
            <label class="form-label">Agent Profile</label>
            <select class="form-select" value=${agentProfileId} onChange=${e => setAgentProfileId(e.target.value)}>
              <option value="">None</option>
              ${agents.map(a => html`<option key=${a.id} value=${a.id}>${a.name}</option>`)}
            </select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="ghost" onClick=${onClose}>Cancel</button>
          <button class="primary" onClick=${handleSubmit} disabled=${saving || !title.trim()}>
            ${saving ? 'Creating...' : 'Create Task'}
          </button>
        </div>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Execution Modal (drag to In Progress)
// ─────────────────────────────────────────────────────────────────────────────

function ExecuteModal({ open, task, agents, onClose, onExecute }) {
  const [agentProfileId, setAgentProfileId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [executing, setExecuting] = useState(false);
  useEscape(open, onClose);

  useEffect(() => {
    if (open && task) {
      setPrompt(task.description || '');
      setAgentProfileId(task.agent_profile_id || agents[0]?.id || '');
    }
  }, [open, task]);

  if (!open || !task) return null;

  const handleExecute = async () => {
    setExecuting(true);
    try {
      await onExecute(task.id, agentProfileId, prompt);
      onClose();
    } catch (err) {
      addToast(err.message, 'error');
    }
    setExecuting(false);
  };

  return html`
    <div class="modal-overlay">
      <div class="modal-backdrop" onClick=${onClose}></div>
      <div class="modal-panel">
        <div class="modal-header">
          <h2 class="modal-title">Execute Task: ${task.title}</h2>
          <button class="ghost" onClick=${onClose}>Close</button>
        </div>
        <div class="modal-body">
          <div class="form-field">
            <label class="form-label">Agent Profile</label>
            <select class="form-select" value=${agentProfileId} onChange=${e => setAgentProfileId(e.target.value)}>
              <option value="" disabled>Select Agent...</option>
              ${agents.map(a => html`<option key=${a.id} value=${a.id}>${a.name}</option>`)}
            </select>
          </div>
          <div class="form-field">
            <label class="form-label">Prompt / Instructions</label>
            <textarea class="form-textarea" value=${prompt} onInput=${e => setPrompt(e.target.value)} rows="4" placeholder="Instructions for the agent..."></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="ghost" onClick=${onClose}>Cancel</button>
          <button class="primary" onClick=${handleExecute} disabled=${executing || !agentProfileId}>
            ${executing ? 'Starting...' : 'Start Agent'}
          </button>
        </div>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Task Detail Panel
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_OPTIONS = ['backlog', 'todo', 'in_progress', 'review', 'done', 'failed'];
const PRIORITY_OPTIONS = ['low', 'medium', 'high', 'critical'];

function TaskDetailPanel({ task, onClose, projects, agents, runs, onOpenRun, onExecute, reloadTasks }) {
  const [title, setTitle] = useState(task?.title || '');
  const [description, setDescription] = useState(task?.description || '');
  const [status, setStatus] = useState(task?.status || 'backlog');
  const [priority, setPriority] = useState(task?.priority || 'medium');
  const [projectId, setProjectId] = useState(task?.project_id || '');
  // Single editing field state — 'title' | 'description' | null
  const [editingField, setEditingField] = useState(null);
  const [showExecute, setShowExecute] = useState(false);
  // Track pointerdown coords to distinguish click-to-edit vs drag-to-select
  const pointerDownRef = useRef(null);
  // Capture readonly description's rendered height so the textarea matches it
  // (prevents the popup from shrinking when entering edit mode on long content)
  const descReadonlyRef = useRef(null);
  const descEditHeightRef = useRef(null);
  const titleReadonlyRef = useRef(null);
  const titleEditHeightRef = useRef(null);

  useEscape(!!task && editingField === null, onClose);

  // Sync form state when task changes
  useEffect(() => {
    if (task) {
      setTitle(task.title || '');
      setDescription(task.description || '');
      setStatus(task.status || 'backlog');
      setPriority(task.priority || 'medium');
      setProjectId(task.project_id || '');
      setEditingField(null);
    }
  }, [task?.id, task?.updated_at]);

  if (!task) return null;

  const taskRuns = runs.filter(r => r.task_id === task.id)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const project = projects.find(p => p.id === task.project_id);
  const activeRun = taskRuns.find(r => r.status === 'running' || r.status === 'needs_input');

  // Save a single field via PATCH (used by inline click-to-edit)
  const saveField = async (field, value) => {
    try {
      await apiFetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ [field]: value }),
      });
      reloadTasks();
    } catch (err) {
      addToast(err.message, 'error');
    }
  };

  const commitField = (field) => {
    if (field === 'title') {
      const next = title.trim();
      setEditingField(null);
      if (!next) { setTitle(task.title || ''); return; }
      if (next !== (task.title || '')) saveField('title', next);
    } else if (field === 'description') {
      const next = description.trim();
      const prev = task.description || '';
      setEditingField(null);
      if (next !== prev) saveField('description', next || null);
    }
  };

  const cancelField = (field) => {
    if (field === 'title') setTitle(task.title || '');
    if (field === 'description') setDescription(task.description || '');
    setEditingField(null);
  };

  // Pointerdown coordinate tracking — used to detect drag-select vs click
  const handleEditablePointerDown = (e) => {
    pointerDownRef.current = { x: e.clientX, y: e.clientY };
  };
  const handleEditablePointerEnd = () => {
    // Clear after pointer interaction completes so the next click (especially
    // a keyboard-triggered click) doesn't compare against stale coordinates
    pointerDownRef.current = null;
  };

  const beginEdit = (field) => (e) => {
    // Keyboard-activated clicks (Enter/Space on a focused button) report
    // detail === 0; skip the drag-distance check for them entirely
    const isKeyboard = e.detail === 0;
    if (!isKeyboard) {
      const start = pointerDownRef.current;
      const moved = start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4;
      if (moved) { pointerDownRef.current = null; return; }
      const sel = window.getSelection && window.getSelection();
      if (sel && !sel.isCollapsed && String(sel).trim().length > 0) {
        pointerDownRef.current = null;
        return;
      }
    }
    pointerDownRef.current = null;
    // Capture current rendered height so the input/textarea preserves it
    // (use getBoundingClientRect to avoid integer rounding jumps)
    if (field === 'title' && titleReadonlyRef.current) {
      titleEditHeightRef.current = Math.round(titleReadonlyRef.current.getBoundingClientRect().height);
    }
    if (field === 'description' && descReadonlyRef.current) {
      descEditHeightRef.current = Math.round(descReadonlyRef.current.getBoundingClientRect().height);
    }
    setEditingField(field);
  };

  const handleDelete = async () => {
    if (!confirm('Delete this task? This cannot be undone.')) return;
    try {
      await apiFetch(`/api/tasks/${task.id}`, { method: 'DELETE' });
      addToast('Task deleted', 'success');
      reloadTasks();
      onClose();
    } catch (err) {
      addToast(err.message, 'error');
    }
  };

  const handleExecuteDone = async (taskId, agentProfileId, prompt) => {
    const prevStatus = task.status;
    // Move to in_progress (ignore error if already in that state)
    try {
      await apiFetch(`/api/tasks/${taskId}/status`, {
        method: 'PATCH', body: JSON.stringify({ status: 'in_progress' }),
      });
    } catch (statusErr) {
      // If task is already in_progress, continue with execution
      if (!statusErr.message?.includes('in_progress')) throw statusErr;
    }
    let newRun;
    try {
      const data = await apiFetch(`/api/tasks/${taskId}/execute`, {
        method: 'POST', body: JSON.stringify({ agent_profile_id: agentProfileId, prompt: prompt || undefined }),
      });
      newRun = data.run;
    } catch (err) {
      // Rollback status on execution failure
      await apiFetch(`/api/tasks/${taskId}/status`, {
        method: 'PATCH', body: JSON.stringify({ status: prevStatus }),
      }).catch(() => {});
      reloadTasks();
      throw err;
    }
    reloadTasks();
    // Open RunInspector immediately after execution
    if (newRun) {
      onOpenRun(newRun);
      onClose();
    }
  };

  const statusColor = {
    backlog: 'var(--status-queued)', todo: 'var(--info)', in_progress: 'var(--accent)',
    review: 'var(--status-review)', done: 'var(--success)', failed: 'var(--status-failed)',
  };

  return html`
    <div class="modal-overlay">
      <div class="modal-backdrop" onClick=${onClose}></div>
      <div class="modal-panel wide task-detail-panel">
        <div class="modal-header">
          <h2 class="modal-title" style="display:flex;align-items:center;gap:8px;">
            <span class="task-detail-status-dot" style="background:${statusColor[task.status] || 'var(--text-muted)'};width:8px;height:8px;border-radius:50%;display:inline-block;"></span>
            Task Detail
          </h2>
          <div style="display:flex;gap:6px;">
            <button class="ghost" onClick=${onClose}>\u2715</button>
          </div>
        </div>

        <div class="modal-body" style="gap:16px;">
          ${html`
            <div class=${`task-detail-inline-root ${editingField ? 'is-inline-editing' : ''}`}>
              ${editingField === 'title' ? html`
                <input class="task-detail-title-input" value=${title} autoFocus
                  style=${titleEditHeightRef.current ? `height:${titleEditHeightRef.current}px;` : ''}
                  onInput=${e => setTitle(e.target.value)}
                  onBlur=${() => commitField('title')}
                  onKeyDown=${e => {
                    // IME composition guard (한글 조합 중 Enter/Escape 무시)
                    if (e.isComposing || e.keyCode === 229) return;
                    if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
                    if (e.key === 'Escape') { e.preventDefault(); cancelField('title'); }
                  }} />
              ` : html`
                <button type="button" ref=${titleReadonlyRef}
                  class="task-detail-title editable editable-reset"
                  aria-label="Edit title"
                  onPointerDown=${handleEditablePointerDown}
                  onPointerUp=${handleEditablePointerEnd}
                  onPointerCancel=${handleEditablePointerEnd}
                  onClick=${beginEdit('title')}>${task.title}</button>
              `}
              ${editingField === 'description' ? html`
                <textarea class="task-detail-desc-input" value=${description} autoFocus
                  style=${descEditHeightRef.current ? `height:${descEditHeightRef.current}px;` : ''}
                  placeholder="Add a description..."
                  onInput=${e => setDescription(e.target.value)}
                  onBlur=${() => commitField('description')}
                  onKeyDown=${e => {
                    if (e.isComposing || e.keyCode === 229) return;
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.currentTarget.blur(); }
                    if (e.key === 'Escape') { e.preventDefault(); cancelField('description'); }
                  }}></textarea>
              ` : html`
                <button type="button" ref=${descReadonlyRef}
                  class=${`task-detail-desc editable editable-reset ${task.description ? '' : 'placeholder'}`}
                  aria-label="Edit description"
                  onPointerDown=${handleEditablePointerDown}
                  onPointerUp=${handleEditablePointerEnd}
                  onPointerCancel=${handleEditablePointerEnd}
                  onClick=${beginEdit('description')}>${task.description || 'Add a description...'}</button>
              `}
            </div>
            <div class="task-detail-meta-grid">
              ${(() => {
                const sc = statusColor[status] || 'var(--text-muted)';
                const priorityColors = { low: '#6b7280', medium: '#3b82f6', high: '#f59e0b', critical: '#ef4444' };
                const pc = priorityColors[priority] || '#6b7280';
                return html`
                  <div class="task-detail-meta-item">
                    <span class="task-detail-meta-label">Status</span>
                    <select class="form-select inline-select" value=${status}
                      style="color:${sc};background:color-mix(in srgb, ${sc} 12%, transparent);border-color:color-mix(in srgb, ${sc} 30%, transparent);"
                      onChange=${async (e) => {
                        const v = e.target.value; setStatus(v);
                        try { await apiFetch('/api/tasks/' + task.id + '/status', { method: 'PATCH', body: JSON.stringify({ status: v }) }); reloadTasks(); }
                        catch (err) { addToast(err.message, 'error'); }
                      }}>
                      ${['backlog','todo','in_progress','review','done','failed'].map(s => html`<option key=${s} value=${s}>${s.replace('_',' ')}</option>`)}
                    </select>
                  </div>
                  <div class="task-detail-meta-item">
                    <span class="task-detail-meta-label">Priority</span>
                    <select class="form-select inline-select" value=${priority}
                      style="color:${pc};background:color-mix(in srgb, ${pc} 12%, transparent);border-color:color-mix(in srgb, ${pc} 30%, transparent);"
                      onChange=${async (e) => {
                        const v = e.target.value; setPriority(v);
                        try { await apiFetch('/api/tasks/' + task.id, { method: 'PATCH', body: JSON.stringify({ priority: v }) }); reloadTasks(); }
                        catch (err) { addToast(err.message, 'error'); }
                      }}>
                      ${PRIORITY_OPTIONS.map(p => html`<option key=${p} value=${p}>${p}</option>`)}
                    </select>
                  </div>
                  <div class="task-detail-meta-item">
                    <span class="task-detail-meta-label">Project</span>
                    <select class="form-select inline-select" value=${projectId}
                      style="color:var(--accent-light);background:rgba(139,92,246,0.08);border-color:rgba(139,92,246,0.25);"
                      onChange=${async (e) => {
                        const v = e.target.value; setProjectId(v);
                        try { await apiFetch('/api/tasks/' + task.id, { method: 'PATCH', body: JSON.stringify({ project_id: v || null }) }); reloadTasks(); }
                        catch (err) { addToast(err.message, 'error'); }
                      }}>
                      <option value="">None</option>
                      ${projects.map(p => html`<option key=${p.id} value=${p.id}>${p.name}</option>`)}
                    </select>
                  </div>
                `;
              })()}
              <div class="task-detail-meta-item">
                <span class="task-detail-meta-label">Created</span>
                <span style="color:var(--text-secondary);font-size:12px;">${formatTime(task.created_at)}</span>
              </div>
            </div>
          `}

          ${taskRuns.length > 0 && html`
            <div class="task-detail-runs">
              <div class="task-detail-section-title">Runs (${taskRuns.length})</div>
              <div class="task-detail-runs-list">
                ${taskRuns.slice(0, 5).map(r => html`
                  <div key=${r.id} class="task-detail-run-item" onClick=${() => { onOpenRun(r); onClose(); }}>
                    <span class="run-status-dot ${r.status}"></span>
                    <span style="flex:1;min-width:0;">
                      <span style="color:var(--text-primary);font-size:13px;">${r.agent_name || 'Agent'}</span>
                      <span style="color:var(--text-muted);font-size:11px;margin-left:6px;">${r.status}</span>
                    </span>
                    <span style="color:var(--text-muted);font-size:11px;">${timeAgo(r.created_at)}</span>
                  </div>
                `)}
              </div>
            </div>
          `}
        </div>

        <div class="modal-footer" style="justify-content:space-between;">
          <div style="display:flex;gap:6px;">
            ${activeRun ? html`
              <button class="primary" onClick=${() => { onOpenRun(activeRun); onClose(); }}>View Run</button>
            ` : html`
              <button class="primary" onClick=${() => setShowExecute(true)}>${'\u25B6'} Run Agent</button>
            `}
          </div>
          <button class="ghost danger" onClick=${handleDelete}>Delete</button>
        </div>
      </div>
    </div>
    ${showExecute && !activeRun && html`
      <${ExecuteModal}
        open=${true}
        task=${task}
        agents=${agents}
        onClose=${() => setShowExecute(false)}
        onExecute=${handleExecuteDone}
      />
    `}
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Run Inspector Modal
// ─────────────────────────────────────────────────────────────────────────────

// RunInspector lives in app/components/RunInspector.js — main.js imports it
// and bridges it onto window.RunInspector before app.js loads. The htm
// templates below reference it as a bare identifier (e.g. `<${RunInspector}>`),
// which resolves via the script-global lookup down to the window property.

// ─────────────────────────────────────────────────────────────────────────────
// Kanban Board View
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

  return html`
    <div
      class="task-card"
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
      </div>
      ${task.updated_at && html`
        <div class="task-card-meta">${timeAgo(task.updated_at || task.created_at)}</div>
      `}
    </div>
  `;
}

function BoardView({ tasks, setTasks, projects, agents, runs, onOpenRun, reloadTasks }) {
  const [showNewTask, setShowNewTask] = useState(false);
  const [executeTask, setExecuteTask] = useState(null);
  const [detailTask, setDetailTask] = useState(null);
  const [filterProject, setFilterProject] = useState('');
  const [filterPriority, setFilterPriority] = useState('');
  const [dragTarget, setDragTarget] = useState(null);

  // Listen for 'N' key shortcut to open new task modal
  useEffect(() => {
    const handler = () => setShowNewTask(true);
    window.addEventListener('palantir:new-task', handler);
    return () => window.removeEventListener('palantir:new-task', handler);
  }, []);

  const filtered = useMemo(() => {
    return tasks.filter(t => {
      if (filterProject && t.project_id !== filterProject) return false;
      if (filterPriority && t.priority !== filterPriority) return false;
      return true;
    });
  }, [tasks, filterProject, filterPriority]);

  const columnTasks = useMemo(() => {
    const map = {};
    BOARD_COLUMNS.forEach(c => { map[c.id] = []; });
    filtered.forEach(t => {
      const col = map[t.status] ? t.status : 'backlog';
      map[col].push(t);
    });
    // Sort by sort_order within each column
    Object.values(map).forEach(arr => arr.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)));
    return map;
  }, [filtered]);

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

  const handleExecute = async (taskId, agentProfileId, prompt) => {
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
        body: JSON.stringify({ agent_profile_id: agentProfileId, prompt: prompt || undefined }),
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
        <h1 class="board-toolbar-title">Task Board</h1>
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
// Directory Picker (Preact component — reuses existing directory-* CSS classes)
// ─────────────────────────────────────────────────────────────────────────────

function DirectoryPicker({ value, onSelect }) {
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

// Projects View
// ─────────────────────────────────────────────────────────────────────────────

function ProjectDetailModal({ project, tasks, runs, onClose, onOpenRun }) {
  useEscape(!!project, onClose);
  if (!project) return null;

  const projectTasks = tasks.filter(t => t.project_id === project.id);
  const projectRuns = runs.filter(r => projectTasks.some(t => t.id === r.task_id));

  const statusColor = {
    backlog: 'var(--status-queued)', todo: 'var(--info)', in_progress: 'var(--accent)',
    review: 'var(--status-review)', done: 'var(--success)', failed: 'var(--status-failed)',
  };

  // Group tasks by status
  const statusGroups = useMemo(() => {
    const groups = {};
    BOARD_COLUMNS.forEach(col => { groups[col.id] = []; });
    projectTasks.forEach(t => {
      const col = groups[t.status] ? t.status : 'backlog';
      groups[col].push(t);
    });
    return groups;
  }, [projectTasks]);

  const activeGroups = BOARD_COLUMNS.filter(col => (statusGroups[col.id] || []).length > 0);

  // Stats
  const activeTasks = projectTasks.filter(t => t.status === 'in_progress').length;
  const doneTasks = projectTasks.filter(t => t.status === 'done').length;
  const activeRuns = projectRuns.filter(r => r.status === 'running').length;

  return html`
    <div class="modal-overlay">
      <div class="modal-backdrop" onClick=${onClose}></div>
      <div class="modal-panel wide project-detail-panel">
        <div class="modal-header">
          <h2 class="modal-title" style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:16px;">\u25A3</span>
            Project Detail
          </h2>
          <button class="ghost" onClick=${onClose}>\u2715</button>
        </div>

        <div class="modal-body" style="gap:16px;">
          <div>
            <div class="task-detail-title">${project.name}</div>
            ${project.description && html`<div class="task-detail-desc">${project.description}</div>`}
          </div>

          <div class="task-detail-meta-grid">
            ${project.directory && html`
              <div class="task-detail-meta-item">
                <span class="task-detail-meta-label">Directory</span>
                <span style="color:var(--text-secondary);font-size:12px;word-break:break-all;" title=${project.directory}>${project.directory}</span>
              </div>
            `}
            <div class="task-detail-meta-item">
              <span class="task-detail-meta-label">Tasks</span>
              <span style="color:var(--text-secondary);font-size:12px;">${projectTasks.length} total</span>
            </div>
            <div class="task-detail-meta-item">
              <span class="task-detail-meta-label">Active / Done</span>
              <span style="color:var(--text-secondary);font-size:12px;">${activeTasks} / ${doneTasks}</span>
            </div>
            <div class="task-detail-meta-item">
              <span class="task-detail-meta-label">Runs</span>
              <span style="color:var(--text-secondary);font-size:12px;">${projectRuns.length} total${activeRuns > 0 ? ` (${activeRuns} running)` : ''}</span>
            </div>
            <div class="task-detail-meta-item">
              <span class="task-detail-meta-label">Created</span>
              <span style="color:var(--text-secondary);font-size:12px;">${formatTime(project.created_at)}</span>
            </div>
          </div>

          <div class="project-detail-tasks">
            <div class="task-detail-section-title">Tasks (${projectTasks.length})</div>
            ${projectTasks.length === 0 && html`
              <div style="color:var(--text-muted);font-size:13px;padding:12px 0;">No tasks assigned to this project.</div>
            `}
            ${activeGroups.map(col => {
              const groupTasks = statusGroups[col.id];
              const sc = statusColor[col.id] || 'var(--text-muted)';
              return html`
                <div key=${col.id} class="project-task-group">
                  <div class="project-task-group-header">
                    <span class="project-task-status-dot" style="background:${sc};"></span>
                    <span class="project-task-status-label" style="color:${sc};">${col.label.toUpperCase()}</span>
                    <span class="project-task-status-count">${groupTasks.length}</span>
                  </div>
                  <div class="project-task-group-list">
                    ${groupTasks.map(t => {
                      const taskRuns = runs.filter(r => r.task_id === t.id);
                      const runCount = taskRuns.length;
                      return html`
                        <div key=${t.id} class="project-task-item">
                          <span class="project-task-item-title">${t.title}</span>
                          <span class="project-task-item-right">
                            ${runCount > 0 && html`<span class="project-task-run-count">${runCount} run${runCount !== 1 ? 's' : ''}</span>`}
                            ${taskRuns.length > 0 && html`
                              <button class="ghost project-task-detail-btn" onClick=${() => {
                                const latestRun = taskRuns.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
                                onOpenRun(latestRun);
                                onClose();
                              }}>Detail</button>
                            `}
                          </span>
                        </div>
                      `;
                    })}
                  </div>
                </div>
              `;
            })}
          </div>
        </div>
      </div>
    </div>
  `;
}

function ProjectsView({ projects, tasks, runs, reloadProjects, onOpenRun }) {
  const [showNew, setShowNew] = useState(false);
  const [detailProject, setDetailProject] = useState(null);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [dir, setDir] = useState('');
  const [saving, setSaving] = useState(false);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await apiFetch('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), description: desc.trim() || undefined, directory: dir.trim() || undefined }),
      });
      setName(''); setDesc(''); setDir(''); setShowNew(false);
      reloadProjects();
    } catch (err) {
      addToast(err.message, 'error');
    }
    setSaving(false);
  };

  // Keep detailProject in sync with latest data
  const currentDetailProject = detailProject ? projects.find(p => p.id === detailProject.id) || detailProject : null;

  return html`
    <div class="projects-view">
      <div class="projects-header">
        <h1 class="projects-title">Projects</h1>
        <button class="primary" onClick=${() => setShowNew(true)}>+ New Project</button>
      </div>
      <div class="projects-list">
        ${projects.length === 0 && html`
          <${EmptyState}
            icon="\u25A3"
            text="No projects yet."
            sub="Create a project to organize your tasks."
          />
        `}
        ${projects.map(p => {
          const taskCount = tasks.filter(t => t.project_id === p.id).length;
          return html`
            <div key=${p.id} class="project-card clickable" onClick=${() => setDetailProject(p)}>
              <div class="project-card-header">
                <div class="project-card-title">${p.name}</div>
                ${taskCount > 0 && html`<span class="project-card-task-count">${taskCount} task${taskCount !== 1 ? 's' : ''}</span>`}
              </div>
              ${p.directory && html`<div class="project-card-dir" title=${p.directory}>\u{1F4C1} ${p.directory}</div>`}
              ${p.description && html`<div class="project-card-desc">${p.description}</div>`}
              <div class="project-card-meta">Created ${formatTime(p.created_at)}</div>
            </div>
          `;
        })}
      </div>
      ${showNew && html`
        <div class="modal-overlay">
          <div class="modal-backdrop" onClick=${() => setShowNew(false)}></div>
          <div class="modal-panel">
            <div class="modal-header">
              <h2 class="modal-title">New Project</h2>
              <button class="ghost" onClick=${() => setShowNew(false)}>Close</button>
            </div>
            <div class="modal-body">
              <div class="form-field">
                <label class="form-label">Name</label>
                <input class="form-input" value=${name} onInput=${e => setName(e.target.value)} placeholder="Project name" />
              </div>
              <${DirectoryPicker} value=${dir} onSelect=${setDir} />
              <div class="form-field">
                <label class="form-label">Description</label>
                <textarea class="form-textarea" value=${desc} onInput=${e => setDesc(e.target.value)} placeholder="Optional" rows="3"></textarea>
              </div>
            </div>
            <div class="modal-footer">
              <button class="ghost" onClick=${() => setShowNew(false)}>Cancel</button>
              <button class="primary" onClick=${handleCreate} disabled=${saving || !name.trim()}>
                ${saving ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      `}
      ${currentDetailProject && html`
        <${ProjectDetailModal}
          project=${currentDetailProject}
          tasks=${tasks}
          runs=${runs}
          onClose=${() => setDetailProject(null)}
          onOpenRun=${onOpenRun}
        />
      `}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sessions View — wraps the original vanilla JS logic
// ─────────────────────────────────────────────────────────────────────────────

function SessionsView() {
  const containerRef = useRef(null);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (initializedRef.current || !containerRef.current) return;
    initializedRef.current = true;
    const cleanup = initLegacySessions(containerRef.current);
    return () => {
      if (typeof cleanup === 'function') cleanup();
      initializedRef.current = false;
    };
  }, []);

  return html`
    <div class="sessions-layout" ref=${containerRef}>
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-title">Palantir Console</div>
          <div class="brand-subtitle">Seeing Stones for AI Sessions</div>
        </div>
        <div class="session-header">
          <span>Sessions</span>
          <div class="session-actions">
            <button class="ghost" data-action="new">New</button>
            <button class="ghost" data-action="refresh">Refresh</button>
          </div>
        </div>
        <div class="session-search">
          <input type="search" placeholder="Filter by title, slug, or directory" data-role="search" />
        </div>
        <div class="session-list" data-role="session-list"></div>
      </aside>
      <main class="content">
        <header class="session-title" data-role="session-title">
          <div class="title-row">
            <div class="title">Select a session</div>
            <div class="session-controls">
              <button class="ghost" data-action="usage">Usage</button>
              <button class="ghost" data-action="trash">Trash</button>
              <button class="ghost" data-action="rename" disabled>Rename</button>
              <button class="ghost danger" data-action="delete" disabled>Delete</button>
            </div>
          </div>
          <div class="meta" data-role="session-meta"></div>
        </header>
        <div class="trash-modal" data-role="trash-modal" hidden>
          <div class="trash-backdrop" data-action="trash-close"></div>
          <div class="trash-panel" role="dialog">
            <div class="trash-header">
              <h2 class="trash-title">Trashed Sessions</h2>
              <button class="ghost" data-action="trash-close">Close</button>
            </div>
            <div class="trash-list" data-role="trash-list">
              <div class="trash-empty">No trashed sessions.</div>
            </div>
          </div>
        </div>
        <div class="trash-modal" data-role="usage-modal" hidden>
          <div class="trash-backdrop" data-action="usage-close"></div>
          <div class="trash-panel" role="dialog">
            <div class="trash-header">
              <h2 class="trash-title">Codex Status</h2>
              <div class="usage-actions">
                <button class="ghost" data-action="usage-refresh">Refresh</button>
                <button class="ghost" data-action="usage-close">Close</button>
              </div>
            </div>
            <div class="usage-output" data-role="usage-output">Loading...</div>
          </div>
        </div>
        <div class="trash-modal" data-role="child-modal" hidden>
          <div class="trash-backdrop" data-action="child-close"></div>
          <div class="trash-panel child-panel" role="dialog">
            <div class="trash-header">
              <h2 class="trash-title">Agent Activity</h2>
              <button class="ghost" data-action="child-close">Close</button>
            </div>
            <div class="child-session-body" data-role="child-body">Loading...</div>
          </div>
        </div>
        <div class="directory-modal" data-role="dir-modal" hidden>
          <div class="directory-backdrop" data-action="dir-cancel"></div>
          <div class="directory-panel" role="dialog">
            <div class="directory-header">
              <h2 class="directory-title">Select Directory</h2>
              <button class="ghost" data-action="dir-up">Up</button>
            </div>
            <div class="directory-path" data-role="dir-path">/</div>
            <div class="directory-toggle">
              <label class="directory-toggle-label">
                <input type="checkbox" data-action="dir-hidden" />
                <span>Show hidden folders</span>
              </label>
            </div>
            <div class="directory-list" data-role="dir-list" role="list"></div>
            <div class="directory-actions">
              <button class="primary" data-action="dir-select">Use this folder</button>
              <button class="ghost" data-action="dir-cancel">Cancel</button>
            </div>
          </div>
        </div>
        <section class="conversation" data-role="conversation">
          <div class="message-controls" data-role="load-more-wrap" hidden>
            <button class="ghost load-more" data-action="load-more">Load more</button>
          </div>
          <div class="message-list" data-role="message-list"></div>
        </section>
        <footer class="composer">
          <form data-role="send-form">
            <textarea data-role="message-input" placeholder="Send a message to the selected session..." rows="3" required></textarea>
            <div class="composer-actions">
              <span class="status" data-role="send-status"></span>
              <button type="submit" class="primary">Send</button>
            </div>
          </form>
        </footer>
      </main>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy session logic — ported as-is but scoped to a container
// ─────────────────────────────────────────────────────────────────────────────

function initLegacySessions(root) {
  const $ = (sel) => root.querySelector(sel);
  const sessionList = $('[data-role="session-list"]');
  const sessionTitleEl = $('[data-role="session-title"]');
  const sessionMeta = $('[data-role="session-meta"]');
  const messageList = $('[data-role="message-list"]');
  const conversation = $('[data-role="conversation"]');
  const loadMoreWrap = $('[data-role="load-more-wrap"]');
  const loadMoreBtn = $('[data-action="load-more"]');
  const sendForm = $('[data-role="send-form"]');
  const messageInput = $('[data-role="message-input"]');
  const sendStatus = $('[data-role="send-status"]');
  const sessionSearch = $('[data-role="search"]');
  const newSessionBtn = $('[data-action="new"]');
  const refreshBtn = $('[data-action="refresh"]');
  const renameSessionBtn = $('[data-action="rename"]');
  const deleteSessionBtn = $('[data-action="delete"]');
  const usageToggleBtn = $('[data-action="usage"]');
  const trashToggleBtn = $('[data-action="trash"]');
  const usageModal = $('[data-role="usage-modal"]');
  const usageOutput = $('[data-role="usage-output"]');
  const trashModal = $('[data-role="trash-modal"]');
  const trashList = $('[data-role="trash-list"]');
  const childSessionModal = $('[data-role="child-modal"]');
  const childSessionBody = $('[data-role="child-body"]');
  const directoryModal = $('[data-role="dir-modal"]');
  const directoryPath = $('[data-role="dir-path"]');
  const directoryList = $('[data-role="dir-list"]');

  const state = {
    sessions: [],
    selectedId: null,
    storageRoot: null,
    sessionQuery: '',
    messageFingerprints: new Map(),
    messageLimitBySession: new Map(),
    hasActiveSession: false,
    directoryRoot: null,
    currentDirectory: null,
    pendingSessionTitle: null,
    showHiddenDirectories: false,
  };

  const CLAMP_LINES = 20;
  const INITIAL_MESSAGE_LIMIT = 40;
  const MESSAGE_LIMIT_STEP = 40;
  // marked's global options are configured once at boot from app/main.js via
  // configureMarked() in app/lib/markdown.js. Per-call options below merge
  // with that global config, so we no longer need a local MARKDOWN_OPTIONS
  // const here or per-render setOptions calls.

  function getMessageLimit(sessionId) {
    return state.messageLimitBySession.get(sessionId) ?? INITIAL_MESSAGE_LIMIT;
  }

  function updateLoadMoreVisibility(hasMore) {
    if (!loadMoreWrap || !loadMoreBtn) return;
    if (!state.hasActiveSession || !state.selectedId) {
      loadMoreWrap.hidden = true;
      loadMoreBtn.disabled = true;
      return;
    }
    loadMoreWrap.hidden = !hasMore;
    loadMoreBtn.disabled = !hasMore;
  }

  function updateSessionControls(enabled) {
    if (renameSessionBtn) renameSessionBtn.disabled = !enabled;
    if (deleteSessionBtn) deleteSessionBtn.disabled = !enabled;
  }

  function renderMessageContent(target, raw) {
    if (window.marked && window.DOMPurify) {
      target.innerHTML = window.DOMPurify.sanitize(window.marked.parse(raw, { breaks: true }));
    } else {
      target.textContent = raw;
    }
  }

  function createChildMessageNode(message) {
    const wrap = document.createElement('div');
    wrap.className = `message ${message.role || 'assistant'}`;
    const role = document.createElement('div');
    role.className = 'role';
    role.textContent = message.role || 'assistant';
    const content = document.createElement('div');
    content.className = 'content';
    renderMessageContent(content, message.content || '[no text]');
    const time = document.createElement('div');
    time.className = 'timestamp';
    time.textContent = formatTime(message.createdAt);
    wrap.append(role, content, time);
    return wrap;
  }

  function renderChildSessionCard(session, messages) {
    const card = document.createElement('div');
    card.className = 'child-session-card';
    const header = document.createElement('div');
    header.className = 'child-session-header';
    const title = document.createElement('div');
    title.className = 'child-session-title';
    title.textContent = session.title || session.slug || session.id;
    const meta = document.createElement('div');
    meta.className = 'child-session-meta';
    const agent = messages.find(m => m.agent)?.agent || 'unknown';
    const updatedAt = session?.time?.updated || session?.time?.created || null;
    meta.textContent = `agent: ${agent} \u00B7 ${updatedAt ? `updated ${formatTime(updatedAt)}` : 'updated unknown'}`;
    header.append(title, meta);
    const list = document.createElement('div');
    list.className = 'child-session-messages';
    const visible = (messages || []).filter(m => m.content && m.content.trim().length > 0);
    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'trash-empty';
      empty.textContent = 'No messages found for this session.';
      list.appendChild(empty);
    } else {
      visible.forEach(m => list.appendChild(createChildMessageNode(m)));
    }
    card.append(header, list);
    return card;
  }

  function renderChildSessionTabs(results) {
    const tabs = document.createElement('div');
    tabs.className = 'child-session-tabs';
    const panel = document.createElement('div');
    panel.className = 'child-session-panel';
    const setActive = (index) => {
      Array.from(tabs.children).forEach((b, i) => b.classList.toggle('active', i === index));
      panel.innerHTML = '';
      const { session, messages } = results[index];
      panel.appendChild(renderChildSessionCard(session, messages));
    };
    results.forEach((result, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'child-session-tab';
      const t = result.session.title || result.session.slug || result.session.id;
      const a = result.messages.find(m => m.agent)?.agent || 'agent';
      button.textContent = `${a}: ${t}`;
      button.addEventListener('click', () => setActive(index));
      tabs.appendChild(button);
    });
    setActive(0);
    return { tabs, panel };
  }

  async function openChildSessionModal(message) {
    if (!childSessionModal || !childSessionBody) return;
    const ids = message.childSessionIds || [];
    if (!ids.length) return;
    childSessionBody.textContent = 'Loading...';
    childSessionModal.removeAttribute('hidden');
    try {
      const results = await Promise.all(ids.map(async (id) => {
        const response = await fetch(`/api/sessions/${id}?limit=200`);
        const data = await response.json();
        if (!response.ok || !data.session) throw new Error(data?.error || `Failed to load session ${id}`);
        return { session: data.session, messages: data.messages || [] };
      }));
      childSessionBody.innerHTML = '';
      if (results.length === 1) {
        childSessionBody.appendChild(renderChildSessionCard(results[0].session, results[0].messages));
        return;
      }
      const { tabs, panel } = renderChildSessionTabs(results);
      childSessionBody.append(tabs, panel);
    } catch (error) {
      childSessionBody.textContent = error?.message || 'Failed to load subagent activity.';
    }
  }

  function formatProviderModel(session) {
    if (!session) return 'unknown';
    if (session.lastModelId) return session.lastModelId;
    if (session.lastProviderId) return session.lastProviderId;
    return 'unknown';
  }

  function createSessionCard(session) {
    const card = document.createElement('div');
    card.className = 'session-card';
    card.dataset.sessionId = session.id;
    const title = document.createElement('div');
    title.className = 'title';
    const directoryMeta = document.createElement('div');
    directoryMeta.className = 'meta meta-directory';
    const providerMeta = document.createElement('div');
    providerMeta.className = 'meta meta-provider';
    const badge = document.createElement('span');
    badge.className = 'badge';
    const time = document.createElement('div');
    time.className = 'meta meta-time';
    card.append(title, directoryMeta, providerMeta, badge, time);
    card.addEventListener('click', () => selectSession(session.id, { focusInput: true, forceAutoScroll: true }));
    return card;
  }

  function updateSessionCard(card, session) {
    const activeClass = session.id === state.selectedId ? 'active' : '';
    card.className = `session-card ${activeClass}`.trim();
    card.dataset.sessionId = session.id;
    const title = card.querySelector('.title');
    if (title) title.textContent = session.title;
    const directoryMeta = card.querySelector('.meta-directory');
    if (directoryMeta) directoryMeta.textContent = session.directory || 'No directory';
    const providerMeta = card.querySelector('.meta-provider');
    if (providerMeta) providerMeta.textContent = formatProviderModel(session);
    const timeMeta = card.querySelector('.meta-time');
    if (timeMeta) timeMeta.textContent = `Last activity: ${formatTime(session.lastActivity)}`;
    const badge = card.querySelector('.badge');
    if (badge) {
      const nextStatus = session.status;
      if (badge.dataset.status !== nextStatus) {
        badge.className = `badge ${nextStatus}`;
        badge.textContent = nextStatus;
        badge.dataset.status = nextStatus;
      } else if (!badge.textContent) {
        badge.textContent = nextStatus;
      }
    }
  }

  function isChildSession(s) { return Boolean(s.parentId); }
  function isSubagentSession(s) { const m = `${s.title || ''} ${s.slug || ''}`.toLowerCase(); return m.includes('subagent') || m.includes('sub agent') || m.includes('sub-agent'); }
  function isBackgroundSession(s) { return `${s.title || ''} ${s.slug || ''}`.toLowerCase().includes('background'); }
  function isTaskSession(s) { return /\btask\b/.test(`${s.title || ''} ${s.slug || ''}`.toLowerCase()); }
  function getSessionSearchText(s) { return [s.title, s.slug, s.directory].filter(Boolean).join(' ').toLowerCase(); }

  function renderSessions() {
    if (!state.sessions.length) {
      sessionList.innerHTML = '<div class="meta">No sessions found.</div>';
      return;
    }
    const query = state.sessionQuery.trim().toLowerCase();
    const eligible = state.sessions.filter(s => {
      if (!s.hasUserMessage) return false;
      if (isChildSession(s) || isSubagentSession(s) || isBackgroundSession(s) || isTaskSession(s)) return false;
      return true;
    });
    const filtered = query ? eligible.filter(s => getSessionSearchText(s).includes(query)) : eligible;
    if (!filtered.length) {
      sessionList.innerHTML = query ? '<div class="meta">No matching sessions.</div>' : '<div class="meta">No user sessions found.</div>';
      return;
    }
    const cards = Array.from(sessionList.querySelectorAll('.session-card'));
    const existing = new Map(cards.map(c => [c.dataset.sessionId, c]));
    const nextOrder = filtered.map(s => s.id);
    const currentOrder = cards.map(c => c.dataset.sessionId);
    const sameOrder = currentOrder.length === nextOrder.length && currentOrder.every((id, i) => id === nextOrder[i]);
    if (sameOrder) {
      filtered.forEach(s => { const c = existing.get(s.id) || createSessionCard(s); updateSessionCard(c, s); });
      return;
    }
    const fragment = document.createDocumentFragment();
    filtered.forEach(s => {
      let c = existing.get(s.id);
      if (!c) c = createSessionCard(s);
      updateSessionCard(c, s);
      fragment.appendChild(c);
    });
    sessionList.innerHTML = '';
    sessionList.appendChild(fragment);
  }

  function renderMessages(messages, options = {}) {
    const { autoScroll = false, onRendered = null } = options;
    messageList.innerHTML = '';
    if (!messages.length) {
      messageList.innerHTML = '<div class="meta">No messages found for this session.</div>';
      updateLoadMoreVisibility(false);
      return;
    }
    const visible = messages.filter(m => m.content && m.content.trim().length > 0);
    if (!visible.length) {
      messageList.innerHTML = '<div class="meta">No text messages in this session.</div>';
      updateLoadMoreVisibility(false);
      return;
    }
    visible.forEach(msg => {
      const wrap = document.createElement('div');
      wrap.className = `message ${msg.role || 'assistant'}`;
      const role = document.createElement('div');
      role.className = 'role';
      role.textContent = msg.role || 'assistant';
      const content = document.createElement('div');
      content.className = 'content';
      renderMessageContent(content, msg.content || '[no text]');
      content.style.setProperty('--clamp-lines', CLAMP_LINES);
      const time = document.createElement('div');
      time.className = 'timestamp';
      time.textContent = formatTime(msg.createdAt);
      const childSessions = Array.isArray(msg.childSessionIds) ? msg.childSessionIds : [];
      const childKinds = Array.isArray(msg.childSessionKinds) ? msg.childSessionKinds : [];
      if (childSessions.length) {
        wrap.classList.add('has-children');
        wrap.title = 'Click to view agent activity';
        let label = 'agent';
        if (childKinds.includes('background') && !childKinds.includes('subagent')) label = 'background';
        else if (childKinds.includes('subagent') && !childKinds.includes('background')) label = 'subagent';
        role.textContent = `${msg.role || 'assistant'} \u00B7 ${label}`;
        wrap.addEventListener('click', (event) => {
          if (event.target.closest('a') || event.target.closest('.expand-toggle')) return;
          if (window.getSelection && window.getSelection().toString()) return;
          openChildSessionModal(msg);
        });
      }
      let toggle = null;
      if (!childSessions.length) {
        toggle = document.createElement('button');
        toggle.className = 'expand-toggle';
        toggle.type = 'button';
        toggle.textContent = 'Expand';
        toggle.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
        toggle.addEventListener('click', (event) => {
          event.stopPropagation();
          const isCollapsed = content.classList.contains('clamped');
          if (isCollapsed) { content.classList.remove('clamped'); toggle.textContent = 'Collapse'; toggle.setAttribute('aria-expanded', 'true'); }
          else { content.classList.add('clamped'); toggle.textContent = 'Expand'; toggle.setAttribute('aria-expanded', 'false'); }
        });
      }
      wrap.append(role, content);
      if (toggle) wrap.appendChild(toggle);
      wrap.appendChild(time);
      messageList.appendChild(wrap);
    });
    requestAnimationFrame(() => {
      applyMessageClamp();
      if (autoScroll) scrollConversationToBottom();
      if (typeof onRendered === 'function') onRendered();
    });
  }

  function applyMessageClamp() {
    messageList.querySelectorAll('.message').forEach(item => {
      const content = item.querySelector('.content');
      const toggle = item.querySelector('.expand-toggle');
      if (!content || !toggle) return;
      content.classList.add('clamped');
      if (content.scrollHeight > content.clientHeight + 1) {
        toggle.hidden = false;
        toggle.textContent = 'Expand';
        toggle.setAttribute('aria-expanded', 'false');
      } else {
        content.classList.remove('clamped');
        toggle.hidden = true;
      }
    });
  }

  function scrollConversationToBottom() {
    if (conversation) conversation.scrollTop = conversation.scrollHeight;
  }

  async function loadSessions() {
    updateLoadMoreVisibility(false);
    const response = await fetch('/api/sessions');
    const data = await response.json();
    state.sessions = data.sessions || [];
    state.storageRoot = data.storageRoot;
    const hasSelected = state.selectedId && state.sessions.some(s => s.id === state.selectedId);
    state.hasActiveSession = Boolean(hasSelected);
    updateSessionControls(Boolean(hasSelected));
    renderSessions();
  }

  let _selectRequestId = 0; // Guard against stale responses

  async function selectSession(id, options = {}) {
    const { preserveDraft = false, focusInput = false, clearStatus = true, forceRender = false, preserveScrollPosition = false, forceAutoScroll = false } = options;
    const previousId = state.selectedId;
    if (id !== previousId) state.messageLimitBySession.set(id, INITIAL_MESSAGE_LIMIT);
    const shouldAutoScroll = (forceAutoScroll || id !== previousId) && !preserveScrollPosition;
    const scrollSnapshot = preserveScrollPosition && conversation ? { height: conversation.scrollHeight, top: conversation.scrollTop } : null;
    state.selectedId = id;
    const requestId = ++_selectRequestId;
    renderSessions();
    if (clearStatus) sendStatus.textContent = '';
    if (!preserveDraft) messageInput.value = '';
    if (focusInput) messageInput.focus();
    const messageLimit = getMessageLimit(id);
    const response = await fetch(`/api/sessions/${id}?limit=${messageLimit + 1}`);
    const data = await response.json();
    // Guard: if user switched to a different session while we were fetching, discard
    if (requestId !== _selectRequestId || state.selectedId !== id) return;
    if (!data.session) {
      state.hasActiveSession = false;
      sessionTitleEl.querySelector('.title').textContent = 'Session not found';
      sessionMeta.textContent = '';
      messageList.innerHTML = '';
      updateLoadMoreVisibility(false);
      updateSessionControls(false);
      return;
    }
    state.hasActiveSession = true;
    updateSessionControls(true);
    sessionTitleEl.querySelector('.title').textContent = data.session.title || data.session.slug || data.session.id;
    sessionMeta.textContent = `${data.session.directory || 'No directory'} \u00B7 Updated ${formatTime(data.session.time?.updated)}`;
    const messages = data.messages || [];
    const hasMoreMessages = messages.length > messageLimit;
    const displayMessages = hasMoreMessages ? messages.slice(Math.max(0, messages.length - messageLimit)) : messages;
    const last = displayMessages[displayMessages.length - 1];
    const fingerprint = { count: displayMessages.length, lastId: last?.id || null, lastCreatedAt: last?.createdAt || 0, lastCompletedAt: last?.completedAt || 0 };
    const previous = state.messageFingerprints.get(id);
    const changed = !previous || previous.count !== fingerprint.count || previous.lastId !== fingerprint.lastId || previous.lastCreatedAt !== fingerprint.lastCreatedAt || previous.lastCompletedAt !== fingerprint.lastCompletedAt;
    if (forceRender || id !== previousId || changed) {
      renderMessages(displayMessages, {
        autoScroll: shouldAutoScroll,
        onRendered: () => {
          if (!scrollSnapshot || !conversation) return;
          conversation.scrollTop = scrollSnapshot.top + (conversation.scrollHeight - scrollSnapshot.height);
        },
      });
      state.messageFingerprints.set(id, fingerprint);
    }
    updateLoadMoreVisibility(hasMoreMessages);
  }

  async function loadMoreMessages() {
    if (!state.selectedId) return;
    state.messageLimitBySession.set(state.selectedId, getMessageLimit(state.selectedId) + MESSAGE_LIMIT_STEP);
    if (loadMoreBtn) loadMoreBtn.disabled = true;
    await selectSession(state.selectedId, { preserveDraft: true, focusInput: false, clearStatus: false, forceRender: true, preserveScrollPosition: true });
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (!state.selectedId) return;
    const content = messageInput.value.trim();
    if (!content) return;
    sendStatus.textContent = 'Sending...';
    const response = await fetch(`/api/sessions/${state.selectedId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    const data = await response.json();
    sendStatus.textContent = data.status === 'ok' ? 'Sent.' : 'Failed to send.';
    const sessionId = state.selectedId;
    const initial = state.messageFingerprints.get(sessionId);
    for (let attempt = 0; attempt < 6; attempt++) {
      await selectSession(sessionId, { forceAutoScroll: true, forceRender: true });
      const next = state.messageFingerprints.get(sessionId);
      if (!initial || !next) return;
      if (next.count !== initial.count || next.lastId !== initial.lastId) return;
      await new Promise(r => setTimeout(r, 800));
    }
  }

  async function createSession() {
    const title = window.prompt('New session title');
    if (!title) return;
    state.pendingSessionTitle = title.trim();
    openDirectoryModal();
  }

  async function createSessionWithDirectory(directory) {
    if (!state.pendingSessionTitle) return;
    const response = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: state.pendingSessionTitle, directory }),
    });
    const data = await response.json();
    if (!response.ok) { window.alert(data.error || 'Failed to create session'); return; }
    state.pendingSessionTitle = null;
    await loadSessions();
    if (data.session?.id) await selectSession(data.session.id, { focusInput: true, forceAutoScroll: true });
  }

  async function renameSession() {
    if (!state.selectedId) return;
    const current = sessionTitleEl.querySelector('.title')?.textContent || '';
    const title = window.prompt('Rename session', current);
    if (!title) return;
    const response = await fetch(`/api/sessions/${state.selectedId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim() }),
    });
    if (!response.ok) { const d = await response.json(); window.alert(d.error || 'Failed to rename session'); return; }
    await loadSessions();
    await selectSession(state.selectedId, { preserveDraft: true, focusInput: false, clearStatus: false, forceAutoScroll: false });
  }

  async function deleteSession() {
    if (!state.selectedId) return;
    const name = sessionTitleEl.querySelector('.title')?.textContent || state.selectedId;
    if (!window.confirm(`Delete session "${name}"? It will be moved to storage/trash.`)) return;
    const response = await fetch(`/api/sessions/${state.selectedId}`, { method: 'DELETE' });
    if (!response.ok) { const d = await response.json(); window.alert(d.error || 'Failed to delete session'); return; }
    state.selectedId = null;
    state.hasActiveSession = false;
    updateSessionControls(false);
    updateLoadMoreVisibility(false);
    sessionTitleEl.querySelector('.title').textContent = 'Select a session';
    sessionMeta.textContent = '';
    messageList.innerHTML = '';
    await loadSessions();
    await loadTrashSessions();
  }

  // Usage panel
  function toggleUsagePanel() {
    if (!usageModal) return;
    const shouldOpen = usageModal.hasAttribute('hidden');
    if (shouldOpen) { usageModal.removeAttribute('hidden'); loadCodexStatus(); }
    else { usageModal.setAttribute('hidden', ''); }
  }

  function formatUsageReset(resetAt) {
    if (!resetAt) return '';
    const date = new Date(resetAt);
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
    if (sameDay) return time;
    return `${time} on ${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
  }

  function formatUsageBar(percentLeft) {
    const width = 20;
    if (percentLeft == null) return `[${'░'.repeat(width)}]`;
    const clamped = Math.max(0, Math.min(100, percentLeft));
    const filled = Math.round((clamped / 100) * width);
    return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`;
  }

  function buildLimitLine(limit) {
    const label = limit.label || 'limit';
    const percentLeft = typeof limit.remainingPct === 'number' ? limit.remainingPct : null;
    const resetText = formatUsageReset(limit.resetAt);
    const resetSuffix = resetText ? `\nresets ${resetText}` : '';
    if (limit.errorMessage) return { label, barLine: limit.errorMessage };
    const usageText = percentLeft == null ? '? left' : `${Math.round(percentLeft)}% left`;
    return { label, barLine: `${formatUsageBar(percentLeft)} ${usageText}${resetSuffix}` };
  }

  function displayProviderLabel(id) {
    if (id === 'openai' || id === 'codex') return 'codex';
    if (id === 'google' || id === 'gemini') return 'gemini';
    if (id === 'anthropic' || id === 'claude') return 'claude';
    return id;
  }

  function renderUsageProviders(providers, registeredProviders) {
    if (!usageOutput) return;
    usageOutput.innerHTML = '';
    const headerEl = document.createElement('div');
    headerEl.className = 'usage-registered';
    const ordered = [];
    if (Array.isArray(providers)) providers.forEach(p => { const l = displayProviderLabel(p?.id || p?.name); if (l && !ordered.includes(l)) ordered.push(l); });
    if (Array.isArray(registeredProviders)) registeredProviders.forEach(i => { const l = displayProviderLabel(i); if (!ordered.includes(l)) ordered.push(l); });
    headerEl.textContent = ordered.length ? `Registered: ${ordered.join(', ')}` : 'Registered: none';
    const list = document.createElement('div');
    list.className = 'usage-cards';
    if (!Array.isArray(providers) || !providers.length) { usageOutput.textContent = 'No registered providers with usage data.'; return; }
    providers.forEach(provider => {
      const card = document.createElement('div');
      card.className = 'usage-card';
      const hdr = document.createElement('div');
      hdr.className = 'usage-card-header';
      const t = document.createElement('div');
      t.className = 'usage-card-title';
      t.textContent = provider.name || 'Provider';
      const m = document.createElement('div');
      m.className = 'usage-card-meta';
      if (provider.account?.type === 'chatgpt') { m.textContent = `${provider.account.email || 'unknown'}${provider.account.planType ? ` / ${provider.account.planType}` : ''}`; }
      else if (provider.account?.type === 'apiKey') { m.textContent = 'API key'; }
      else if (provider.requiresOpenaiAuth) { m.textContent = 'Login required'; }
      hdr.append(t, m);
      const summary = document.createElement('div');
      summary.className = 'usage-card-summary';
      const limits = Array.isArray(provider.limits) ? provider.limits : [];
      if (limits[0]) {
        const sl = buildLimitLine(limits[0]);
        const lb = document.createElement('div'); lb.className = 'usage-limit-label'; lb.textContent = sl.label;
        const bl = document.createElement('div'); bl.className = 'usage-limit-bar'; bl.textContent = sl.barLine;
        summary.append(lb, bl);
      } else { summary.textContent = 'No usage data.'; }
      const details = document.createElement('details');
      details.className = 'usage-details';
      const ds = document.createElement('summary');
      ds.textContent = '\uC0C1\uC138\uBCF4\uAE30';
      details.addEventListener('toggle', () => { ds.textContent = details.open ? '\uC811\uAE30' : '\uC0C1\uC138\uBCF4\uAE30'; });
      const db = document.createElement('div');
      db.className = 'usage-details-body';
      limits.slice(1).forEach(limit => {
        const block = document.createElement('div'); block.className = 'usage-limit-block';
        const line = buildLimitLine(limit);
        const lb = document.createElement('div'); lb.className = 'usage-limit-label'; lb.textContent = line.label;
        const bl = document.createElement('div'); bl.className = 'usage-limit-bar'; bl.textContent = line.barLine;
        block.append(lb, bl); db.append(block);
      });
      if (provider.accountError) { const el = document.createElement('div'); el.textContent = `Account error: ${provider.accountError}`; db.append(el); }
      if (provider.updatedAt) { const el = document.createElement('div'); const d = new Date(provider.updatedAt); el.textContent = Number.isNaN(d.getTime()) ? `Updated: ${provider.updatedAt}` : `Updated: ${d.toLocaleString()}`; db.append(el); }
      details.append(ds, db);
      card.append(hdr, summary, details);
      list.append(card);
    });
    usageOutput.append(headerEl, list);
  }

  async function loadCodexStatus() {
    if (!usageOutput) return;
    usageOutput.textContent = 'Loading...';
    try {
      const response = await fetch('/api/usage/providers');
      const data = await response.json();
      if (!response.ok) throw new Error(`${data?.error || 'Failed'}${data?.details ? '\n' + data.details : ''}`);
      renderUsageProviders(data.providers, data.registeredProviders);
    } catch (err) { usageOutput.textContent = err?.message || 'Failed to load codex status'; }
  }

  // Trash panel
  function toggleTrashPanel() {
    if (!trashModal) return;
    const shouldOpen = trashModal.hasAttribute('hidden');
    if (shouldOpen) { trashModal.removeAttribute('hidden'); loadTrashSessions(); }
    else { trashModal.setAttribute('hidden', ''); }
  }

  async function restoreTrashSession(trashId) {
    const r = await fetch(`/api/trash/sessions/${trashId}/restore`, { method: 'POST' });
    if (!r.ok) { window.alert('Failed to restore'); return; }
    await loadSessions();
    await loadTrashSessions();
  }

  async function deleteTrashSession(trashId) {
    if (!window.confirm('Permanently delete?')) return;
    const r = await fetch(`/api/trash/sessions/${trashId}`, { method: 'DELETE' });
    if (!r.ok) { window.alert('Failed to delete'); return; }
    await loadTrashSessions();
  }

  async function loadTrashSessions() {
    if (!trashList) return;
    const response = await fetch('/api/trash/sessions');
    const data = await response.json();
    const items = data.items || [];
    if (!items.length) { trashList.innerHTML = '<div class="trash-empty">No trashed sessions.</div>'; return; }
    trashList.innerHTML = '';
    items.forEach(item => {
      const row = document.createElement('div');
      row.className = 'trash-item';
      const meta = document.createElement('div');
      meta.className = 'trash-meta';
      const t = document.createElement('div');
      t.textContent = item.session?.title || item.session?.slug || item.session?.id || 'Untitled';
      const w = document.createElement('div');
      w.textContent = `Trashed: ${item.trashedAt ? formatTime(item.trashedAt) : 'Unknown'}`;
      meta.append(t, w);
      const actions = document.createElement('div');
      actions.className = 'trash-actions';
      const rb = document.createElement('button');
      rb.className = 'ghost'; rb.textContent = 'Restore';
      rb.addEventListener('click', () => restoreTrashSession(item.trashId));
      const db = document.createElement('button');
      db.className = 'ghost danger'; db.textContent = 'Delete';
      db.addEventListener('click', () => deleteTrashSession(item.trashId));
      actions.append(rb, db);
      row.append(meta, actions);
      trashList.appendChild(row);
    });
  }

  // Directory modal
  function openDirectoryModal() {
    if (!directoryModal) return;
    directoryModal.removeAttribute('hidden');
    loadDirectory(state.currentDirectory || state.directoryRoot || null);
  }

  function closeDirectoryModal() { directoryModal?.setAttribute('hidden', ''); }
  function cancelDirectoryModal() { state.pendingSessionTitle = null; closeDirectoryModal(); }

  async function loadDirectory(targetPath) {
    if (!directoryList || !directoryPath) return;
    const hq = state.showHiddenDirectories ? 'showHidden=1' : 'showHidden=0';
    const url = targetPath ? `/api/fs?path=${encodeURIComponent(targetPath)}&${hq}` : `/api/fs?${hq}`;
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok) { window.alert(data.error || 'Failed to load directory'); return; }
    state.directoryRoot = data.root;
    state.currentDirectory = data.path;
    directoryPath.textContent = data.path;
    const upBtn = root.querySelector('[data-action="dir-up"]');
    if (upBtn) upBtn.disabled = data.path === data.root;
    directoryList.innerHTML = '';
    const dirs = data.directories || [];
    if (!dirs.length) {
      const empty = document.createElement('div');
      empty.className = 'trash-empty';
      empty.textContent = 'No subfolders.';
      directoryList.appendChild(empty);
      return;
    }
    dirs.forEach(dir => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'directory-item';
      item.textContent = dir.name;
      item.addEventListener('click', () => loadDirectory(dir.path));
      directoryList.appendChild(item);
    });
  }

  function handleDirectoryConfirm() {
    if (!state.currentDirectory) { window.alert('Select a directory first'); return; }
    closeDirectoryModal();
    createSessionWithDirectory(state.currentDirectory);
  }

  // Wire up events via delegation on root
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'new') createSession();
    else if (action === 'refresh') loadSessions();
    else if (action === 'rename') renameSession();
    else if (action === 'delete') deleteSession();
    else if (action === 'usage') toggleUsagePanel();
    else if (action === 'usage-close') usageModal?.setAttribute('hidden', '');
    else if (action === 'usage-refresh') loadCodexStatus();
    else if (action === 'trash') toggleTrashPanel();
    else if (action === 'trash-close') trashModal?.setAttribute('hidden', '');
    else if (action === 'child-close') { childSessionModal?.setAttribute('hidden', ''); if (childSessionBody) childSessionBody.textContent = ''; }
    else if (action === 'dir-up') {
      if (state.currentDirectory && state.directoryRoot && state.currentDirectory !== state.directoryRoot) {
        loadDirectory(state.currentDirectory.split('/').slice(0, -1).join('/') || '/');
      }
    }
    else if (action === 'dir-select') handleDirectoryConfirm();
    else if (action === 'dir-cancel') cancelDirectoryModal();
    else if (action === 'load-more') loadMoreMessages();
  });

  root.addEventListener('change', (e) => {
    if (e.target.matches('[data-action="dir-hidden"]')) {
      state.showHiddenDirectories = Boolean(e.target.checked);
      loadDirectory(state.currentDirectory || state.directoryRoot || null);
    }
  });

  if (sessionSearch) {
    sessionSearch.addEventListener('input', (e) => {
      state.sessionQuery = e.target.value;
      renderSessions();
    });
  }

  if (sendForm) {
    sendForm.addEventListener('submit', sendMessage);
  }

  if (messageInput) {
    messageInput.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (sendForm.requestSubmit) sendForm.requestSubmit();
        else sendForm.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    });
  }

  // Initial load + polling
  loadSessions();
  const pollTimer = setInterval(async () => {
    await loadSessions();
    if (state.selectedId) {
      await selectSession(state.selectedId, { preserveDraft: true, focusInput: false, clearStatus: false, forceAutoScroll: false });
    }
  }, 5000);

  // Return cleanup function for React/Preact useEffect
  return () => clearInterval(pollTimer);
}

// ─────────────────────────────────────────────────────────────────────────────
// Toast Notification System
// ─────────────────────────────────────────────────────────────────────────────

// Global toast state - simple pub/sub
const toastState = { toasts: [], listeners: [] };
let toastIdCounter = 0;

function addToast(message, type = 'error') {
  const id = ++toastIdCounter;
  toastState.toasts = [...toastState.toasts, { id, message, type }];
  toastState.listeners.forEach(fn => fn(toastState.toasts));
  // Auto-dismiss after 5s
  setTimeout(() => {
    toastState.toasts = toastState.toasts.filter(t => t.id !== id);
    toastState.listeners.forEach(fn => fn(toastState.toasts));
  }, 5000);
}

function useToasts() {
  const [toasts, setToasts] = useState(toastState.toasts);
  useEffect(() => {
    toastState.listeners.push(setToasts);
    return () => {
      toastState.listeners = toastState.listeners.filter(fn => fn !== setToasts);
    };
  }, []);
  return toasts;
}

function ToastContainer() {
  const toasts = useToasts();
  if (!toasts.length) return null;
  return html`
    <div class="toast-container" role="status" aria-live="polite">
      ${toasts.map(t => html`
        <div key=${t.id} class="toast toast-${t.type}">
          <span class="toast-message">${t.message}</span>
        </div>
      `)}
    </div>
  `;
}

// Wrap apiFetch to show error toasts on failure
const _origApiFetch = apiFetch;
async function apiFetchWithToast(url, opts = {}) {
  try {
    return await _origApiFetch(url, opts);
  } catch (err) {
    addToast(err.message || 'Request failed', 'error');
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser Notifications
// ─────────────────────────────────────────────────────────────────────────────

let notificationPermissionRequested = false;

function requestNotificationPermission() {
  if (notificationPermissionRequested) return;
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    notificationPermissionRequested = true;
    Notification.requestPermission();
  }
}

function showBrowserNotification(title, body) {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    new Notification(title, { body, icon: undefined });
  }
}

// Request permission on first user interaction
if (typeof window !== 'undefined') {
  const requestOnce = () => {
    requestNotificationPermission();
    document.removeEventListener('click', requestOnce);
    document.removeEventListener('keydown', requestOnce);
  };
  document.addEventListener('click', requestOnce);
  document.addEventListener('keydown', requestOnce);
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Config View
// ─────────────────────────────────────────────────────────────────────────────

function AgentModal({ open, onClose, agent, onSaved }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('claude-code');
  const [command, setCommand] = useState('');
  const [argsTemplate, setArgsTemplate] = useState('');
  const [icon, setIcon] = useState('');
  const [color, setColor] = useState('');
  const [maxConcurrent, setMaxConcurrent] = useState(1);
  const [saving, setSaving] = useState(false);
  useEscape(open, onClose);

  useEffect(() => {
    if (open && agent) {
      setName(agent.name || '');
      setType(agent.type || 'claude-code');
      setCommand(agent.command || '');
      setArgsTemplate(agent.args_template || '');
      setIcon(agent.icon || '');
      setColor(agent.color || '');
      setMaxConcurrent(agent.max_concurrent || 1);
    } else if (open) {
      setName(''); setType('claude-code'); setCommand(''); setArgsTemplate('');
      setIcon(''); setColor(''); setMaxConcurrent(1);
    }
  }, [open, agent]);

  if (!open) return null;

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        type,
        command: command.trim() || undefined,
        args_template: argsTemplate.trim() || undefined,
        icon: icon.trim() || undefined,
        color: color.trim() || undefined,
        max_concurrent: parseInt(maxConcurrent, 10) || 1,
      };
      if (agent) {
        await apiFetchWithToast(`/api/agents/${agent.id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
      } else {
        await apiFetchWithToast('/api/agents', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      }
      onSaved();
      onClose();
    } catch { /* toast already shown */ }
    setSaving(false);
  };

  return html`
    <div class="modal-overlay">
      <div class="modal-backdrop" onClick=${onClose}></div>
      <div class="modal-panel">
        <div class="modal-header">
          <h2 class="modal-title">${agent ? 'Edit Agent' : 'New Agent'}</h2>
          <button class="ghost" onClick=${onClose}>Close</button>
        </div>
        <div class="modal-body">
          <div class="form-field">
            <label class="form-label">Name</label>
            <input class="form-input" value=${name} onInput=${e => setName(e.target.value)} placeholder="Agent name" />
          </div>
          <div class="form-field">
            <label class="form-label">Type</label>
            <select class="form-select" value=${type} onChange=${e => {
              const t = e.target.value;
              setType(t);
              if (!agent) {
                const presets = {
                  'claude-code': { cmd: 'claude', args: '-p {prompt} --permission-mode bypassPermissions' },
                  'codex': { cmd: 'codex', args: 'exec --full-auto --skip-git-repo-check -c \'model_reasoning_effort="high"\' {prompt}' },
                  'gemini': { cmd: 'gemini', args: '-p {prompt} --yolo' },
                  'opencode': { cmd: 'opencode', args: '{prompt}' },
                };
                const p = presets[t];
                if (p) { setCommand(p.cmd); setArgsTemplate(p.args); }
              }
            }}>
              <option value="claude-code">claude-code</option>
              <option value="codex">codex</option>
              <option value="gemini">gemini</option>
              <option value="opencode">opencode</option>
              <option value="custom">custom</option>
            </select>
          </div>
          <div class="form-field">
            <label class="form-label">Command</label>
            <input class="form-input" value=${command} onInput=${e => setCommand(e.target.value)} placeholder="e.g. claude" />
          </div>
          <div class="form-field">
            <label class="form-label">Args Template</label>
            <input class="form-input" value=${argsTemplate} onInput=${e => setArgsTemplate(e.target.value)} placeholder="e.g. --model {{model}}" />
          </div>
          <div class="form-field">
            <label class="form-label">Icon</label>
            <input class="form-input" value=${icon} onInput=${e => setIcon(e.target.value)} placeholder="Emoji or symbol" />
          </div>
          <div class="form-field">
            <label class="form-label">Color</label>
            <input class="form-input" value=${color} onInput=${e => setColor(e.target.value)} placeholder="#6fd4a0" />
          </div>
          <div class="form-field">
            <label class="form-label">Max Concurrent</label>
            <input class="form-input" type="number" min="1" value=${maxConcurrent} onInput=${e => setMaxConcurrent(e.target.value)} />
          </div>
        </div>
        <div class="modal-footer">
          <button class="ghost" onClick=${onClose}>Cancel</button>
          <button class="primary" onClick=${handleSave} disabled=${saving || !name.trim()}>
            ${saving ? 'Saving...' : agent ? 'Update' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  `;
}

function AgentDetailModal({ agent, open, onClose, onEdit }) {
  const [usage, setUsage] = useState(null);
  const [runningCount, setRunningCount] = useState(0);
  const [loadingUsage, setLoadingUsage] = useState(true);
  const [error, setError] = useState(null);

  const loadUsage = async () => {
    if (!agent) return;
    setLoadingUsage(true);
    setError(null);
    try {
      const data = await apiFetch(`/api/agents/${agent.id}/usage`);
      setUsage(data.usage);
      setRunningCount(data.runningCount || 0);
    } catch (err) {
      setError(err.message);
      setUsage(null);
    } finally {
      setLoadingUsage(false);
    }
  };

  useEffect(() => { setUsage(null); setError(null); setRunningCount(0); setLoadingUsage(true); loadUsage(); }, [agent?.id]);

  if (!open || !agent) return null;

  const formatResetTime = (resetAt) => {
    if (!resetAt) return null;
    const d = new Date(resetAt);
    if (Number.isNaN(d.getTime())) return null;
    const now = Date.now();
    const diff = d.getTime() - now;
    if (diff <= 0) return 'now';
    const mins = Math.floor(diff / 60000);
    const hrs = Math.floor(mins / 60);
    const days = Math.floor(hrs / 24);
    if (days > 0) return `${days}d ${hrs % 24}h ${mins % 60}m`;
    if (hrs > 0) return `${hrs}h ${mins % 60}m`;
    return `${mins}m`;
  };

  const renderBar = (pct) => {
    if (pct === null || pct === undefined) return null;
    const remaining = Math.max(0, Math.min(100, pct));
    const barColor = pct > 50 ? '#10b981' : pct > 20 ? '#3b82f6' : pct > 10 ? '#f59e0b' : '#ef4444';
    return html`
      <div class="agent-usage-bar-track">
        <div class="agent-usage-bar-fill" style=${{ width: `${remaining}%`, background: barColor }} />
      </div>
    `;
  };

  return html`
    <div class="modal-overlay" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="agent-detail-panel">
        <div class="agent-detail-header">
          <div class="agent-detail-header-title">Agent Detail</div>
          <div class="agent-detail-header-actions">
            <button class="ghost" onClick=${() => onEdit(agent)}>Edit</button>
            <button class="ghost" onClick=${onClose}>\u2715</button>
          </div>
        </div>

      <div class="agent-detail-profile">
        <div class="agent-detail-icon" style=${{ color: agent.color || undefined, borderColor: agent.color ? agent.color + '33' : undefined }}>
          ${agent.icon || '\u2699'}
        </div>
        <div>
          <div class="agent-detail-name">${agent.name}</div>
          <div class="agent-detail-type">${agent.type || 'custom'}</div>
        </div>
      </div>

      <div class="agent-detail-section">
        <div class="agent-detail-section-title">Configuration</div>
        <div class="agent-detail-grid">
          ${agent.command && html`
            <div class="agent-detail-field">
              <span class="agent-detail-field-label">Command</span>
              <span class="agent-detail-field-value mono">${agent.command}</span>
            </div>
          `}
          ${agent.args_template && html`
            <div class="agent-detail-field">
              <span class="agent-detail-field-label">Args Template</span>
              <span class="agent-detail-field-value mono">${agent.args_template}</span>
            </div>
          `}
          <div class="agent-detail-field">
            <span class="agent-detail-field-label">Max Concurrent</span>
            <span class="agent-detail-field-value">${agent.max_concurrent || 1}</span>
          </div>
          <div class="agent-detail-field">
            <span class="agent-detail-field-label">Running Now</span>
            <span class="agent-detail-field-value">${runningCount}</span>
          </div>
        </div>
      </div>

      <div class="agent-detail-section">
        <div class="agent-detail-section-header">
          <div class="agent-detail-section-title">Usage & Limits</div>
          <button class="ghost small" onClick=${loadUsage} disabled=${loadingUsage}>
            ${loadingUsage ? 'Loading...' : 'Refresh'}
          </button>
        </div>
        ${loadingUsage && !usage && html`<div class="agent-detail-loading">Loading usage data...</div>`}
        ${error && html`<div class="agent-detail-error">${error}</div>`}
        ${usage && html`
          <div class="agent-usage-card">
            ${usage.account ? html`
              <div class="agent-usage-account">
                ${usage.account.email && html`
                  <div class="agent-detail-field">
                    <span class="agent-detail-field-label">Account</span>
                    <span class="agent-detail-field-value">${usage.account.email}</span>
                  </div>
                `}
                ${usage.account.planType && html`
                  <div class="agent-detail-field">
                    <span class="agent-detail-field-label">Plan</span>
                    <span class="agent-detail-field-value">${usage.account.planType}</span>
                  </div>
                `}
                ${usage.account.type && html`
                  <div class="agent-detail-field">
                    <span class="agent-detail-field-label">Auth Type</span>
                    <span class="agent-detail-field-value">${usage.account.type}</span>
                  </div>
                `}
              </div>
            ` : ''}
            ${usage.requiresOpenaiAuth && !usage.account && html`
              <div class="agent-detail-warning">OpenAI login required</div>
            `}
            ${(usage.limits || []).map(limit => html`
              <div class="agent-usage-limit">
                <div class="agent-usage-limit-header">
                  <span class="agent-usage-limit-label">${limit.label}</span>
                  ${limit.remainingPct !== null && limit.remainingPct !== undefined
                    ? html`<span class="agent-usage-limit-pct">${Math.round(limit.remainingPct)}% remaining</span>`
                    : ''}
                </div>
                ${renderBar(limit.remainingPct)}
                ${limit.errorMessage ? html`<div class="agent-usage-limit-error">${limit.errorMessage}</div>` : ''}
                ${limit.resetAt ? html`
                  <div class="agent-usage-limit-reset">Resets in ${formatResetTime(limit.resetAt) || new Date(limit.resetAt).toLocaleString()}</div>
                ` : ''}
              </div>
            `)}
            ${usage.updatedAt && html`
              <div class="agent-usage-updated">Updated: ${new Date(usage.updatedAt).toLocaleString()}</div>
            `}
          </div>
        `}
        </div>
      </div>
    </div>
  `;
}

function AgentsView({ agents, loading, reloadAgents }) {
  const [showModal, setShowModal] = useState(false);
  const [editAgent, setEditAgent] = useState(null);
  const [selectedAgent, setSelectedAgent] = useState(null);

  const handleDelete = async (agent) => {
    if (!confirm(`Delete agent "${agent.name}"?`)) return;
    try {
      await apiFetchWithToast(`/api/agents/${agent.id}`, { method: 'DELETE' });
      if (selectedAgent?.id === agent.id) setSelectedAgent(null);
      reloadAgents();
    } catch { /* toast already shown */ }
  };

  if (loading) return html`<${Loading} />`;

  return html`
    <div class="agents-view">
      <div class="agents-header">
        <h1 class="agents-title">Agent Profiles</h1>
        <button class="primary" onClick=${() => { setEditAgent(null); setShowModal(true); }}>+ New Agent</button>
      </div>
      <div class="agents-list">
        ${agents.length === 0 && html`
          <${EmptyState}
            icon="\u2699"
            text="No agent profiles yet."
            sub="Create an agent profile to configure how tasks are executed."
          />
        `}
        ${agents.map(a => html`
          <div key=${a.id} class="agent-card clickable" role="button" tabIndex="0"
            onClick=${() => setSelectedAgent(a)}
            onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedAgent(a); } }}>
            <div class="agent-card-top">
              <div class="agent-card-icon" style=${a.color ? `color: ${a.color}` : ''}>${a.icon || '\u2699'}</div>
              <div class="agent-card-info">
                <div class="agent-card-name">${a.name}</div>
                <div class="agent-card-type">${a.type || 'custom'}</div>
              </div>
            </div>
            ${a.command && html`<div class="agent-card-detail"><span class="agent-detail-label">Command:</span> ${a.command}</div>`}
            <div class="agent-card-detail"><span class="agent-detail-label">Max Concurrent:</span> ${a.max_concurrent || 1}</div>
            <div class="agent-card-actions">
              <button class="ghost" onClick=${(e) => { e.stopPropagation(); setEditAgent(a); setShowModal(true); }}>Edit</button>
              <button class="ghost danger" onClick=${(e) => { e.stopPropagation(); handleDelete(a); }}>Delete</button>
            </div>
          </div>
        `)}
      </div>
      <${AgentModal}
        open=${showModal}
        onClose=${() => { setShowModal(false); setEditAgent(null); }}
        agent=${editAgent}
        onSaved=${reloadAgents}
      />
      <${AgentDetailModal}
        open=${!!selectedAgent}
        agent=${selectedAgent}
        onClose=${() => setSelectedAgent(null)}
        onEdit=${(a) => { setSelectedAgent(null); setEditAgent(a); setShowModal(true); }}
      />
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Manager View (Full Page — Left: Chat 60%, Right: Session Grid 40%)
// ─────────────────────────────────────────────────────────────────────────────

function ManagerView({ manager, runs, tasks, projects }) {
  const { status, events, loading, start, sendMessage, stop } = manager;
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [attachedImages, setAttachedImages] = useState([]);
  const messagesRef = useRef(null);
  const fileInputRef = useRef(null);

  // Auto-scroll to bottom on new events
  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [events]);

  // Read file as base64
  const readFileAsBase64 = (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result.split(',')[1];
        resolve({ data: base64, media_type: file.type, name: file.name, preview: reader.result });
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const addImages = async (files) => {
    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;
    const newImages = await Promise.all(imageFiles.map(readFileAsBase64));
    setAttachedImages(prev => [...prev, ...newImages]);
  };

  const removeImage = (idx) => {
    setAttachedImages(prev => prev.filter((_, i) => i !== idx));
  };

  // Handle paste with images
  const handlePaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      addImages(files);
    }
  };

  // Handle drag & drop
  const [dragOver, setDragOver] = useState(false);
  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer?.files) addImages(e.dataTransfer.files);
  };

  // Parse events into displayable messages
  const messages = useMemo(() => {
    return events
      .filter(e => ['assistant_text', 'user_input', 'error'].includes(e.event_type))
      .map(e => {
        let payload = {};
        try { payload = JSON.parse(e.payload_json || '{}'); } catch { /* ignore */ }
        return {
          id: e.id,
          type: e.event_type,
          text: payload.text || payload.result || payload.message || '',
          time: e.created_at,
        };
      })
      .filter(m => m.text);
  }, [events]);

  const handleSend = async () => {
    const text = input.trim();
    if ((!text && attachedImages.length === 0) || sending) return;
    setSending(true);
    setInput('');
    const imagesToSend = attachedImages.map(img => ({ data: img.data, media_type: img.media_type }));
    setAttachedImages([]);
    try {
      await sendMessage(text, imagesToSend.length > 0 ? imagesToSend : undefined);
    } catch { /* toast handled in hook */ }
    setSending(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleStart = async () => {
    try {
      await start({});
    } catch { /* toast handled */ }
  };

  const [inspectRun, setInspectRun] = useState(null);
  const [selectedTask, setSelectedTask] = useState(null);
  const [collapsedProjects, setCollapsedProjects] = useState({});
  const toggleProject = (key) => setCollapsedProjects(prev => ({ ...prev, [key]: !prev[key] }));

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
      { key: 'in_progress', label: 'In Progress', statuses: ['in_progress'] },
      { key: 'todo', label: 'Todo', statuses: ['todo'] },
      { key: 'review', label: 'Review', statuses: ['review'] },
      { key: 'failed', label: 'Failed', statuses: ['failed'] },
      { key: 'backlog', label: 'Backlog', statuses: ['backlog'] },
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

  return html`
    <div class="manager-view">
      <!-- Left: Chat Panel (40%) -->
      <div class="manager-chat-side">
        <div class="manager-chat-header">
          <div class="manager-panel-title">
            <span class="manager-icon">\u2726</span>
            <span>Manager Session</span>
            ${status.active && html`
              <span class="manager-status-badge running">Active</span>
            `}
            ${!status.active && html`
              <span class="manager-status-badge idle">Idle</span>
            `}
          </div>
          <div class="manager-panel-actions">
            ${status.active && status.usage && html`
              <span class="manager-cost">$${(status.usage.costUsd || 0).toFixed(4)}</span>
            `}
            ${status.active && html`
              <button class="btn btn-sm btn-danger" onClick=${stop}>Stop</button>
            `}
          </div>
        </div>

        <div class="manager-messages" ref=${messagesRef}>
          ${!status.active && messages.length === 0 && html`
            <div class="manager-empty">
              <div class="manager-empty-icon">\u2726</div>
              <div class="manager-empty-text">Start a Manager session to orchestrate your agents</div>
              <button class="btn btn-primary" onClick=${handleStart} disabled=${loading}>
                ${loading ? 'Starting...' : 'Start Manager'}
              </button>
            </div>
          `}
          ${messages.map(m => html`
            <div key=${m.id} class="manager-msg ${m.type === 'user_input' ? 'manager-msg-user' : 'manager-msg-assistant'}">
              ${m.type === 'user_input'
                ? html`<div class="manager-msg-content">${m.text}</div>`
                : html`<div class="manager-msg-content markdown-body" dangerouslySetInnerHTML=${{ __html: renderMarkdown(m.text) }}></div>`
              }
              <div class="manager-msg-time">${timeAgo(m.time)}</div>
            </div>
          `)}
        </div>

        ${status.active && html`
          <div class="manager-input-area ${dragOver ? 'drag-over' : ''}"
            onDragOver=${(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave=${() => setDragOver(false)}
            onDrop=${handleDrop}
          >
            ${attachedImages.length > 0 && html`
              <div class="manager-image-previews">
                ${attachedImages.map((img, i) => html`
                  <div key=${i} class="manager-image-preview">
                    <img src=${img.preview} alt=${img.name} />
                    <button class="manager-image-remove" onClick=${() => removeImage(i)} title="Remove">\u00d7</button>
                  </div>
                `)}
              </div>
            `}
            <div class="manager-input-row">
              <input type="file" accept="image/*" multiple hidden ref=${fileInputRef}
                onChange=${(e) => { addImages(e.target.files); e.target.value = ''; }}
              />
              <button class="manager-attach-btn" onClick=${() => fileInputRef.current?.click()} title="Attach image" disabled=${sending}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                  <circle cx="8.5" cy="8.5" r="1.5"/>
                  <polyline points="21 15 16 10 5 21"/>
                </svg>
              </button>
              <textarea
                class="manager-input"
                placeholder="Message the manager..."
                value=${input}
                onInput=${(e) => {
                  setInput(e.target.value);
                  e.target.style.height = 'auto';
                  e.target.style.height = e.target.scrollHeight + 'px';
                }}
                onKeyDown=${handleKeyDown}
                onPaste=${handlePaste}
                rows="1"
                disabled=${sending}
              />
              <button
                class="manager-send-btn"
                onClick=${handleSend}
                disabled=${(!input.trim() && attachedImages.length === 0) || sending}
                title="Send"
              >\u2191</button>
            </div>
          </div>
        `}

        ${!status.active && messages.length > 0 && html`
          <div class="manager-input-row">
            <button class="btn btn-primary" style="width:100%" onClick=${handleStart} disabled=${loading}>
              ${loading ? 'Starting...' : 'Start New Session'}
            </button>
          </div>
        `}
      </div>

      <!-- Right: Task Sessions -->
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
          ${projectGroups.length === 0 && html`
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
              ${!projCollapsed && group.sections.map(sec => html`
                <div class="task-status-section">
                  <div class="task-status-divider">
                    <span class="task-status-divider-dot" style="background:${sec.color}"></span>
                    <span class="task-status-divider-label">${sec.label}</span>
                    <span class="task-status-divider-count">${sec.tasks.length}</span>
                    <span class="task-status-divider-line"></span>
                  </div>
                  ${sec.tasks.map(({ task, runs: taskRuns }) => {
                    const activeRunCount = taskRuns.filter(r => ['running', 'needs_input'].includes(r.status)).length;
                    return html`
                      <div class="task-session-group">
                        <div class="task-session-header">
                          <span class="task-session-title">${task?.title || 'Unassigned Runs'}</span>
                          <span class="task-session-meta">
                            ${taskRuns.length > 0 ? `${taskRuns.length} run${taskRuns.length > 1 ? 's' : ''}` : ''}${activeRunCount > 0 ? ` \u00B7 ${activeRunCount} active` : ''}
                          </span>
                          ${task && html`<button class="task-session-detail-btn" onClick=${(e) => { e.stopPropagation(); setSelectedTask(task); }}>Detail</button>`}
                        </div>
                      </div>
                    `;
                  })}
                </div>
              `)}
            </div>
          `;})}
        </div>
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

// ─────────────────────────────────────────────────────────────────────────────
// Command Palette
// ─────────────────────────────────────────────────────────────────────────────

function CommandPalette({ open, onClose }) {
  const [query, setQuery] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (open && inputRef.current) {
      setQuery('');
      inputRef.current.focus();
    }
  }, [open]);

  if (!open) return null;

  const items = NAV_ITEMS.filter(item =>
    !query || item.label.toLowerCase().includes(query.toLowerCase())
  );

  const handleSelect = (hash) => {
    navigate(hash);
    onClose();
  };

  const [selectedIndex, setSelectedIndex] = useState(0);

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex(i => Math.min(i + 1, items.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex(i => Math.max(i - 1, 0)); return; }
    if (e.key === 'Enter') { e.preventDefault(); if (items[selectedIndex]) handleSelect(items[selectedIndex].hash); return; }
    // Number keys 1-5 only when query is empty (avoid conflict with typing)
    if (!query) {
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= items.length) {
        e.preventDefault();
        handleSelect(items[num - 1].hash);
      }
    }
  };

  return html`
    <div class="modal-overlay" onClick=${onClose}>
      <div class="command-palette" onClick=${e => e.stopPropagation()}>
        <input
          ref=${inputRef}
          class="command-palette-input"
          placeholder="Navigate to... (1-${NAV_ITEMS.length} to jump)"
          value=${query}
          onInput=${e => setQuery(e.target.value)}
          onKeyDown=${handleKeyDown}
        />
        <div class="command-palette-list">
          ${items.map((item, i) => html`
            <button
              key=${item.hash}
              class="command-palette-item ${i === selectedIndex ? 'selected' : ''}"
              onClick=${() => handleSelect(item.hash)}
            >
              <span class="command-palette-icon">${item.icon}</span>
              <span class="command-palette-label">${item.label}</span>
              <span class="command-palette-hint">${i + 1}</span>
            </button>
          `)}
          ${items.length === 0 && html`
            <div class="command-palette-empty">No matching views</div>
          `}
        </div>
      </div>
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
  const { agents, loading: agentsLoading, reload: reloadAgents } = useAgents();
  const { sessions: claudeSessions } = useClaudeSessions();
  const manager = useManager();
  const [inspectRun, setInspectRun] = useState(null);
  const [showPalette, setShowPalette] = useState(false);

  // Helper to look up task title for a run (used in notifications)
  const getRunTaskTitle = useCallback((data) => {
    const taskId = data.task_id || data.taskId;
    if (taskId) {
      const task = tasks.find(t => t.id === taskId);
      if (task) return task.title;
    }
    return data.title || `Run ${(data.id || '').slice(0, 8)}`;
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
      if (data.status === 'needs_input') {
        showBrowserNotification('Agent needs input', getRunTaskTitle(data));
      }
    },
    'run:completed': (data) => {
      debouncedReload('runs', reloadRuns);
      debouncedReload('tasks', reloadTasks);
      const status = data.status || 'completed';
      const title = getRunTaskTitle(data);
      if (status === 'failed') {
        showBrowserNotification('Run failed', title);
      } else {
        showBrowserNotification('Run completed', title);
      }
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
  }, [showPalette, inspectRun]);

  const routeBase = route.split('/')[0];

  const renderView = () => {
    if (routeBase === 'manager') {
      return html`<${ManagerView} manager=${manager} runs=${runs} tasks=${tasks} projects=${projects} />`;
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
    if (routeBase === 'sessions') {
      return html`<${SessionsView} />`;
    }
    if (routeBase === 'projects') {
      if (projectsLoading) return html`<${Loading} />`;
      return html`<${ProjectsView} projects=${projects} tasks=${tasks} runs=${runs} reloadProjects=${reloadProjects} onOpenRun=${(run) => setInspectRun(run)} />`;
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
        onDeleteRun=${async (id) => {
          try {
            await apiFetch('/api/runs/' + id, { method: 'DELETE' });
            reloadRuns();
          } catch (err) { addToast(err.message, 'error'); }
        }}
        claudeSessions=${claudeSessions}
      />
    `;
  };

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
      <${CommandPalette} open=${showPalette} onClose=${() => setShowPalette(false)} />
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
