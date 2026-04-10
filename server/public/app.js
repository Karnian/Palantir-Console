/* global preact, preactHooks, htm, formatDuration, formatTime, timeAgo, renderMarkdown, apiFetch */
/* global dueState, formatDueDate, useNowTick, dueDateMeta */
/* global DashboardView, BoardView, CalendarView, DirectoryPicker, ProjectsView, AgentsView, SessionsView */
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
// New Task Modal
// ─────────────────────────────────────────────────────────────────────────────

function NewTaskModal({ open, onClose, projects, agents, onCreated }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [projectId, setProjectId] = useState('');
  const [priority, setPriority] = useState('medium');
  const [agentProfileId, setAgentProfileId] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [recurrence, setRecurrence] = useState('');
  const [saving, setSaving] = useState(false);
  useEscape(open, onClose);

  // Reset form state when modal opens
  useEffect(() => {
    if (open) {
      setTitle(''); setDescription(''); setProjectId('');
      setPriority('medium'); setAgentProfileId(''); setDueDate(''); setRecurrence('');
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
        due_date: dueDate || undefined,
        recurrence: recurrence || undefined,
      };
      const data = await apiFetch('/api/tasks', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      onCreated(data.task);
      setTitle(''); setDescription(''); setProjectId(''); setPriority('medium'); setAgentProfileId(''); setDueDate(''); setRecurrence('');
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
          <div class="form-field">
            <label class="form-label">Due Date</label>
            <input type="date" class="form-input" value=${dueDate}
              onInput=${e => setDueDate(e.target.value)} />
          </div>
          <div class="form-field">
            <label class="form-label">Recurrence</label>
            <select class="form-select" value=${recurrence}
              onChange=${e => setRecurrence(e.target.value)}
              title="Without a due date, the task simply respawns when marked done">
              <option value="">None</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
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
  // Idempotency guard for commitField. Both the inline-edit input's onBlur AND
  // the modal-body onMouseDown outside-click handler can fire commit for the
  // same edit (e.g. when the click target also steals focus). Without this
  // guard we'd PATCH twice. Cleared when a new edit session starts.
  const committingFieldRef = useRef(null);
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
    // Guard against duplicate commits from blur + outside-click firing in
    // sequence for the same edit session.
    if (committingFieldRef.current === field) return;
    committingFieldRef.current = field;
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
    committingFieldRef.current = field; // prevent any pending blur from re-saving
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
    committingFieldRef.current = null;
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

        <div class="modal-body" style="gap:16px;"
          onMouseDown=${(e) => {
            // Click outside the active inline-edit input commits the change.
            // Native blur doesn't fire when clicking non-focusable whitespace,
            // so we explicitly commit when the click target is outside the
            // editing input. (Other interactive elements still receive their
            // own clicks normally.)
            if (!editingField) return;
            const inEditor = e.target.closest('.task-detail-title-input, .task-detail-desc-input');
            if (!inEditor) commitField(editingField);
          }}>
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
                const statusOpts = ['backlog','todo','in_progress','review','done','failed']
                  .map(s => ({ value: s, label: s.replace('_', ' ') }));
                const priorityOpts = PRIORITY_OPTIONS.map(p => ({ value: p, label: p }));
                const projectOpts = [{ value: '', label: 'None' }, ...projects.map(p => ({ value: p.id, label: p.name }))];
                return html`
                  <div class="task-detail-meta-item">
                    <span class="task-detail-meta-label">Status</span>
                    <${Dropdown}
                      value=${status}
                      options=${statusOpts}
                      ariaLabel="Status"
                      style=${`color:${sc};background:color-mix(in srgb, ${sc} 12%, transparent);border-color:color-mix(in srgb, ${sc} 30%, transparent);`}
                      onChange=${async (v) => {
                        setStatus(v);
                        try { await apiFetch('/api/tasks/' + task.id + '/status', { method: 'PATCH', body: JSON.stringify({ status: v }) }); reloadTasks(); }
                        catch (err) { addToast(err.message, 'error'); }
                      }} />
                  </div>
                  <div class="task-detail-meta-item">
                    <span class="task-detail-meta-label">Priority</span>
                    <${Dropdown}
                      value=${priority}
                      options=${priorityOpts}
                      ariaLabel="Priority"
                      style=${`color:${pc};background:color-mix(in srgb, ${pc} 12%, transparent);border-color:color-mix(in srgb, ${pc} 30%, transparent);`}
                      onChange=${async (v) => {
                        setPriority(v);
                        try { await apiFetch('/api/tasks/' + task.id, { method: 'PATCH', body: JSON.stringify({ priority: v }) }); reloadTasks(); }
                        catch (err) { addToast(err.message, 'error'); }
                      }} />
                  </div>
                  <div class="task-detail-meta-item">
                    <span class="task-detail-meta-label">Project</span>
                    <${Dropdown}
                      value=${projectId}
                      options=${projectOpts}
                      ariaLabel="Project"
                      style="color:var(--accent-light);background:rgba(139,92,246,0.08);border-color:rgba(139,92,246,0.25);"
                      onChange=${async (v) => {
                        setProjectId(v);
                        try { await apiFetch('/api/tasks/' + task.id, { method: 'PATCH', body: JSON.stringify({ project_id: v || null }) }); reloadTasks(); }
                        catch (err) { addToast(err.message, 'error'); }
                      }} />
                  </div>
                `;
              })()}
              <div class="task-detail-meta-item">
                <span class="task-detail-meta-label">Recurrence</span>
                <${Dropdown}
                  value=${task.recurrence || ''}
                  ariaLabel="Recurrence"
                  options=${[
                    { value: '', label: 'None' },
                    { value: 'daily', label: 'Daily' },
                    { value: 'weekly', label: 'Weekly' },
                    { value: 'monthly', label: 'Monthly' },
                  ]}
                  onChange=${async (v) => {
                    const next = v || null;
                    try {
                      await apiFetch('/api/tasks/' + task.id, {
                        method: 'PATCH',
                        body: JSON.stringify({ recurrence: next }),
                      });
                      reloadTasks();
                    } catch (err) { addToast(err.message, 'error'); }
                  }} />
              </div>
              ${(() => {
                const due = dueDateMeta(task);
                const dueColor = due?.state === 'overdue' ? '#ef4444'
                  : due?.state === 'due-soon' ? '#f59e0b'
                  : 'var(--text-secondary)';
                return html`
                  <div class="task-detail-meta-item">
                    <span class="task-detail-meta-label">Due Date</span>
                    <div style="display:flex;align-items:center;gap:6px;">
                      <input type="date" class="form-input inline-date"
                        value=${task.due_date || ''}
                        style="color:${dueColor};border-color:color-mix(in srgb, ${dueColor} 30%, transparent);background:color-mix(in srgb, ${dueColor} 10%, transparent);flex:1;min-width:0;"
                        onChange=${async (e) => {
                          const v = e.target.value || null;
                          try {
                            await apiFetch('/api/tasks/' + task.id, {
                              method: 'PATCH',
                              body: JSON.stringify({ due_date: v }),
                            });
                            reloadTasks();
                          } catch (err) { addToast(err.message, 'error'); }
                        }} />
                      ${task.due_date && html`
                        <button class="ghost" title="Clear due date"
                          style="padding:2px 6px;font-size:11px;"
                          onClick=${async () => {
                            try {
                              await apiFetch('/api/tasks/' + task.id, {
                                method: 'PATCH',
                                body: JSON.stringify({ due_date: null }),
                              });
                              reloadTasks();
                            } catch (err) { addToast(err.message, 'error'); }
                          }}>\u2715</button>
                      `}
                    </div>
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

// Bridge modal components onto window so BoardView.js (ESM) can reference
// them at render time via window.NewTaskModal, window.ExecuteModal, and
// window.TaskDetailPanel. app.js runs after main.js dynamic imports, so
// these are set before any board renders occur.
window.NewTaskModal = NewTaskModal;
window.ExecuteModal = ExecuteModal;
window.TaskDetailPanel = TaskDetailPanel;

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

// v3 Phase 5: tab title pulse for priority alerts (spec §9.8 mandates
// "탭 타이틀 변경" as part of the priority-alert UX on top of OS
// notification). We briefly flip document.title to an alert string so
// an unfocused tab shows the new state in the browser tab strip, then
// restore the original title after a short window OR immediately on
// focus so the user isn't left with a dangling alert after they come
// back. A single-shot global timer is enough — overlapping alerts
// simply reset the window.
let _tabTitleOriginal = null;
let _tabTitleTimer = null;
let _tabTitleFocusHandler = null;
function pulseTabTitle(alertText, durationMs = 20000) {
  if (typeof document === 'undefined') return;
  if (_tabTitleOriginal == null) {
    _tabTitleOriginal = document.title;
  }
  // If the tab is already focused, there's no point flipping the
  // title — the user is here. Skip.
  if (typeof document.hasFocus === 'function' && document.hasFocus()) {
    return;
  }
  document.title = alertText;
  clearTimeout(_tabTitleTimer);
  const restore = () => {
    if (_tabTitleOriginal != null) {
      document.title = _tabTitleOriginal;
      _tabTitleOriginal = null;
    }
    if (_tabTitleFocusHandler) {
      window.removeEventListener('focus', _tabTitleFocusHandler);
      _tabTitleFocusHandler = null;
    }
  };
  _tabTitleTimer = setTimeout(restore, durationMs);
  if (!_tabTitleFocusHandler) {
    _tabTitleFocusHandler = restore;
    window.addEventListener('focus', _tabTitleFocusHandler);
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
