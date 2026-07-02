// ProjectsView + ProjectDetailModal — Projects management view.
// Extracted from server/public/app.js as part of P5-3 (ESM phase 4b).

import { h } from '../../vendor/preact.module.js';
import { useState, useEffect, useMemo, useCallback } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { formatTime } from '../lib/format.js';
import { clickableProps } from '../lib/a11y.js';
import { apiFetch } from '../lib/api.js';
import { addToast, apiFetchWithToast } from '../lib/toast.js';
import {
  COMMON_ACTIONS,
  PROJECTS_LABELS,
  TASK_STATUS_LABELS,
  statusLabel,
} from '../lib/copy.js';
import { EmptyState } from './EmptyState.js';
import { DirectoryPicker } from './BoardView.js';
import { Modal } from './Modal.js';
import { conversationIdMatchesProject } from '../lib/conversationId.js';

// ─────────────────────────────────────────────────────────────────────────────
// Internal constants
// ─────────────────────────────────────────────────────────────────────────────

// Column ids match TASK_STATUS_LABELS keys; the visible label resolves
// through `statusLabel` so the BoardView, ProjectDetailModal, and any
// other status-grouped surface share one source of truth.
const BOARD_COLUMNS = [
  { id: 'backlog' },
  { id: 'todo' },
  { id: 'in_progress' },
  { id: 'failed' },
  { id: 'review' },
  { id: 'done' },
];

// ─────────────────────────────────────────────────────────────────────────────
// ProjectSkillPacks — skill pack bindings for a project (Phase 3-2)
// ─────────────────────────────────────────────────────────────────────────────

function ProjectSkillPacks({ projectId }) {
  const [bindings, setBindings] = useState([]);
  const [allPacks, setAllPacks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addingId, setAddingId] = useState('');
  const [managerActive, setManagerActive] = useState(false);

  const load = useCallback(async () => {
    try {
      const [bRes, pRes] = await Promise.all([
        apiFetch(`/api/projects/${projectId}/skill-packs`),
        apiFetch('/api/skill-packs'),
      ]);
      setBindings(bRes.bindings || []);
      setAllPacks(pRes.skill_packs || []);
      // Check if there's an active PM for this project
      try {
        const mgrRes = await apiFetch('/api/manager/status');
        const pmSlots = (mgrRes.registry || []).filter(s => conversationIdMatchesProject(s.slot, projectId) && s.active);
        setManagerActive(pmSlots.length > 0);
      } catch { setManagerActive(false); }
    } catch (err) { addToast(err.message, 'error'); }
    setLoading(false);
  }, [projectId]);

  useEffect(() => { setLoading(true); load(); }, [projectId]);

  const boundIds = bindings.map(b => b.skill_pack_id);
  const available = allPacks.filter(p => !boundIds.includes(p.id));

  const handleAdd = async () => {
    if (!addingId) return;
    try {
      await apiFetchWithToast(`/api/projects/${projectId}/skill-packs`, {
        method: 'POST', body: JSON.stringify({ skill_pack_id: addingId }),
      });
      setAddingId('');
      load();
    } catch { /* toast */ }
  };

  const handleRemove = async (packId) => {
    try {
      await apiFetchWithToast(`/api/projects/${projectId}/skill-packs/${packId}`, { method: 'DELETE' });
      load();
    } catch { /* toast */ }
  };

  const handleToggleAuto = async (packId, currentAuto) => {
    try {
      await apiFetchWithToast(`/api/projects/${projectId}/skill-packs/${packId}`, {
        method: 'PATCH', body: JSON.stringify({ auto_apply: !currentAuto }),
      });
      load();
    } catch { /* toast */ }
  };

  const handlePriorityChange = async (packId, newPriority) => {
    try {
      await apiFetchWithToast(`/api/projects/${projectId}/skill-packs/${packId}`, {
        method: 'PATCH', body: JSON.stringify({ priority: parseInt(newPriority, 10) || 100 }),
      });
      load();
    } catch { /* toast */ }
  };

  if (loading) return html`<div class="project-skills-section"><span style="font-size:12px;color:var(--text-muted);">${PROJECTS_LABELS.skillPacksLoading}</span></div>`;

  return html`
    <div class="project-skills-section">
      <div class="project-skills-header">
        <span class="project-skills-title">${PROJECTS_LABELS.skillPacksTitle} (${bindings.length})</span>
      </div>
      ${bindings.map(b => {
        const pack = allPacks.find(p => p.id === b.skill_pack_id);
        const name = pack ? pack.name : b.skill_pack_id.slice(0, 8);
        return html`
          <div class="project-skill-item" key=${b.skill_pack_id}>
            <span class="project-skill-name">${pack?.icon || '\u2662'} ${name}</span>
            <button class="ghost small project-skill-auto ${b.auto_apply ? 'on' : 'off'}"
              onClick=${() => handleToggleAuto(b.skill_pack_id, b.auto_apply)}
              title=${managerActive && !b.auto_apply ? PROJECTS_LABELS.skillPackAutoToggleHint : ''}>
              ${b.auto_apply ? PROJECTS_LABELS.skillPackAuto : PROJECTS_LABELS.skillPackManual}
            </button>
            <input type="number" class="form-input" style=${{ width: '60px', padding: '2px 6px', fontSize: '11px' }}
              value=${b.priority ?? 100}
              onChange=${e => handlePriorityChange(b.skill_pack_id, e.target.value)}
              title=${PROJECTS_LABELS.skillPackPriorityTitle} />
            <button class="ghost small danger-text" onClick=${() => handleRemove(b.skill_pack_id)}>\u2715</button>
          </div>
          ${managerActive && b.auto_apply === 0 && html`
            <!-- Only show warning when toggling auto_apply ON while PM is active -->
          `}
        `;
      })}
      ${available.length > 0 && html`
        <div class="form-row" style=${{ gap: '6px', marginTop: '8px' }}>
          <select class="form-select" style=${{ flex: 1, fontSize: '12px' }} value=${addingId}
            onChange=${e => setAddingId(e.target.value)}>
            <option value="">${PROJECTS_LABELS.skillPackAddOption}</option>
            ${available.map(p => html`<option key=${p.id} value=${p.id}>${p.icon || '\u2662'} ${p.name} (${p.scope})</option>`)}
          </select>
          <button class="ghost small" onClick=${handleAdd} disabled=${!addingId}>${PROJECTS_LABELS.skillPackAddBtn}</button>
        </div>
      `}
      ${managerActive && html`
        <div style=${{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
          ${PROJECTS_LABELS.skillPackPmActiveWarning}
        </div>
      `}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// ProjectDetailModal — internal, not exported
// ─────────────────────────────────────────────────────────────────────────────

function ProjectDetailModal({ project, tasks, runs, onClose, onOpenRun, onOpenTask }) {
  // NOTE: all hooks MUST run on every render regardless of `project`. If we
  // early-return when project is null before the useMemo below, React/Preact
  // sees a different hook order between renders (rules-of-hooks). So filter
  // with an empty-array guard and only branch the render at the end.
  const projectTasks = project
    ? tasks.filter(t => t.project_id === project.id)
    : [];
  const projectRuns = project
    ? runs.filter(r => projectTasks.some(t => t.id === r.task_id))
    : [];

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

  if (!project) return null;

  const statusColor = {
    backlog: 'var(--status-queued)', todo: 'var(--info)', in_progress: 'var(--accent)',
    review: 'var(--status-review)', done: 'var(--success)', failed: 'var(--status-failed)',
  };

  const activeGroups = BOARD_COLUMNS.filter(col => (statusGroups[col.id] || []).length > 0);

  // Stats
  const activeTasks = projectTasks.filter(t => t.status === 'in_progress').length;
  const doneTasks = projectTasks.filter(t => t.status === 'done').length;
  const activeRuns = projectRuns.filter(r => r.status === 'running').length;

  return html`
    <${Modal} open=${!!project} onClose=${onClose} labelledBy="project-detail-title" wide panelClass="project-detail-panel">
      <div class="modal-header">
        <h2 class="modal-title" id="project-detail-title" style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:16px;">\u25A3</span>
          ${PROJECTS_LABELS.detailTitle}
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
                <span class="task-detail-meta-label">${PROJECTS_LABELS.directoryLabel}</span>
                <span style="color:var(--text-secondary);font-size:12px;word-break:break-all;" title=${project.directory}>${project.directory}</span>
              </div>
            `}
            ${project.mcp_config_path && html`
              <div class="task-detail-meta-item">
                <span class="task-detail-meta-label">${PROJECTS_LABELS.mcpConfigLabel}</span>
                <span style="color:var(--text-secondary);font-size:12px;word-break:break-all;" title=${project.mcp_config_path}>${project.mcp_config_path}</span>
              </div>
            `}
            ${project.test_command && html`
              <div class="task-detail-meta-item">
                <span class="task-detail-meta-label">${PROJECTS_LABELS.testCommandLabel}</span>
                <span style="color:var(--text-secondary);font-size:12px;word-break:break-all;" title=${project.test_command}>${project.test_command}</span>
              </div>
            `}
            <div class="task-detail-meta-item">
              <span class="task-detail-meta-label">${PROJECTS_LABELS.tasksLabel}</span>
              <span style="color:var(--text-secondary);font-size:12px;">${projectTasks.length}${PROJECTS_LABELS.totalSuffix}</span>
            </div>
            <div class="task-detail-meta-item">
              <span class="task-detail-meta-label">${PROJECTS_LABELS.activeDoneLabel}</span>
              <span style="color:var(--text-secondary);font-size:12px;">${activeTasks} / ${doneTasks}</span>
            </div>
            <div class="task-detail-meta-item">
              <span class="task-detail-meta-label">${PROJECTS_LABELS.runsLabel}</span>
              <span style="color:var(--text-secondary);font-size:12px;">${projectRuns.length}${PROJECTS_LABELS.runsTotalSuffix}${activeRuns > 0 ? ` (${activeRuns} ${PROJECTS_LABELS.runsRunningPrefix})` : ''}</span>
            </div>
            <div class="task-detail-meta-item">
              <span class="task-detail-meta-label">${PROJECTS_LABELS.createdLabel}</span>
              <span style="color:var(--text-secondary);font-size:12px;">${formatTime(project.created_at)}</span>
            </div>
          </div>

          <div class="project-detail-tasks">
            <div class="task-detail-section-title">${PROJECTS_LABELS.tasksSection} (${projectTasks.length})</div>
            ${projectTasks.length === 0 && html`
              <div style="color:var(--text-muted);font-size:13px;padding:12px 0;">${PROJECTS_LABELS.noTasks}</div>
            `}
            ${activeGroups.map(col => {
              const groupTasks = statusGroups[col.id];
              const sc = statusColor[col.id] || 'var(--text-muted)';
              return html`
                <div key=${col.id} class="project-task-group">
                  <div class="project-task-group-header">
                    <span class="project-task-status-dot" style="background:${sc};"></span>
                    <span class="project-task-status-label" style="color:${sc};">${statusLabel(TASK_STATUS_LABELS, col.id)}</span>
                    <span class="project-task-status-count">${groupTasks.length}</span>
                  </div>
                  <div class="project-task-group-list">
                    ${groupTasks.map(t => {
                      const taskRuns = runs.filter(r => r.task_id === t.id);
                      const runCount = taskRuns.length;
                      return html`
                        <div key=${t.id} class="project-task-item clickable"
                          role="button" tabindex="0"
                          onClick=${() => { if (onOpenTask) onOpenTask(t); }}
                          onKeyDown=${(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              if (onOpenTask) onOpenTask(t);
                            }
                          }}>
                          <span class="project-task-item-title">${t.title}</span>
                          <span class="project-task-item-right">
                            ${runCount > 0 && html`<span class="project-task-run-count">${runCount}${PROJECTS_LABELS.runSingular}</span>`}
                          </span>
                        </div>
                      `;
                    })}
                  </div>
                </div>
              `;
            })}
          </div>

          <${ProjectSkillPacks} projectId=${project.id} />
        </div>
    </Modal>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// ProjectsView — exported
// ─────────────────────────────────────────────────────────────────────────────

export function ProjectsView({ projects, tasks, runs, reloadProjects, onOpenRun, onOpenTask }) {
  const [showNew, setShowNew] = useState(false);
  const [detailProject, setDetailProject] = useState(null);
  const [editProject, setEditProject] = useState(null);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [dir, setDir] = useState('');
  const [mcpConfigPath, setMcpConfigPath] = useState('');
  const [testCommand, setTestCommand] = useState('');
  const [saving, setSaving] = useState(false);

  // Edit modal state
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editDir, setEditDir] = useState('');
  const [editMcpConfigPath, setEditMcpConfigPath] = useState('');
  const [editTestCommand, setEditTestCommand] = useState('');
  const [editSaving, setEditSaving] = useState(false);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await apiFetch('/api/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          description: desc.trim() || undefined,
          directory: dir.trim() || undefined,
          mcp_config_path: mcpConfigPath.trim() || undefined,
          test_command: testCommand.trim() || undefined,
        }),
      });
      setName(''); setDesc(''); setDir(''); setMcpConfigPath(''); setTestCommand(''); setShowNew(false);
      reloadProjects();
    } catch (err) {
      addToast(err.message, 'error');
    }
    setSaving(false);
  };

  const openEdit = (p) => {
    setEditProject(p);
    setEditName(p.name || '');
    setEditDesc(p.description || '');
    setEditDir(p.directory || '');
    setEditMcpConfigPath(p.mcp_config_path || '');
    setEditTestCommand(p.test_command || '');
  };

  const handleUpdate = async () => {
    if (!editProject || !editName.trim()) return;
    setEditSaving(true);
    try {
      await apiFetch(`/api/projects/${editProject.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editName.trim(),
          description: editDesc.trim() || null,
          directory: editDir.trim() || null,
          mcp_config_path: editMcpConfigPath.trim() || null,
          test_command: editTestCommand.trim() || null,
        }),
      });
      setEditProject(null);
      reloadProjects();
    } catch (err) {
      addToast(err.message, 'error');
    }
    setEditSaving(false);
  };

  // Keep detailProject in sync with latest data
  const currentDetailProject = detailProject ? projects.find(p => p.id === detailProject.id) || detailProject : null;

  return html`
    <div class="projects-view" data-view="projects">
      <div class="projects-header">
        <h1 class="projects-title">${PROJECTS_LABELS.pageTitle}</h1>
        <button class="primary" onClick=${() => setShowNew(true)}>+ ${PROJECTS_LABELS.newProject}</button>
      </div>
      <div class="projects-list">
        ${projects.length === 0 && html`
          <${EmptyState}
            icon="\u25A3"
            text=${PROJECTS_LABELS.emptyText}
            sub=${PROJECTS_LABELS.emptySub}
          />
        `}
        ${projects.map(p => {
          const taskCount = tasks.filter(t => t.project_id === p.id).length;
          return html`
            <article key=${p.id} class="project-card">
              <button class="project-card-trigger" onClick=${() => setDetailProject(p)}
                aria-label=${p.name}>
                <span class="project-card-header">
                  <span class="project-card-title">${p.name}</span>
                  ${taskCount > 0 && html`<span class="project-card-task-count">${taskCount}${PROJECTS_LABELS.taskWord}</span>`}
                </span>
                ${p.directory && html`<span class="project-card-dir" title=${p.directory}>\u{1F4C1} ${p.directory}</span>`}
                ${p.description && html`<span class="project-card-desc">${p.description}</span>`}
                <span class="project-card-meta">${PROJECTS_LABELS.createdLabel} ${formatTime(p.created_at)}</span>
              </button>
              <div class="project-card-actions" style="margin-top:8px;">
                <button class="ghost small" onClick=${() => openEdit(p)}>${COMMON_ACTIONS.edit}</button>
              </div>
            </article>
          `;
        })}
      </div>
      <${Modal} open=${showNew} onClose=${() => setShowNew(false)} labelledBy="new-project-title">
        <div class="modal-header">
          <h2 class="modal-title" id="new-project-title">${PROJECTS_LABELS.modalNew}</h2>
          <button class="ghost" onClick=${() => setShowNew(false)}>${COMMON_ACTIONS.close}</button>
        </div>
        <div class="modal-body">
          <div class="form-field">
            <label class="form-label" for="new-project-name">${PROJECTS_LABELS.fieldName}</label>
            <input id="new-project-name" class="form-input" value=${name} onInput=${e => setName(e.target.value)} placeholder=${PROJECTS_LABELS.namePlaceholder} />
          </div>
          <${DirectoryPicker} value=${dir} onSelect=${setDir} />
          <div class="form-field">
            <label class="form-label" for="new-project-desc">${PROJECTS_LABELS.fieldDescription}</label>
            <textarea id="new-project-desc" class="form-textarea" value=${desc} onInput=${e => setDesc(e.target.value)} placeholder=${PROJECTS_LABELS.descriptionPlaceholder} rows="3"></textarea>
          </div>
          <div class="form-field">
            <label class="form-label" for="new-project-mcp">${PROJECTS_LABELS.fieldMcpConfigPath}</label>
            <input id="new-project-mcp" class="form-input" value=${mcpConfigPath} onInput=${e => setMcpConfigPath(e.target.value)} placeholder=${PROJECTS_LABELS.mcpConfigPathPlaceholder} />
            <div style="color:var(--text-muted);font-size:11px;margin-top:2px;">${PROJECTS_LABELS.mcpConfigPathHint}</div>
          </div>
          <div class="form-field">
            <label class="form-label" for="new-project-test-command">${PROJECTS_LABELS.fieldTestCommand}</label>
            <input
              id="new-project-test-command"
              data-testid="project-test-command-input"
              class="form-input"
              value=${testCommand}
              onInput=${e => setTestCommand(e.target.value)}
              placeholder=${PROJECTS_LABELS.testCommandPlaceholder}
              maxlength="500"
            />
            <div style="color:var(--text-muted);font-size:11px;margin-top:2px;">${PROJECTS_LABELS.testCommandHint}</div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="ghost" onClick=${() => setShowNew(false)}>${COMMON_ACTIONS.cancel}</button>
          <button class="primary" onClick=${handleCreate} disabled=${saving || !name.trim()}>
            ${saving ? PROJECTS_LABELS.creating : COMMON_ACTIONS.create}
          </button>
        </div>
      </Modal>
      <${Modal} open=${!!editProject} onClose=${() => setEditProject(null)} labelledBy="edit-project-title">
        <div class="modal-header">
          <h2 class="modal-title" id="edit-project-title">${PROJECTS_LABELS.modalEdit}</h2>
          <button class="ghost" onClick=${() => setEditProject(null)}>${COMMON_ACTIONS.close}</button>
        </div>
        <div class="modal-body">
          <div class="form-field">
            <label class="form-label" for="edit-project-name">${PROJECTS_LABELS.fieldName}</label>
            <input id="edit-project-name" class="form-input" value=${editName} onInput=${e => setEditName(e.target.value)} placeholder=${PROJECTS_LABELS.namePlaceholder} />
          </div>
          <${DirectoryPicker} value=${editDir} onSelect=${setEditDir} />
          <div class="form-field">
            <label class="form-label" for="edit-project-desc">${PROJECTS_LABELS.fieldDescription}</label>
            <textarea id="edit-project-desc" class="form-textarea" value=${editDesc} onInput=${e => setEditDesc(e.target.value)} placeholder=${PROJECTS_LABELS.descriptionPlaceholder} rows="3"></textarea>
          </div>
          <div class="form-field">
            <label class="form-label" for="edit-project-mcp">${PROJECTS_LABELS.fieldMcpConfigPath}</label>
            <input id="edit-project-mcp" class="form-input" value=${editMcpConfigPath} onInput=${e => setEditMcpConfigPath(e.target.value)} placeholder=${PROJECTS_LABELS.mcpConfigPathPlaceholder} />
            <div style="color:var(--text-muted);font-size:11px;margin-top:2px;">${PROJECTS_LABELS.mcpConfigPathHint}</div>
          </div>
          <div class="form-field">
            <label class="form-label" for="edit-project-test-command">${PROJECTS_LABELS.fieldTestCommand}</label>
            <input
              id="edit-project-test-command"
              data-testid="project-test-command-input"
              class="form-input"
              value=${editTestCommand}
              onInput=${e => setEditTestCommand(e.target.value)}
              placeholder=${PROJECTS_LABELS.testCommandPlaceholder}
              maxlength="500"
            />
            <div style="color:var(--text-muted);font-size:11px;margin-top:2px;">${PROJECTS_LABELS.testCommandHint}</div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="ghost" onClick=${() => setEditProject(null)}>${COMMON_ACTIONS.cancel}</button>
          <button class="primary" onClick=${handleUpdate} disabled=${editSaving || !editName.trim()}>
            ${editSaving ? PROJECTS_LABELS.saving : COMMON_ACTIONS.save}
          </button>
        </div>
      </Modal>
      ${currentDetailProject && html`
        <${ProjectDetailModal}
          project=${currentDetailProject}
          tasks=${tasks}
          runs=${runs}
          onClose=${() => setDetailProject(null)}
          onOpenRun=${onOpenRun}
          onOpenTask=${onOpenTask}
        />
      `}
    </div>
  `;
}
