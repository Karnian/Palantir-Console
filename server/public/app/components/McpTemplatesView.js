// McpTemplatesView — MCP server template CRUD page (M3 + M4-a).
// Pre-M3 the mcp_server_templates table was code-seed-only; this view exposes
// create/edit/delete via /api/mcp-server-templates. Presets reference
// templates by id; skill packs reference them by alias — hence alias is
// immutable on edit (server enforces, UI reflects with disabled field).
//
// M4-a: discriminated transport (stdio | http). Transport is also immutable
// after creation — the modal disables the selector on edit and shows a hint
// that pushes users toward "make a new alias" for transport switches. The
// list card branches on transport for the body display so http rows show
// the URL (and bearer env *name*, value masked) while stdio rows show
// command + args preview as before.

import { h } from '../../vendor/preact.module.js';
import { useState, useEffect } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { apiFetch } from '../lib/api.js';
import { addToast, apiFetchWithToast } from '../lib/toast.js';
import { COMMON_ACTIONS, MCP_TEMPLATES_LABELS } from '../lib/copy.js';
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
  } catch (err) {
    throw new Error(`${fieldName}${MCP_TEMPLATES_LABELS.invalidJsonArraySuffix}`);
  }
}

function parseCommaList(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  return s.split(/[,\s]+/).map(x => x.trim()).filter(Boolean);
}

function argsPreview(raw) {
  if (!raw) return '—';
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.join(' ');
  } catch { /* */ }
  return String(raw);
}

function formatTs(ts) {
  if (!ts) return '—';
  try {
    const d = parseDate(ts);
    if (Number.isNaN(d.getTime())) return ts;
    return d.toLocaleString();
  } catch { return ts; }
}

// ─────────────────────────────────────────────────────────────────────────────
// TemplateModal — create / edit
// ─────────────────────────────────────────────────────────────────────────────

function TemplateModal({ open, template, onClose, onSaved }) {
  const isEdit = !!template;
  const [alias, setAlias] = useState('');
  // M4-a: transport defaults to 'stdio' on new; on edit we read back the
  // server value and disable the selector. Same-transport echo on PATCH
  // is accepted by the service so we always send the current value.
  const [transport, setTransport] = useState('stdio');
  const [command, setCommand] = useState('');
  const [argsJson, setArgsJson] = useState('');
  const [envKeys, setEnvKeys] = useState('');
  const [url, setUrl] = useState('');
  const [bearerEnv, setBearerEnv] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (template) {
      setAlias(template.alias || '');
      setTransport(template.transport || 'stdio');
      setCommand(template.command || '');
      setArgsJson(template.args || '');
      let envArr = [];
      try { envArr = JSON.parse(template.allowed_env_keys || '[]') || []; } catch { envArr = []; }
      setEnvKeys(Array.isArray(envArr) ? envArr.join(', ') : '');
      setUrl(template.url || '');
      setBearerEnv(template.bearer_token_env_var || '');
      setDescription(template.description || '');
    } else {
      setAlias('');
      setTransport('stdio');
      setCommand('');
      setArgsJson('');
      setEnvKeys('');
      setUrl('');
      setBearerEnv('');
      setDescription('');
    }
  }, [open, template]);

  const handleSave = async () => {
    if (!alias.trim()) {
      addToast(MCP_TEMPLATES_LABELS.validateAliasCommand, 'error');
      return;
    }
    if (transport === 'stdio' && !command.trim()) {
      addToast(MCP_TEMPLATES_LABELS.validateAliasCommand, 'error');
      return;
    }
    if (transport === 'http' && !url.trim()) {
      addToast(MCP_TEMPLATES_LABELS.validateHttpUrl, 'error');
      return;
    }

    setSaving(true);
    try {
      const body = {
        alias: alias.trim(),
        transport,
        description: description.trim() || null,
      };
      if (transport === 'stdio') {
        let args;
        try { args = parseJsonArrayField(argsJson, 'args'); }
        catch (err) { addToast(err.message, 'error'); setSaving(false); return; }
        body.command = command.trim();
        body.args = args;
        body.allowed_env_keys = parseCommaList(envKeys);
      } else {
        body.url = url.trim();
        body.bearer_token_env_var = bearerEnv.trim() || null;
      }
      if (isEdit) {
        // alias + transport are immutable — don't send them on PATCH at all
        // so the server never has to do a same-value echo accept dance.
        delete body.alias;
        delete body.transport;
        await apiFetchWithToast(`/api/mcp-server-templates/${template.id}`, {
          method: 'PATCH', body: JSON.stringify(body),
        });
        addToast(MCP_TEMPLATES_LABELS.toastUpdated, 'success');
      } else {
        await apiFetchWithToast('/api/mcp-server-templates', {
          method: 'POST', body: JSON.stringify(body),
        });
        addToast(MCP_TEMPLATES_LABELS.toastCreated, 'success');
      }
      onSaved();
      onClose();
    } catch { /* toast already shown by apiFetchWithToast */ }
    setSaving(false);
  };

  return html`
    <${Modal}
      open=${open}
      onClose=${onClose}
      labelledBy="mcp-template-title"
      maxWidth="560px"
    >
      <div class="modal-header">
        <h2 class="modal-title" id="mcp-template-title">${isEdit ? MCP_TEMPLATES_LABELS.modalEdit : MCP_TEMPLATES_LABELS.modalNew}</h2>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <label class="form-label" for="mcp-tpl-alias">${MCP_TEMPLATES_LABELS.fieldAlias}
            <span style=${{ color: 'var(--text-muted)', fontWeight: 'normal', marginLeft: '6px' }}>
              ${MCP_TEMPLATES_LABELS.aliasHint}
            </span>
          </label>
          <input
            id="mcp-tpl-alias"
            class="form-input"
            value=${alias}
            onInput=${e => setAlias(e.target.value)}
            disabled=${isEdit}
            placeholder=${MCP_TEMPLATES_LABELS.aliasPlaceholder}
          />
          ${isEdit && html`
            <div class="small" style=${{ color: 'var(--text-muted)', marginTop: '4px' }}>
              ${MCP_TEMPLATES_LABELS.aliasImmutableHint}
            </div>
          `}
        </div>
        <div class="form-row">
          <label class="form-label" for="mcp-tpl-transport">${MCP_TEMPLATES_LABELS.fieldTransport}</label>
          <div role="radiogroup" aria-labelledby="mcp-tpl-transport" style=${{ display: 'flex', gap: '12px', marginTop: '4px' }}>
            <label style=${{ display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: isEdit ? 'not-allowed' : 'pointer' }}>
              <input
                type="radio"
                name="mcp-tpl-transport"
                value="stdio"
                checked=${transport === 'stdio'}
                onChange=${() => setTransport('stdio')}
                disabled=${isEdit}
              />
              <span>${MCP_TEMPLATES_LABELS.transportStdio}</span>
            </label>
            <label style=${{ display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: isEdit ? 'not-allowed' : 'pointer' }}>
              <input
                type="radio"
                name="mcp-tpl-transport"
                value="http"
                checked=${transport === 'http'}
                onChange=${() => setTransport('http')}
                disabled=${isEdit}
              />
              <span>${MCP_TEMPLATES_LABELS.transportHttp}</span>
            </label>
          </div>
          ${isEdit && html`
            <div class="small" style=${{ color: 'var(--text-muted)', marginTop: '4px' }}>
              ${MCP_TEMPLATES_LABELS.transportImmutableHint}
            </div>
          `}
        </div>

        ${transport === 'stdio' && html`
          <div class="form-row">
            <label class="form-label" for="mcp-tpl-command">${MCP_TEMPLATES_LABELS.fieldCommand}</label>
            <input
              id="mcp-tpl-command"
              class="form-input"
              value=${command}
              onInput=${e => setCommand(e.target.value)}
              placeholder=${MCP_TEMPLATES_LABELS.commandPlaceholder}
            />
          </div>
          <div class="form-row">
            <label class="form-label" for="mcp-tpl-args">${MCP_TEMPLATES_LABELS.fieldArgs}
              <span style=${{ color: 'var(--text-muted)', fontWeight: 'normal', marginLeft: '6px' }}>
                ${MCP_TEMPLATES_LABELS.argsHint}
              </span>
            </label>
            <textarea
              id="mcp-tpl-args"
              class="form-input"
              rows="2"
              value=${argsJson}
              onInput=${e => setArgsJson(e.target.value)}
              placeholder=${'["-y", "@graphify/mcp"]'}
              style=${{ fontFamily: 'ui-monospace, monospace' }}
            ></textarea>
          </div>
          <div class="form-row">
            <label class="form-label" for="mcp-tpl-env">${MCP_TEMPLATES_LABELS.fieldEnv}
              <span style=${{ color: 'var(--text-muted)', fontWeight: 'normal', marginLeft: '6px' }}>
                ${MCP_TEMPLATES_LABELS.envHint}
              </span>
            </label>
            <input
              id="mcp-tpl-env"
              class="form-input"
              value=${envKeys}
              onInput=${e => setEnvKeys(e.target.value)}
              placeholder=${MCP_TEMPLATES_LABELS.envPlaceholder}
            />
            <div class="small" style=${{ color: 'var(--text-muted)', marginTop: '4px' }}>
              ${MCP_TEMPLATES_LABELS.envWarn}
            </div>
          </div>
        `}

        ${transport === 'http' && html`
          <div class="form-row">
            <label class="form-label" for="mcp-tpl-url">${MCP_TEMPLATES_LABELS.fieldUrl}
              <span style=${{ color: 'var(--text-muted)', fontWeight: 'normal', marginLeft: '6px' }}>
                ${MCP_TEMPLATES_LABELS.urlHint}
              </span>
            </label>
            <input
              id="mcp-tpl-url"
              class="form-input"
              value=${url}
              onInput=${e => setUrl(e.target.value)}
              placeholder=${MCP_TEMPLATES_LABELS.urlPlaceholder}
              style=${{ fontFamily: 'ui-monospace, monospace' }}
            />
          </div>
          <div class="form-row">
            <label class="form-label" for="mcp-tpl-bearer">${MCP_TEMPLATES_LABELS.fieldBearerEnvVar}
              <span style=${{ color: 'var(--text-muted)', fontWeight: 'normal', marginLeft: '6px' }}>
                ${MCP_TEMPLATES_LABELS.bearerEnvVarHint}
              </span>
            </label>
            <input
              id="mcp-tpl-bearer"
              class="form-input"
              value=${bearerEnv}
              onInput=${e => setBearerEnv(e.target.value)}
              placeholder=${MCP_TEMPLATES_LABELS.bearerEnvVarPlaceholder}
              style=${{ fontFamily: 'ui-monospace, monospace' }}
            />
            <div class="small" style=${{ color: 'var(--text-muted)', marginTop: '4px' }}>
              ${MCP_TEMPLATES_LABELS.bearerEnvVarWarn}
            </div>
          </div>
        `}

        <div class="form-row">
          <label class="form-label" for="mcp-tpl-desc">${MCP_TEMPLATES_LABELS.fieldDescription}</label>
          <textarea
            id="mcp-tpl-desc"
            class="form-input"
            rows="2"
            value=${description}
            onInput=${e => setDescription(e.target.value)}
            placeholder=${MCP_TEMPLATES_LABELS.descriptionPlaceholder}
          ></textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button class="ghost" onClick=${onClose} disabled=${saving}>${COMMON_ACTIONS.cancel}</button>
        <button class="primary" onClick=${handleSave} disabled=${saving}>
          ${saving ? COMMON_ACTIONS.saving : (isEdit ? COMMON_ACTIONS.save : COMMON_ACTIONS.create)}
        </button>
      </div>
    </Modal>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// DeleteConfirm — surfaces references on 409
// ─────────────────────────────────────────────────────────────────────────────

function DeleteConfirm({ open, template, onClose, onConfirm }) {
  const [deleting, setDeleting] = useState(false);
  const [refs, setRefs] = useState(null);

  useEffect(() => {
    // Reset on template change so we don't flash stale refs from a
    // previously-open dialog while the new fetch is in flight.
    setRefs(null);
    if (!open || !template) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/mcp-server-templates/${template.id}/references`);
        if (!cancelled) setRefs(res.references);
      } catch {
        // Leave refs null. The Delete button stays disabled until we know
        // for sure — the server 409 is the fallback, but the UI promise
        // "don't let the user delete a template in use" needs to hold
        // BEFORE the user clicks, not only after the request fails.
      }
    })();
    return () => { cancelled = true; };
  }, [open, template]);

  const refsLoaded = refs !== null;
  const hasRefs = refsLoaded && (refs.presets?.length > 0 || refs.skillPacks?.length > 0);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await apiFetchWithToast(`/api/mcp-server-templates/${template.id}`, { method: 'DELETE' });
      addToast(MCP_TEMPLATES_LABELS.toastDeleted, 'success');
      onConfirm();
    } catch { /* toast already shown */ }
    setDeleting(false);
  };

  return html`
    <${Modal}
      open=${open && !!template}
      onClose=${onClose}
      labelledBy="mcp-delete-title"
      maxWidth="460px"
    >
      <div class="modal-header"><h2 class="modal-title" id="mcp-delete-title">${MCP_TEMPLATES_LABELS.deleteTitle}</h2></div>
      <div class="modal-body">
        <p><strong>${template?.alias}</strong>${MCP_TEMPLATES_LABELS.deleteBodySuffix}</p>
        ${hasRefs && html`
          <div style=${{
            marginTop: '12px', padding: '10px',
            background: 'color-mix(in srgb, var(--warning) 12%, transparent)',
            border: '1px solid color-mix(in srgb, var(--warning) 40%, transparent)',
            borderRadius: '6px', fontSize: '13px',
          }}>
            <strong style=${{ color: 'var(--warning)' }}>${MCP_TEMPLATES_LABELS.inUseTitle}</strong>
            <div style=${{ marginTop: '6px' }}>
              ${refs.presets?.length > 0 && html`
                <div>${MCP_TEMPLATES_LABELS.inUsePresetsLabel}: ${refs.presets.map(p => p.name).join(', ')}</div>
              `}
              ${refs.skillPacks?.length > 0 && html`
                <div>${MCP_TEMPLATES_LABELS.inUseSkillPacksLabel}: ${refs.skillPacks.map(p => p.name).join(', ')}</div>
              `}
              <div style=${{ marginTop: '6px', color: 'var(--text-muted)' }}>
                ${MCP_TEMPLATES_LABELS.inUseRemediation}
              </div>
            </div>
          </div>
        `}
        ${!hasRefs && refsLoaded && html`
          <div class="small" style=${{ color: 'var(--text-muted)', marginTop: '8px' }}>
            ${MCP_TEMPLATES_LABELS.noReferences}
          </div>
        `}
        ${!refsLoaded && html`
          <div class="small" style=${{ color: 'var(--text-muted)', marginTop: '8px' }}>
            ${MCP_TEMPLATES_LABELS.checkingReferences}
          </div>
        `}
      </div>
      <div class="modal-footer">
        <button class="ghost" onClick=${onClose} disabled=${deleting}>${COMMON_ACTIONS.cancel}</button>
        <button
          class="danger"
          onClick=${handleDelete}
          disabled=${deleting || hasRefs || !refsLoaded}
        >${deleting ? COMMON_ACTIONS.deleting : COMMON_ACTIONS.delete}</button>
      </div>
    </Modal>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Card body — branches on transport
// ─────────────────────────────────────────────────────────────────────────────

function CardBody({ template }) {
  if (template.transport === 'http') {
    return html`
      <div class="small" style=${{ color: 'var(--text-muted)', marginTop: '4px' }}>
        <code>${template.url}</code>
        ${template.bearer_token_env_var && html` <span>(${MCP_TEMPLATES_LABELS.cardBearerPrefix} ${template.bearer_token_env_var})</span>`}
      </div>
    `;
  }
  return html`
    <div class="small" style=${{ color: 'var(--text-muted)', marginTop: '4px' }}>
      <code>${template.command}</code>
      ${template.args && html` <span>${argsPreview(template.args)}</span>`}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// McpTemplatesView — list
// ─────────────────────────────────────────────────────────────────────────────

export function McpTemplatesView() {
  const [loading, setLoading] = useState(true);
  const [templates, setTemplates] = useState([]);
  const [editTarget, setEditTarget] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const reload = async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/mcp-server-templates');
      setTemplates(res.templates || []);
    } catch (err) { addToast(err.message, 'error'); }
    setLoading(false);
  };

  useEffect(() => { reload(); }, []);

  return html`
    <div class="skill-packs-view" data-view="mcp-servers">
      <div class="skill-packs-header">
        <h1 class="skill-packs-title">${MCP_TEMPLATES_LABELS.pageTitle}</h1>
        <button
          class="primary"
          onClick=${() => { setEditTarget(null); setModalOpen(true); }}
        >+ ${MCP_TEMPLATES_LABELS.newTemplate}</button>
      </div>
      ${loading && html`<${Loading} />`}
      ${!loading && templates.length === 0 && html`
        <${EmptyState}
          icon="⦿"
          text=${MCP_TEMPLATES_LABELS.emptyText}
          sub=${MCP_TEMPLATES_LABELS.emptySub}
        />
      `}
      ${!loading && templates.length > 0 && html`
        <div class="skill-packs-list">
          ${templates.map(t => html`
            <div class="skill-pack-card static" key=${t.id} data-transport=${t.transport || 'stdio'}>
              <div class="skill-pack-card-header">
                <h3 class="skill-pack-name" style=${{ margin: 0 }}>${t.alias}</h3>
                <span class="small" style=${{ color: 'var(--text-muted)', marginLeft: '8px', textTransform: 'uppercase' }}>${t.transport || 'stdio'}</span>
              </div>
              <${CardBody} template=${t} />
              ${t.description && html`
                <p class="skill-pack-desc" style=${{ marginTop: '6px' }}>${t.description}</p>
              `}
              <div class="small" style=${{ color: 'var(--text-muted)', marginTop: '6px' }} data-visual-mask="true">
                ${MCP_TEMPLATES_LABELS.cardUpdatedPrefix} ${formatTs(t.updated_at)}
              </div>
              <div class="skill-pack-card-actions">
                <button class="ghost small" onClick=${() => { setEditTarget(t); setModalOpen(true); }}>${COMMON_ACTIONS.edit}</button>
                <button class="ghost small" onClick=${() => setDeleteTarget(t)}>${COMMON_ACTIONS.delete}</button>
              </div>
            </div>
          `)}
        </div>
      `}
      <${TemplateModal}
        open=${modalOpen}
        template=${editTarget}
        onClose=${() => { setModalOpen(false); setEditTarget(null); }}
        onSaved=${reload}
      />
      <${DeleteConfirm}
        open=${!!deleteTarget}
        template=${deleteTarget}
        onClose=${() => setDeleteTarget(null)}
        onConfirm=${() => { setDeleteTarget(null); reload(); }}
      />
    </div>
  `;
}
