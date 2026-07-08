// ProjectsView + ProjectDetailModal — Projects management view.
// Extracted from server/public/app.js as part of P5-3 (ESM phase 4b).

import { h } from '../../vendor/preact.module.js';
import { useState, useEffect, useMemo, useCallback, useRef } from '../../vendor/hooks.module.js';
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

const SOURCE_TYPE_GIT = 'git';
const SOURCE_TYPE_LEGACY = 'legacy_directory';
const MCP_SOURCE_CONTROL_PLANE = 'legacy_control_plane_path';
const MCP_SOURCE_REPO_RELPATH = 'repo_relpath';

function projectNodeValue(project) {
  return project?.node_id && project.node_id !== 'local' ? project.node_id : '';
}

function queueNodeIdValue(value) {
  const normalized = String(value || '').trim();
  return normalized || 'local';
}

function nodeReachable(node) {
  return node?.reachable === true || Number(node?.reachable) === 1;
}

function projectSourceType(project) {
  if (project?.source_type === SOURCE_TYPE_GIT) return SOURCE_TYPE_GIT;
  return SOURCE_TYPE_LEGACY;
}

function normalizeMcpConfigSource(value) {
  return value === MCP_SOURCE_REPO_RELPATH ? MCP_SOURCE_REPO_RELPATH : MCP_SOURCE_CONTROL_PLANE;
}

function putTrimmed(body, key, value, { clear = false, fallback = null } = {}) {
  const trimmed = String(value || '').trim();
  if (trimmed) {
    body[key] = trimmed;
  } else if (fallback !== null) {
    body[key] = fallback;
  } else if (clear) {
    body[key] = null;
  }
}

function applyProjectSourceBody(body, values, { clear = false } = {}) {
  const sourceType = values.sourceType === SOURCE_TYPE_LEGACY ? SOURCE_TYPE_LEGACY : SOURCE_TYPE_GIT;
  body.source_type = sourceType;

  if (sourceType === SOURCE_TYPE_GIT) {
    body.repo_url = String(values.repoUrl || '').trim();
    putTrimmed(body, 'repo_ref', values.repoRef, { fallback: 'HEAD' });
    putTrimmed(body, 'repo_subdir', values.repoSubdir, { clear });
    if (clear) {
      body.directory = null;
      body.allow_non_git_dir = null;
    }
    body.mcp_config_source = normalizeMcpConfigSource(values.mcpConfigSource);
    if (body.mcp_config_source === MCP_SOURCE_REPO_RELPATH) {
      putTrimmed(body, 'mcp_config_relpath', values.mcpConfigRelpath, { clear });
      if (clear) body.mcp_config_path = null;
    } else {
      putTrimmed(body, 'mcp_config_path', values.mcpConfigPath, { clear });
      if (clear) body.mcp_config_relpath = null;
    }
    return body;
  }

  putTrimmed(body, 'directory', values.dir, { clear });
  putTrimmed(body, 'mcp_config_path', values.mcpConfigPath, { clear });
  body.allow_non_git_dir = values.allowNonGitDir ? 1 : 0;
  if (clear) {
    body.repo_url = null;
    body.repo_ref = null;
    body.repo_subdir = null;
    body.mcp_config_source = MCP_SOURCE_CONTROL_PLANE;
    body.mcp_config_relpath = null;
  }
  return body;
}

function repoPreflightMessage(err) {
  const status = Number(err?.status || err?.statusCode || err?.httpStatus || 0);
  const reason = err?.reason || err?.data?.reason || err?.body?.reason;
  if (status !== 400 || !reason) return null;
  return PROJECTS_LABELS.repoPreflightReasonLabels?.[reason] || null;
}

function hasRepoPreflightReason(err) {
  return Boolean(err?.reason || err?.data?.reason || err?.body?.reason);
}

function operatorWarmErrorMessage(err) {
  const status = Number(err?.status || err?.statusCode || err?.httpStatus || 0);
  if (status === 409) return PROJECTS_LABELS.operatorWarmConflictError;
  if (status === 400) return PROJECTS_LABELS.operatorWarmAuthError;
  if (status === 502) return PROJECTS_LABELS.operatorWarmSpawnFailedError;
  return err?.message || PROJECTS_LABELS.operatorWarmDefaultError;
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function operatorRefRoleLabel(role) {
  return role === 'primary'
    ? PROJECTS_LABELS.operatorPrimaryRole
    : PROJECTS_LABELS.operatorReferenceRole;
}

function shortOperatorInstanceId(id) {
  const value = String(id || '');
  return value.length > 12 ? `${value.slice(0, 12)}...` : value;
}

function buildOperatorWatchersByProject(instances) {
  const map = new Map();
  for (const instance of arrayValue(instances)) {
    for (const ref of arrayValue(instance?.refs)) {
      if (!ref?.project_id) continue;
      const key = String(ref.project_id);
      const next = map.get(key) || [];
      next.push({
        instanceId: instance.id,
        role: ref.role,
      });
      map.set(key, next);
    }
  }
  for (const watchers of map.values()) {
    watchers.sort((a, b) => {
      if (a.role !== b.role) return a.role === 'primary' ? -1 : 1;
      return String(a.instanceId || '').localeCompare(String(b.instanceId || ''));
    });
  }
  return map;
}

function projectLocationText(project) {
  if (projectSourceType(project) === SOURCE_TYPE_GIT) {
    const ref = project.repo_ref || 'HEAD';
    const subdir = project.repo_subdir ? ` ${PROJECTS_LABELS.repoSubdirCardPrefix}${project.repo_subdir}` : '';
    return `${project.repo_url || ''} @ ${ref}${subdir}`.trim();
  }
  return project.directory || '';
}

function nodeOptionLabel(node) {
  const maxConcurrent = Number(node.max_concurrent || 0);
  const running = Number(node.running_count ?? node.active_count ?? node.running ?? 0);
  const available = maxConcurrent > 0 ? Math.max(0, maxConcurrent - running) : null;
  const slotLabel = available === null ? '-' : `${available}/${maxConcurrent}`;
  return `${nodeReachable(node) ? '●' : '○'} ${node.name} (${node.id}) · 슬롯 ${slotLabel}`;
}

function ProjectNodeSelect({ id, value, onChange, nodes, loading }) {
  const selectedMissing = value && !nodes.some(n => n.id === value);
  const selectedNode = value ? nodes.find(n => n.id === value) : null;
  const selectedUnreachable = selectedNode && !nodeReachable(selectedNode);
  // Only offer nodes that can actually host execution — projectService
  // rejects can_execute!=1 / files_only=1 bindings with a 400 anyway
  // (Codex P1c review NIT: don't offer invalid choices).
  const remoteNodes = nodes.filter(node => node.id !== 'local'
    && Number(node.can_execute) === 1
    && Number(node.files_only) !== 1);
  return html`
    <div>
      <select
        id=${id}
        class="form-select"
        value=${value}
        onChange=${e => onChange(e.target.value)}
        disabled=${loading}
      >
        <option value="">${loading ? PROJECTS_LABELS.nodeSelectLoading : PROJECTS_LABELS.nodeDefaultOption}</option>
        ${selectedMissing && html`<option value=${value}>${value}</option>`}
        ${remoteNodes.map(node => html`
          <option key=${node.id} value=${node.id}>
            ${nodeOptionLabel(node)}
          </option>
        `)}
      </select>
      ${selectedUnreachable && html`
        <div
          data-role="project-node-warning"
          style="color:var(--warning, var(--text-muted));font-size:11px;margin-top:4px;"
        >
          ${PROJECTS_LABELS.nodeUnreachableWarning}
        </div>
      `}
    </div>
  `;
}

function SourceTypeToggle({ id, value, onChange }) {
  return html`
    <div class="form-field">
      <label class="form-label" for=${id}>${PROJECTS_LABELS.sourceTypeLabel}</label>
      <select
        id=${id}
        class="form-select"
        data-role="project-source-toggle"
        value=${value}
        onChange=${e => onChange(e.target.value === SOURCE_TYPE_LEGACY ? SOURCE_TYPE_LEGACY : SOURCE_TYPE_GIT)}
      >
        <option value=${SOURCE_TYPE_GIT}>${PROJECTS_LABELS.sourceTypeGit}</option>
        <option value=${SOURCE_TYPE_LEGACY}>${PROJECTS_LABELS.sourceTypeLegacy}</option>
      </select>
    </div>
  `;
}

function GitSourceFields({
  prefix,
  repoUrl,
  repoRef,
  repoSubdir,
  onRepoUrl,
  onRepoRef,
  onRepoSubdir,
}) {
  return html`
    <div class="form-field">
      <label class="form-label" for="${prefix}-project-repo-url">${PROJECTS_LABELS.repoUrlLabel}</label>
      <input
        id="${prefix}-project-repo-url"
        class="form-input"
        data-role="project-repo-url"
        value=${repoUrl}
        onInput=${e => onRepoUrl(e.target.value)}
        placeholder=${PROJECTS_LABELS.repoUrlPlaceholder}
        required
      />
    </div>
    <div class="form-field">
      <label class="form-label" for="${prefix}-project-repo-ref">${PROJECTS_LABELS.repoRefLabel}</label>
      <input
        id="${prefix}-project-repo-ref"
        class="form-input"
        data-role="project-repo-ref"
        value=${repoRef}
        onInput=${e => onRepoRef(e.target.value)}
        placeholder="HEAD"
      />
    </div>
    <div class="form-field">
      <label class="form-label" for="${prefix}-project-repo-subdir">${PROJECTS_LABELS.repoSubdirLabel}</label>
      <input
        id="${prefix}-project-repo-subdir"
        class="form-input"
        data-role="project-repo-subdir"
        value=${repoSubdir}
        onInput=${e => onRepoSubdir(e.target.value)}
        placeholder=${PROJECTS_LABELS.repoSubdirPlaceholder}
      />
    </div>
  `;
}

function McpSourceFields({
  prefix,
  mcpConfigSource,
  mcpConfigPath,
  mcpConfigRelpath,
  onMcpConfigSource,
  onMcpConfigPath,
  onMcpConfigRelpath,
}) {
  const normalizedSource = normalizeMcpConfigSource(mcpConfigSource);
  return html`
    <div class="form-field">
      <label class="form-label" for="${prefix}-project-mcp-source">${PROJECTS_LABELS.mcpConfigSourceLabel}</label>
      <select
        id="${prefix}-project-mcp-source"
        class="form-select"
        data-role="project-mcp-source"
        value=${normalizedSource}
        onChange=${e => onMcpConfigSource(normalizeMcpConfigSource(e.target.value))}
      >
        <option value=${MCP_SOURCE_CONTROL_PLANE}>${PROJECTS_LABELS.mcpConfigControlPlaneOption}</option>
        <option value=${MCP_SOURCE_REPO_RELPATH}>${PROJECTS_LABELS.mcpConfigRepoRelpathOption}</option>
      </select>
    </div>
    ${normalizedSource === MCP_SOURCE_REPO_RELPATH
      ? html`
        <div class="form-field">
          <label class="form-label" for="${prefix}-project-mcp-relpath">${PROJECTS_LABELS.mcpConfigRelpathLabel}</label>
          <input
            id="${prefix}-project-mcp-relpath"
            class="form-input"
            data-role="project-mcp-config-relpath"
            value=${mcpConfigRelpath}
            onInput=${e => onMcpConfigRelpath(e.target.value)}
            placeholder=${PROJECTS_LABELS.mcpConfigRelpathPlaceholder}
          />
          <div style="color:var(--text-muted);font-size:11px;margin-top:2px;">${PROJECTS_LABELS.mcpConfigRelpathHint}</div>
        </div>
      `
      : html`
        <div class="form-field">
          <label class="form-label" for="${prefix}-project-mcp">${PROJECTS_LABELS.fieldMcpConfigPath}</label>
          <input
            id="${prefix}-project-mcp"
            class="form-input"
            data-role="project-mcp-config-path"
            value=${mcpConfigPath}
            onInput=${e => onMcpConfigPath(e.target.value)}
            placeholder=${PROJECTS_LABELS.mcpConfigPathPlaceholder}
          />
          <div style="color:var(--text-muted);font-size:11px;margin-top:2px;">${PROJECTS_LABELS.mcpConfigPathHint}</div>
        </div>
      `}
  `;
}

function LegacySourceFields({
  prefix,
  dir,
  allowNonGitDir,
  mcpConfigPath,
  onDir,
  onAllowNonGitDir,
  onMcpConfigPath,
}) {
  return html`
    <details class="form-field" data-role="project-legacy-source">
      <summary class="form-label">${PROJECTS_LABELS.legacyDirectorySectionLabel}</summary>
      <div data-role="project-legacy-directory" style="margin-top:8px;">
        <${DirectoryPicker} value=${dir} onSelect=${onDir} />
      </div>
      <div class="form-field">
        <label class="form-label" for="${prefix}-project-mcp">${PROJECTS_LABELS.fieldMcpConfigPath}</label>
        <input
          id="${prefix}-project-mcp"
          class="form-input"
          data-role="project-mcp-config-path"
          value=${mcpConfigPath}
          onInput=${e => onMcpConfigPath(e.target.value)}
          placeholder=${PROJECTS_LABELS.mcpConfigPathPlaceholder}
        />
        <div style="color:var(--text-muted);font-size:11px;margin-top:2px;">${PROJECTS_LABELS.mcpConfigPathHint}</div>
      </div>
      <div class="form-field">
        <label style=${{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <input
            id="${prefix}-project-allow-non-git-dir"
            type="checkbox"
            checked=${allowNonGitDir}
            onChange=${e => onAllowNonGitDir(e.target.checked)}
          />
          <span>${PROJECTS_LABELS.allowNonGitDirLabel}</span>
        </label>
        <div style="color:var(--text-muted);font-size:11px;margin-top:2px;">${PROJECTS_LABELS.allowNonGitDirHint}</div>
      </div>
    </details>
  `;
}

function isRebindResetConflict(err) {
  const status = err?.status || err?.statusCode || err?.httpStatus;
  const message = String(err?.message || err?.error || '');
  return Number(status) === 409 && message.includes('reset the operator');
}

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
      // Check if there's an active Operator for this project.
      try {
        const mgrRes = await apiFetch('/api/manager/status');
        const managerActive = (mgrRes.pms || []).some(p =>
          conversationIdMatchesProject(p.conversationId, projectId) &&
          p.run &&
          p.run.status === 'running'
        );
        setManagerActive(managerActive);
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
            ${projectSourceType(project) === SOURCE_TYPE_GIT && project.repo_url && html`
              <div class="task-detail-meta-item">
                <span class="task-detail-meta-label">${PROJECTS_LABELS.repoUrlLabel}</span>
                <span style="color:var(--text-secondary);font-size:12px;word-break:break-all;" title=${project.repo_url}>${project.repo_url}</span>
              </div>
            `}
            ${projectSourceType(project) === SOURCE_TYPE_GIT && html`
              <div class="task-detail-meta-item">
                <span class="task-detail-meta-label">${PROJECTS_LABELS.repoRefLabel}</span>
                <span style="color:var(--text-secondary);font-size:12px;word-break:break-all;">${project.repo_ref || 'HEAD'}</span>
              </div>
            `}
            ${projectSourceType(project) === SOURCE_TYPE_GIT && project.repo_subdir && html`
              <div class="task-detail-meta-item">
                <span class="task-detail-meta-label">${PROJECTS_LABELS.repoSubdirLabel}</span>
                <span style="color:var(--text-secondary);font-size:12px;word-break:break-all;" title=${project.repo_subdir}>${project.repo_subdir}</span>
              </div>
            `}
            ${projectSourceType(project) === SOURCE_TYPE_LEGACY && project.directory && html`
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
            ${project.mcp_config_relpath && html`
              <div class="task-detail-meta-item">
                <span class="task-detail-meta-label">${PROJECTS_LABELS.mcpConfigRelpathLabel}</span>
                <span style="color:var(--text-secondary);font-size:12px;word-break:break-all;" title=${project.mcp_config_relpath}>${project.mcp_config_relpath}</span>
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

export function ProjectsView({ projects, tasks, runs, reloadProjects, onOpenRun, onOpenTask, highlightProjectId = null }) {
  const [showNew, setShowNew] = useState(false);
  const [detailProject, setDetailProject] = useState(null);
  const [editProject, setEditProject] = useState(null);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [sourceType, setSourceType] = useState(SOURCE_TYPE_GIT);
  const [repoUrl, setRepoUrl] = useState('');
  const [repoRef, setRepoRef] = useState('');
  const [repoSubdir, setRepoSubdir] = useState('');
  const [dir, setDir] = useState('');
  const [mcpConfigSource, setMcpConfigSource] = useState(MCP_SOURCE_CONTROL_PLANE);
  const [mcpConfigPath, setMcpConfigPath] = useState('');
  const [mcpConfigRelpath, setMcpConfigRelpath] = useState('');
  const [testCommand, setTestCommand] = useState('');
  const [nodeId, setNodeId] = useState('');
  const [allowNonGitDir, setAllowNonGitDir] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nodes, setNodes] = useState([]);
  const [nodesLoading, setNodesLoading] = useState(true);
  const [operatorInstances, setOperatorInstances] = useState([]);

  // Edit modal state
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editSourceType, setEditSourceType] = useState(SOURCE_TYPE_GIT);
  const [editRepoUrl, setEditRepoUrl] = useState('');
  const [editRepoRef, setEditRepoRef] = useState('');
  const [editRepoSubdir, setEditRepoSubdir] = useState('');
  const [editDir, setEditDir] = useState('');
  const [editMcpConfigSource, setEditMcpConfigSource] = useState(MCP_SOURCE_CONTROL_PLANE);
  const [editMcpConfigPath, setEditMcpConfigPath] = useState('');
  const [editMcpConfigRelpath, setEditMcpConfigRelpath] = useState('');
  const [editTestCommand, setEditTestCommand] = useState('');
  const [editNodeId, setEditNodeId] = useState('');
  const [editAllowNonGitDir, setEditAllowNonGitDir] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editOriginalNodeId, setEditOriginalNodeId] = useState('local');
  const [rebindGuidance, setRebindGuidance] = useState(null);
  const [operatorResetting, setOperatorResetting] = useState(false);
  const [retargetSuggestion, setRetargetSuggestion] = useState(null);
  const [retargetingQueued, setRetargetingQueued] = useState(false);
  const [warmingProjectIds, setWarmingProjectIds] = useState({});
  const warmingProjectIdsRef = useRef(new Set());
  const highlightedCardRef = useRef(null);

  const setProjectWarming = (projectId, warming) => {
    const key = String(projectId);
    const next = new Set(warmingProjectIdsRef.current);
    if (warming) next.add(key);
    else next.delete(key);
    warmingProjectIdsRef.current = next;
    setWarmingProjectIds(Object.fromEntries(Array.from(next, id => [id, true])));
  };

  const loadNodes = useCallback(async () => {
    setNodesLoading(true);
    try {
      const data = await apiFetch('/api/nodes');
      setNodes(data.nodes || []);
    } catch (err) {
      addToast(err.message, 'error');
    }
    setNodesLoading(false);
  }, []);

  useEffect(() => { loadNodes(); }, [loadNodes]);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/operator-instances')
      .then((data) => {
        if (!cancelled) setOperatorInstances(arrayValue(data?.instances));
      })
      .catch((err) => {
        if (!cancelled) {
          setOperatorInstances([]);
          addToast(err.message, 'error');
        }
      });
    return () => { cancelled = true; };
  }, []);

  const operatorWatchersByProject = useMemo(
    () => buildOperatorWatchersByProject(operatorInstances),
    [operatorInstances],
  );

  const createReady = name.trim() && (sourceType !== SOURCE_TYPE_GIT || repoUrl.trim());
  const editReady = editName.trim() && (editSourceType !== SOURCE_TYPE_GIT || editRepoUrl.trim());

  const handleProjectSaveError = (err) => {
    const message = repoPreflightMessage(err);
    if (!message) return false;
    addToast(message, 'error');
    return true;
  };

  const handleCreate = async () => {
    if (!createReady) return;
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        description: desc.trim() || undefined,
        test_command: testCommand.trim() || undefined,
      };
      applyProjectSourceBody(body, {
        sourceType,
        repoUrl,
        repoRef,
        repoSubdir,
        dir,
        mcpConfigSource,
        mcpConfigPath,
        mcpConfigRelpath,
        allowNonGitDir,
      });
      if (nodeId.trim()) body.node_id = nodeId.trim();
      await apiFetchWithToast('/api/projects', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setName('');
      setDesc('');
      setSourceType(SOURCE_TYPE_GIT);
      setRepoUrl('');
      setRepoRef('');
      setRepoSubdir('');
      setDir('');
      setMcpConfigSource(MCP_SOURCE_CONTROL_PLANE);
      setMcpConfigPath('');
      setMcpConfigRelpath('');
      setTestCommand('');
      setNodeId('');
      setAllowNonGitDir(false);
      setShowNew(false);
      reloadProjects();
    } catch (err) {
      if (hasRepoPreflightReason(err)) handleProjectSaveError(err);
    }
    setSaving(false);
  };

  const openEdit = (p) => {
    const nextSourceType = projectSourceType(p);
    setEditProject(p);
    setRebindGuidance(null);
    setRetargetSuggestion(null);
    setEditOriginalNodeId(queueNodeIdValue(p.node_id));
    setEditName(p.name || '');
    setEditDesc(p.description || '');
    setEditSourceType(nextSourceType);
    setEditRepoUrl(p.repo_url || '');
    setEditRepoRef(p.repo_ref || '');
    setEditRepoSubdir(p.repo_subdir || '');
    setEditDir(p.directory || '');
    setEditMcpConfigSource(normalizeMcpConfigSource(p.mcp_config_source));
    setEditMcpConfigPath(p.mcp_config_path || '');
    setEditMcpConfigRelpath(p.mcp_config_relpath || '');
    setEditTestCommand(p.test_command || '');
    setEditNodeId(projectNodeValue(p));
    setEditAllowNonGitDir(Number(p.allow_non_git_dir) === 1);
  };

  const closeEdit = () => {
    setEditProject(null);
    setRebindGuidance(null);
    setRetargetSuggestion(null);
    setEditOriginalNodeId('local');
  };

  const handleUpdate = async () => {
    if (!editProject || !editReady) return;
    setEditSaving(true);
    setRebindGuidance(null);
    setRetargetSuggestion(null);
    try {
      const oldNodeId = editOriginalNodeId;
      const nextNodeId = queueNodeIdValue(editNodeId);
      const body = {
        name: editName.trim(),
        description: editDesc.trim() || null,
        test_command: editTestCommand.trim() || null,
        node_id: editNodeId.trim() || null,
      };
      applyProjectSourceBody(body, {
        sourceType: editSourceType,
        repoUrl: editRepoUrl,
        repoRef: editRepoRef,
        repoSubdir: editRepoSubdir,
        dir: editDir,
        mcpConfigSource: editMcpConfigSource,
        mcpConfigPath: editMcpConfigPath,
        mcpConfigRelpath: editMcpConfigRelpath,
        allowNonGitDir: editAllowNonGitDir,
      }, { clear: true });
      const data = await apiFetch(`/api/projects/${editProject.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      reloadProjects();
      const savedProject = data.project || { ...editProject, node_id: nextNodeId === 'local' ? null : nextNodeId };
      const savedNodeId = queueNodeIdValue(savedProject.node_id);
      if (oldNodeId !== savedNodeId) {
        setEditProject(savedProject);
        setEditOriginalNodeId(savedNodeId);
        setRetargetSuggestion({
          projectId: editProject.id,
          fromNodeId: oldNodeId,
          toNodeId: savedNodeId,
          moved: null,
        });
      } else {
        closeEdit();
      }
    } catch (err) {
      if (isRebindResetConflict(err)) {
        setRebindGuidance({
          projectId: editProject.id,
          message: PROJECTS_LABELS.rebindResetRequired,
          detail: PROJECTS_LABELS.rebindResetDetail,
          resetDone: false,
        });
        addToast(PROJECTS_LABELS.rebindResetRequired, 'error');
      } else if (!handleProjectSaveError(err)) {
        addToast(err.message, 'error');
      }
    }
    setEditSaving(false);
  };

  const handleResetOperatorForRebind = async () => {
    if (!rebindGuidance?.projectId) return;
    setOperatorResetting(true);
    try {
      await apiFetch(`/api/projects/${rebindGuidance.projectId}/reset`, { method: 'POST' });
      setRebindGuidance({
        ...rebindGuidance,
        message: PROJECTS_LABELS.rebindResetSuccess,
        detail: '',
        resetDone: true,
      });
      addToast(PROJECTS_LABELS.rebindResetSuccess, 'success');
    } catch (err) {
      addToast(err.message, 'error');
    }
    setOperatorResetting(false);
  };

  const handleRetargetQueuedRuns = async () => {
    if (!retargetSuggestion?.projectId) return;
    setRetargetingQueued(true);
    try {
      const data = await apiFetch(`/api/projects/${retargetSuggestion.projectId}/retarget-queued`, {
        method: 'POST',
        body: JSON.stringify({ fromNodeId: retargetSuggestion.fromNodeId }),
      });
      const moved = Number(data.moved || 0);
      setRetargetSuggestion({ ...retargetSuggestion, moved });
      addToast(`${PROJECTS_LABELS.retargetQueuedDonePrefix}${moved}${PROJECTS_LABELS.retargetQueuedDoneSuffix}`, 'success');
      reloadProjects();
    } catch (err) {
      addToast(err.message, 'error');
    }
    setRetargetingQueued(false);
  };

  const handleWarmOperator = async (projectId) => {
    const key = String(projectId);
    if (warmingProjectIdsRef.current.has(key)) return;
    setProjectWarming(projectId, true);
    try {
      const data = await apiFetchWithToast(`/api/manager/pm/${encodeURIComponent(projectId)}/warm`, {
        method: 'POST',
        errorMessage: operatorWarmErrorMessage,
      });
      addToast(
        data?.spawned === false
          ? PROJECTS_LABELS.operatorWarmAlreadyReadyToast
          : PROJECTS_LABELS.operatorWarmReadyToast,
        'success',
      );
      window.location.hash = '#operator';
    } catch (err) {
      // apiFetchWithToast owns the user-facing error toast.
    }
    setProjectWarming(projectId, false);
  };

  // Keep detailProject in sync with latest data
  const currentDetailProject = detailProject ? projects.find(p => p.id === detailProject.id) || detailProject : null;

  useEffect(() => {
    if (!highlightProjectId || !highlightedCardRef.current) return;
    if (typeof highlightedCardRef.current.scrollIntoView === 'function') {
      highlightedCardRef.current.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
  }, [highlightProjectId, projects]);

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
          const remoteNodeId = projectNodeValue(p);
          const locationText = projectLocationText(p);
          const highlighted = highlightProjectId && String(p.id) === String(highlightProjectId);
          const warming = Boolean(warmingProjectIds[String(p.id)]);
          const operatorWatchers = operatorWatchersByProject.get(String(p.id)) || [];
          return html`
            <article
              key=${p.id}
              ref=${highlighted ? highlightedCardRef : null}
              class=${`project-card ${highlighted ? 'is-highlighted' : ''}`}
              data-role="project-card"
              data-project-id=${p.id}
              data-highlighted=${highlighted ? 'true' : 'false'}
            >
              <button class="project-card-trigger" onClick=${() => setDetailProject(p)}
                aria-label=${p.name}>
                <span class="project-card-header">
                  <span class="project-card-title">${p.name}</span>
                  ${taskCount > 0 && html`<span class="project-card-task-count">${taskCount}${PROJECTS_LABELS.taskWord}</span>`}
                  ${remoteNodeId && html`<span class="project-card-task-count">${PROJECTS_LABELS.nodeBadgePrefix} ${remoteNodeId}</span>`}
                  ${Number(p.allow_non_git_dir) === 1 && html`<span class="project-card-task-count">${PROJECTS_LABELS.sharedDirectoryBadge}</span>`}
                </span>
                ${locationText && html`<span class="project-card-dir" title=${locationText}>${projectSourceType(p) === SOURCE_TYPE_GIT ? '\u{1F517}' : '\u{1F4C1}'} ${locationText}</span>`}
                ${p.description && html`<span class="project-card-desc">${p.description}</span>`}
                ${operatorWatchers.length > 0 && html`
                  <span class="project-operator-watchers" data-role="project-operator-watchers">
                    <span data-role="project-operator-watchers-count">
                      ${PROJECTS_LABELS.operatorWatchersPrefix}${operatorWatchers.length}${PROJECTS_LABELS.operatorWatchersSuffix}
                    </span>
                    <span class="project-operator-watchers-row">
                      ${operatorWatchers.map((watcher) => html`
                        <span
                          key=${`${watcher.instanceId}:${watcher.role}`}
                          class=${`project-operator-watch-badge ${watcher.role === 'primary' ? 'primary' : 'reference'}`}
                          data-role=${watcher.role === 'primary' ? 'project-operator-watch-primary' : 'project-operator-watch-reference'}
                        >
                          ${operatorRefRoleLabel(watcher.role)} ${shortOperatorInstanceId(watcher.instanceId)}
                        </span>
                      `)}
                    </span>
                  </span>
                `}
                <span class="project-card-meta">${PROJECTS_LABELS.createdLabel} ${formatTime(p.created_at)}</span>
              </button>
              <div class="project-card-actions" style="margin-top:8px;">
                <button
                  class="ghost small"
                  type="button"
                  data-role="project-warm-operator"
                  onClick=${() => handleWarmOperator(p.id)}
                  disabled=${warming}
                  aria-busy=${warming ? 'true' : 'false'}
                  aria-label=${warming ? PROJECTS_LABELS.preparingOperatorAria : PROJECTS_LABELS.prepareOperator}
                >
                  ${warming && html`<span class="operator-spinner" aria-hidden="true"></span>`}
                  ${PROJECTS_LABELS.prepareOperator}
                </button>
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
          <${SourceTypeToggle}
            id="new-project-source-type"
            value=${sourceType}
            onChange=${setSourceType}
          />
          ${sourceType === SOURCE_TYPE_GIT
            ? html`
              <${GitSourceFields}
                prefix="new"
                repoUrl=${repoUrl}
                repoRef=${repoRef}
                repoSubdir=${repoSubdir}
                onRepoUrl=${setRepoUrl}
                onRepoRef=${setRepoRef}
                onRepoSubdir=${setRepoSubdir}
              />
              <${McpSourceFields}
                prefix="new"
                mcpConfigSource=${mcpConfigSource}
                mcpConfigPath=${mcpConfigPath}
                mcpConfigRelpath=${mcpConfigRelpath}
                onMcpConfigSource=${setMcpConfigSource}
                onMcpConfigPath=${setMcpConfigPath}
                onMcpConfigRelpath=${setMcpConfigRelpath}
              />
            `
            : html`
              <${LegacySourceFields}
                prefix="new"
                dir=${dir}
                allowNonGitDir=${allowNonGitDir}
                mcpConfigPath=${mcpConfigPath}
                onDir=${setDir}
                onAllowNonGitDir=${setAllowNonGitDir}
                onMcpConfigPath=${setMcpConfigPath}
              />
            `}
          <div class="form-field">
            <label class="form-label" for="new-project-desc">${PROJECTS_LABELS.fieldDescription}</label>
            <textarea id="new-project-desc" class="form-textarea" value=${desc} onInput=${e => setDesc(e.target.value)} placeholder=${PROJECTS_LABELS.descriptionPlaceholder} rows="3"></textarea>
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
          <div class="form-field">
            <label class="form-label" for="new-project-node">${PROJECTS_LABELS.defaultExecNodeLabel}</label>
            <${ProjectNodeSelect}
              id="new-project-node"
              value=${nodeId}
              onChange=${setNodeId}
              nodes=${nodes}
              loading=${nodesLoading}
            />
          </div>
        </div>
        <div class="modal-footer">
          <button class="ghost" onClick=${() => setShowNew(false)}>${COMMON_ACTIONS.cancel}</button>
          <button class="primary" onClick=${handleCreate} disabled=${saving || !createReady}>
            ${saving ? PROJECTS_LABELS.creating : COMMON_ACTIONS.create}
          </button>
        </div>
      </Modal>
      <${Modal} open=${!!editProject} onClose=${closeEdit} labelledBy="edit-project-title">
        <div class="modal-header">
          <h2 class="modal-title" id="edit-project-title">${PROJECTS_LABELS.modalEdit}</h2>
          <button class="ghost" onClick=${closeEdit}>${COMMON_ACTIONS.close}</button>
        </div>
        <div class="modal-body">
          <div class="form-field">
            <label class="form-label" for="edit-project-name">${PROJECTS_LABELS.fieldName}</label>
            <input id="edit-project-name" class="form-input" value=${editName} onInput=${e => setEditName(e.target.value)} placeholder=${PROJECTS_LABELS.namePlaceholder} />
          </div>
          <${SourceTypeToggle}
            id="edit-project-source-type"
            value=${editSourceType}
            onChange=${setEditSourceType}
          />
          ${editSourceType === SOURCE_TYPE_GIT
            ? html`
              <${GitSourceFields}
                prefix="edit"
                repoUrl=${editRepoUrl}
                repoRef=${editRepoRef}
                repoSubdir=${editRepoSubdir}
                onRepoUrl=${setEditRepoUrl}
                onRepoRef=${setEditRepoRef}
                onRepoSubdir=${setEditRepoSubdir}
              />
              <${McpSourceFields}
                prefix="edit"
                mcpConfigSource=${editMcpConfigSource}
                mcpConfigPath=${editMcpConfigPath}
                mcpConfigRelpath=${editMcpConfigRelpath}
                onMcpConfigSource=${setEditMcpConfigSource}
                onMcpConfigPath=${setEditMcpConfigPath}
                onMcpConfigRelpath=${setEditMcpConfigRelpath}
              />
            `
            : html`
              <${LegacySourceFields}
                prefix="edit"
                dir=${editDir}
                allowNonGitDir=${editAllowNonGitDir}
                mcpConfigPath=${editMcpConfigPath}
                onDir=${setEditDir}
                onAllowNonGitDir=${setEditAllowNonGitDir}
                onMcpConfigPath=${setEditMcpConfigPath}
              />
            `}
          <div class="form-field">
            <label class="form-label" for="edit-project-desc">${PROJECTS_LABELS.fieldDescription}</label>
            <textarea id="edit-project-desc" class="form-textarea" value=${editDesc} onInput=${e => setEditDesc(e.target.value)} placeholder=${PROJECTS_LABELS.descriptionPlaceholder} rows="3"></textarea>
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
          <div class="form-field">
            <label class="form-label" for="edit-project-node">${PROJECTS_LABELS.defaultExecNodeLabel}</label>
            <${ProjectNodeSelect}
              id="edit-project-node"
              value=${editNodeId}
              onChange=${setEditNodeId}
              nodes=${nodes}
              loading=${nodesLoading}
            />
          </div>
          ${rebindGuidance && html`
            <div
              data-role="operator-rebind-guidance"
              style="border:1px solid var(--border);background:var(--surface-muted, transparent);color:var(--text);padding:10px;border-radius:6px;font-size:12px;"
            >
              <div style="font-weight:600;">${rebindGuidance.message}</div>
              ${rebindGuidance.detail && html`<div style="color:var(--text-muted);margin-top:3px;">${rebindGuidance.detail}</div>`}
              ${!rebindGuidance.resetDone && html`
                <button
                  type="button"
                  class="ghost small"
                  data-role="operator-reset-button"
                  onClick=${handleResetOperatorForRebind}
                  disabled=${operatorResetting}
                  style="margin-top:8px;"
                >
                  ${operatorResetting ? PROJECTS_LABELS.rebindResetting : PROJECTS_LABELS.rebindResetButton}
                </button>
              `}
            </div>
          `}
          ${retargetSuggestion && html`
            <div
              data-role="queued-retarget-suggestion"
              style="border:1px solid var(--border);background:var(--surface-muted, transparent);color:var(--text);padding:10px;border-radius:6px;font-size:12px;"
            >
              <div style="font-weight:600;">${PROJECTS_LABELS.retargetQueuedBannerTitle}</div>
              <div style="color:var(--text-muted);margin-top:3px;">${PROJECTS_LABELS.retargetQueuedBannerDetail}</div>
              ${retargetSuggestion.moved === null
                ? html`
                  <button
                    type="button"
                    class="ghost small"
                    data-role="queued-retarget-button"
                    onClick=${handleRetargetQueuedRuns}
                    disabled=${retargetingQueued}
                    style="margin-top:8px;"
                  >
                    ${retargetingQueued ? PROJECTS_LABELS.retargetQueuedMoving : PROJECTS_LABELS.retargetQueuedButton}
                  </button>
                `
                : html`
                  <div data-role="queued-retarget-result" style="color:var(--text-muted);margin-top:6px;">
                    ${PROJECTS_LABELS.retargetQueuedDonePrefix}${retargetSuggestion.moved}${PROJECTS_LABELS.retargetQueuedDoneSuffix}
                  </div>
                `}
            </div>
          `}
        </div>
        <div class="modal-footer">
          <button class="ghost" onClick=${closeEdit}>${COMMON_ACTIONS.cancel}</button>
          <button class="primary" onClick=${handleUpdate} disabled=${editSaving || !editReady}>
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
