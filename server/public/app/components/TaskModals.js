// TaskModals.js — NewTaskModal + ExecuteModal + TaskDetailPanel.
// Extracted from server/public/app.js as part of P7-1 (ESM phase 6).
//
// Dependencies (all bridged onto window by main.js before this module loads):
//   - window.preact, window.preactHooks, window.htm
//   - window.apiFetch          (from app/lib/api.js)
//   - window.addToast          (from app/lib/toast.js)
//   - window.useEscape         (from app/lib/hooks.js)
//   - window.formatTime        (from app/lib/format.js)
//   - window.timeAgo           (from app/lib/format.js)
//   - window.dueDateMeta       (from app/components/DashboardView.js)
//   - window.Dropdown          (from app/components/Dropdown.js)

const { h } = window.preact;
const { useState, useEffect, useRef } = window.preactHooks;
const html = window.htm.bind(h);

// ─────────────────────────────────────────────────────────────────────────────
// New Task Modal
// ─────────────────────────────────────────────────────────────────────────────

export function NewTaskModal({ open, onClose, projects, agents, onCreated }) {
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

export function ExecuteModal({ open, task, agents, onClose, onExecute }) {
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

export function TaskDetailPanel({ task, onClose, projects, agents, runs, onOpenRun, onExecute, reloadTasks }) {
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
