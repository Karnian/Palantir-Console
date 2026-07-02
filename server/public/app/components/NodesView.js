// NodesView — Fleet node registry CRUD page.
// Mirrors McpTemplatesView's modal CRUD shape: immutable id/kind on edit,
// JSON-array textarea parsing, and modal-based destructive confirmation.

import { h } from '../../vendor/preact.module.js';
import { useCallback, useEffect, useState } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { apiFetch } from '../lib/api.js';
import { addToast, apiFetchWithToast } from '../lib/toast.js';
import { COMMON_ACTIONS, NODES_LABELS } from '../lib/copy.js';
import { parseDate } from '../lib/format.js';
import { EmptyState } from './EmptyState.js';
import { Modal } from './Modal.js';

function Loading() { return html`<div class="loading">${COMMON_ACTIONS.loading}</div>`; }

function parseJsonArrayField(raw, fieldName) {
  const s = (raw || '').trim();
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    if (!Array.isArray(v)) throw new Error('not array');
    for (const e of v) {
      if (typeof e !== 'string') throw new Error('entries must be strings');
    }
    return v;
  } catch {
    throw new Error(`${fieldName}${NODES_LABELS.invalidJsonArraySuffix}`);
  }
}

function exposedRootCount(raw) {
  if (!raw) return 0;
  if (Array.isArray(raw)) return raw.length;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function formatTs(ts) {
  if (!ts) return '';
  try {
    const d = parseDate(ts);
    if (Number.isNaN(d.getTime())) return ts;
    return d.toLocaleString();
  } catch {
    return ts;
  }
}

function capabilityLabels(node) {
  const labels = [];
  if (Number(node.can_execute) === 1) labels.push(NODES_LABELS.capabilities.can_execute);
  if (Number(node.can_control) === 1) labels.push(NODES_LABELS.capabilities.can_control);
  if (Number(node.files_only) === 1) labels.push(NODES_LABELS.capabilities.files_only);
  return labels.length ? labels : [NODES_LABELS.capabilities.none];
}

function buildNodeBody({
  id,
  name,
  kind,
  sshHost,
  sshUser,
  exposedRootsJson,
  nodePrefix,
  maxConcurrent,
  canExecute,
  canControl,
  filesOnly,
}, { isEdit }) {
  const body = {
    id: id.trim() || undefined,
    name: name.trim(),
    kind,
    can_execute: canExecute ? 1 : 0,
    can_control: canControl ? 1 : 0,
    files_only: filesOnly ? 1 : 0,
    node_prefix: nodePrefix.trim() || null,
    max_concurrent: maxConcurrent === '' ? null : Number(maxConcurrent),
  };

  if (maxConcurrent !== '' && (!Number.isInteger(body.max_concurrent) || body.max_concurrent < 1)) {
    throw new Error(NODES_LABELS.validateMaxConcurrent);
  }

  if (kind === 'ssh') {
    if (!sshHost.trim() || !sshUser.trim()) throw new Error(NODES_LABELS.validateSshRequired);
    let roots;
    try {
      roots = parseJsonArrayField(exposedRootsJson, NODES_LABELS.fieldExposedRoots);
    } catch (err) {
      throw err;
    }
    if (!roots) throw new Error(NODES_LABELS.validateExposedRootsRequired);
    body.ssh_host = sshHost.trim();
    body.ssh_user = sshUser.trim();
    body.exposed_roots = roots;
  } else {
    body.ssh_host = null;
    body.ssh_user = null;
    body.exposed_roots = null;
  }

  if (isEdit) {
    delete body.id;
    delete body.kind;
  }

  return body;
}

function NodeModal({ open, node, onClose, onSaved }) {
  const isEdit = !!node;
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState('local');
  const [sshHost, setSshHost] = useState('');
  const [sshUser, setSshUser] = useState('');
  const [exposedRootsJson, setExposedRootsJson] = useState('');
  const [nodePrefix, setNodePrefix] = useState('');
  const [maxConcurrent, setMaxConcurrent] = useState('');
  const [canExecute, setCanExecute] = useState(true);
  const [canControl, setCanControl] = useState(false);
  const [filesOnly, setFilesOnly] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (node) {
      setId(node.id || '');
      setName(node.name || '');
      setKind(node.kind || 'local');
      setSshHost(node.ssh_host || '');
      setSshUser(node.ssh_user || '');
      setExposedRootsJson(node.exposed_roots || '');
      setNodePrefix(node.node_prefix || '');
      setMaxConcurrent(node.max_concurrent == null ? '' : String(node.max_concurrent));
      setCanExecute(Number(node.can_execute) === 1);
      setCanControl(Number(node.can_control) === 1);
      setFilesOnly(Number(node.files_only) === 1);
    } else {
      setId('');
      setName('');
      setKind('local');
      setSshHost('');
      setSshUser('');
      setExposedRootsJson('');
      setNodePrefix('');
      setMaxConcurrent('');
      setCanExecute(true);
      setCanControl(false);
      setFilesOnly(false);
    }
  }, [open, node]);

  const setExecuteChecked = (checked) => {
    setCanExecute(checked);
    if (checked) setFilesOnly(false);
  };

  const setFilesOnlyChecked = (checked) => {
    setFilesOnly(checked);
    if (checked) setCanExecute(false);
  };

  const handleSave = async () => {
    if (!name.trim()) {
      addToast(NODES_LABELS.validateNameRequired, 'error');
      return;
    }

    let body;
    try {
      body = buildNodeBody({
        id,
        name,
        kind,
        sshHost,
        sshUser,
        exposedRootsJson,
        nodePrefix,
        maxConcurrent,
        canExecute,
        canControl,
        filesOnly,
      }, { isEdit });
    } catch (err) {
      addToast(err.message, 'error');
      return;
    }

    setSaving(true);
    try {
      if (isEdit) {
        await apiFetchWithToast(`/api/nodes/${node.id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        addToast(NODES_LABELS.toastUpdated, 'success');
      } else {
        await apiFetchWithToast('/api/nodes', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        addToast(NODES_LABELS.toastCreated, 'success');
      }
      onSaved();
      onClose();
    } catch {
      // apiFetchWithToast already surfaced the server message.
    }
    setSaving(false);
  };

  return html`
    <${Modal}
      open=${open}
      onClose=${onClose}
      labelledBy="node-modal-title"
      maxWidth="560px"
    >
      <div class="modal-header">
        <h2 class="modal-title" id="node-modal-title">${isEdit ? NODES_LABELS.modalEdit : NODES_LABELS.modalNew}</h2>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <label class="form-label" for="node-name">${NODES_LABELS.fieldName}</label>
          <input
            id="node-name"
            class="form-input"
            value=${name}
            onInput=${e => setName(e.target.value)}
            placeholder=${NODES_LABELS.namePlaceholder}
          />
        </div>
        <div class="form-row">
          <label class="form-label" for="node-id">${NODES_LABELS.fieldId}
            ${!isEdit && html`
              <span style=${{ color: 'var(--text-muted)', fontWeight: 'normal', marginLeft: '6px' }}>
                ${NODES_LABELS.idOptionalHint}
              </span>
            `}
          </label>
          <input
            id="node-id"
            class="form-input"
            value=${id}
            onInput=${e => setId(e.target.value)}
            disabled=${isEdit}
            placeholder=${NODES_LABELS.idPlaceholder}
          />
          ${isEdit && html`
            <div class="small" style=${{ color: 'var(--text-muted)', marginTop: '4px' }}>
              ${NODES_LABELS.idImmutableHint}
            </div>
          `}
        </div>
        <div class="form-row">
          <label class="form-label" for="node-kind">${NODES_LABELS.fieldKind}</label>
          <select
            id="node-kind"
            class="form-select"
            value=${kind}
            onChange=${e => setKind(e.target.value)}
            disabled=${isEdit}
          >
            <option value="local">${NODES_LABELS.kindLocal}</option>
            <option value="ssh">${NODES_LABELS.kindSsh}</option>
          </select>
          ${isEdit && html`
            <div class="small" style=${{ color: 'var(--text-muted)', marginTop: '4px' }}>
              ${NODES_LABELS.kindImmutableHint}
            </div>
          `}
        </div>

        ${kind === 'ssh' && html`
          <div class="form-row">
            <label class="form-label" for="node-ssh-host">${NODES_LABELS.fieldSshHost}</label>
            <input
              id="node-ssh-host"
              class="form-input"
              value=${sshHost}
              onInput=${e => setSshHost(e.target.value)}
              placeholder=${NODES_LABELS.sshHostPlaceholder}
            />
          </div>
          <div class="form-row">
            <label class="form-label" for="node-ssh-user">${NODES_LABELS.fieldSshUser}</label>
            <input
              id="node-ssh-user"
              class="form-input"
              value=${sshUser}
              onInput=${e => setSshUser(e.target.value)}
              placeholder=${NODES_LABELS.sshUserPlaceholder}
            />
          </div>
          <div class="form-row">
            <label class="form-label" for="node-exposed-roots">${NODES_LABELS.fieldExposedRoots}
              <span style=${{ color: 'var(--text-muted)', fontWeight: 'normal', marginLeft: '6px' }}>
                ${NODES_LABELS.exposedRootsHint}
              </span>
            </label>
            <textarea
              id="node-exposed-roots"
              class="form-input"
              rows="3"
              value=${exposedRootsJson}
              onInput=${e => setExposedRootsJson(e.target.value)}
              placeholder=${NODES_LABELS.exposedRootsPlaceholder}
              style=${{ fontFamily: 'ui-monospace, monospace' }}
            ></textarea>
          </div>
        `}

        <div class="form-row">
          <label class="form-label" for="node-prefix">${NODES_LABELS.fieldNodePrefix}</label>
          <input
            id="node-prefix"
            class="form-input"
            value=${nodePrefix}
            onInput=${e => setNodePrefix(e.target.value)}
            placeholder=${NODES_LABELS.nodePrefixPlaceholder}
          />
        </div>
        <div class="form-row">
          <label class="form-label" for="node-max-concurrent">${NODES_LABELS.fieldMaxConcurrent}
            <span style=${{ color: 'var(--text-muted)', fontWeight: 'normal', marginLeft: '6px' }}>
              ${NODES_LABELS.maxConcurrentHint}
            </span>
          </label>
          <input
            id="node-max-concurrent"
            class="form-input"
            type="number"
            min="1"
            value=${maxConcurrent}
            onInput=${e => setMaxConcurrent(e.target.value)}
            placeholder=${NODES_LABELS.maxConcurrentPlaceholder}
          />
        </div>
        <fieldset class="form-row" style=${{ border: 0, padding: 0 }}>
          <legend class="form-label">${NODES_LABELS.fieldCapabilities}</legend>
          <label style=${{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px' }}>
            <input
              type="checkbox"
              checked=${canExecute}
              onChange=${e => setExecuteChecked(e.target.checked)}
            />
            <span>${NODES_LABELS.capabilities.can_execute}</span>
          </label>
          <label style=${{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px' }}>
            <input
              type="checkbox"
              checked=${canControl}
              onChange=${e => setCanControl(e.target.checked)}
            />
            <span>${NODES_LABELS.capabilities.can_control}</span>
          </label>
          <label style=${{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px' }}>
            <input
              type="checkbox"
              checked=${filesOnly}
              onChange=${e => setFilesOnlyChecked(e.target.checked)}
            />
            <span>${NODES_LABELS.capabilities.files_only}</span>
          </label>
          <div class="small" style=${{ color: 'var(--text-muted)', marginTop: '4px' }}>
            ${NODES_LABELS.capabilityHint}
          </div>
        </fieldset>
      </div>
      <div class="modal-footer">
        <button class="ghost" onClick=${onClose} disabled=${saving}>${COMMON_ACTIONS.cancel}</button>
        <button class="primary" onClick=${handleSave} disabled=${saving || !name.trim()}>
          ${saving ? COMMON_ACTIONS.saving : (isEdit ? COMMON_ACTIONS.save : COMMON_ACTIONS.create)}
        </button>
      </div>
    </Modal>
  `;
}

function DeleteConfirm({ open, node, onClose, onDeleted }) {
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!open) setDeleting(false);
  }, [open]);

  const handleDelete = async () => {
    if (!node) return;
    setDeleting(true);
    try {
      await apiFetchWithToast(`/api/nodes/${node.id}`, { method: 'DELETE' });
      addToast(NODES_LABELS.toastDeleted, 'success');
      onDeleted();
      onClose();
    } catch {
      // apiFetchWithToast already surfaced the server message.
    }
    setDeleting(false);
  };

  return html`
    <${Modal}
      open=${open}
      onClose=${onClose}
      labelledBy="node-delete-title"
      maxWidth="420px"
    >
      <div class="modal-header">
        <h2 class="modal-title" id="node-delete-title">${NODES_LABELS.deleteTitle}</h2>
      </div>
      <div class="modal-body">
        <p><strong>${node?.name || ''}</strong>${NODES_LABELS.deleteBodySuffix}</p>
        <p class="small" style=${{ color: 'var(--text-muted)' }}>${NODES_LABELS.deleteHint}</p>
      </div>
      <div class="modal-footer">
        <button class="ghost" onClick=${onClose} disabled=${deleting}>${COMMON_ACTIONS.cancel}</button>
        <button class="danger" onClick=${handleDelete} disabled=${deleting || !node}>
          ${deleting ? NODES_LABELS.deleting : COMMON_ACTIONS.delete}
        </button>
      </div>
    </Modal>
  `;
}

export function NodesView() {
  const [nodes, setNodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch('/api/nodes');
      setNodes(data.nodes || []);
    } catch (err) {
      addToast(err.message, 'error');
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return html`
    <div class="skill-packs-view" data-view="nodes">
      <div class="skill-packs-header">
        <h1 class="skill-packs-title">${NODES_LABELS.pageTitle}</h1>
        <button
          class="primary"
          onClick=${() => { setEditTarget(null); setModalOpen(true); }}
        >
          + ${NODES_LABELS.newNode}
        </button>
      </div>
      ${loading && html`<${Loading} />`}
      ${!loading && nodes.length === 0 && html`
        <${EmptyState}
          icon="⬢"
          text=${NODES_LABELS.emptyText}
          sub=${NODES_LABELS.emptySub}
        />
      `}
      ${!loading && nodes.length > 0 && html`
        <div class="skill-packs-list">
          ${nodes.map(node => {
            const isLocal = node.id === 'local';
            const rootsCount = exposedRootCount(node.exposed_roots);
            return html`
              <article class="skill-pack-card static" key=${node.id}>
                <div class="skill-pack-card-header">
                  <span class="skill-pack-icon">⬢</span>
                  <span class="skill-pack-name">${node.name}</span>
                  <span class="skill-pack-priority">${node.id}</span>
                </div>
                <div class="skill-pack-meta">
                  <span class="skill-pack-scope">${node.kind === 'ssh' ? NODES_LABELS.kindSsh : NODES_LABELS.kindLocal}</span>
                  ${isLocal && html`<span class="skill-pack-origin local">${NODES_LABELS.defaultNodeBadge}</span>`}
                  <span class="skill-pack-origin">
                    <span
                      class="run-status-dot"
                      style=${{ background: Number(node.reachable) === 1 ? 'var(--status-done)' : 'var(--text-muted)' }}
                    ></span>
                    ${Number(node.reachable) === 1 ? NODES_LABELS.reachable : NODES_LABELS.unreachable}
                  </span>
                  ${capabilityLabels(node).map(label => html`
                    <span class="skill-pack-mcp" key=${label}>${label}</span>
                  `)}
                </div>
                <div class="skill-pack-desc">
                  ${node.kind === 'ssh' && html`
                    <div>${NODES_LABELS.sshTargetLabel}: ${node.ssh_user || NODES_LABELS.emptyValue}@${node.ssh_host || NODES_LABELS.emptyValue} · ${rootsCount}${NODES_LABELS.rootsCountSuffix}</div>
                  `}
                  <div>${NODES_LABELS.nodePrefixLabel}: ${node.node_prefix || NODES_LABELS.emptyValue}</div>
                  <div>${NODES_LABELS.maxConcurrentLabel}: ${node.max_concurrent == null ? NODES_LABELS.unlimited : node.max_concurrent}</div>
                  ${node.last_heartbeat_at && html`
                    <div>${NODES_LABELS.lastHeartbeatLabel}: ${formatTs(node.last_heartbeat_at)}</div>
                  `}
                </div>
                <div class="skill-pack-card-actions">
                  <button class="ghost small" onClick=${() => { setEditTarget(node); setModalOpen(true); }}>
                    ${COMMON_ACTIONS.edit}
                  </button>
                  <button
                    class="ghost small danger-text"
                    onClick=${() => setDeleteTarget(node)}
                    disabled=${isLocal}
                    title=${isLocal ? NODES_LABELS.defaultNodeDeleteHint : NODES_LABELS.deleteTitle}
                  >
                    ${COMMON_ACTIONS.delete}
                  </button>
                </div>
              </article>
            `;
          })}
        </div>
      `}
      <${NodeModal}
        open=${modalOpen}
        node=${editTarget}
        onClose=${() => { setModalOpen(false); setEditTarget(null); }}
        onSaved=${load}
      />
      <${DeleteConfirm}
        open=${!!deleteTarget}
        node=${deleteTarget}
        onClose=${() => setDeleteTarget(null)}
        onDeleted=${load}
      />
    </div>
  `;
}
