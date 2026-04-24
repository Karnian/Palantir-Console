// McpTemplatesView — MCP server template CRUD page (M3).
// Pre-M3 the mcp_server_templates table was code-seed-only; this view exposes
// create/edit/delete via /api/mcp-server-templates. Presets reference
// templates by id; skill packs reference them by alias — hence alias is
// immutable on edit (server enforces, UI reflects with disabled field).

import { h } from '../../vendor/preact.module.js';
import { useState, useEffect } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { apiFetch } from '../lib/api.js';
import { addToast, apiFetchWithToast } from '../lib/toast.js';
import { useEscape } from '../lib/hooks.js';
import { EmptyState } from './EmptyState.js';

function Loading() { return html`<div class="loading">Loading...</div>`; }

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
    throw new Error(`${fieldName} must be a JSON array of strings`);
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
    return new Date(ts.replace(' ', 'T') + 'Z').toLocaleString();
  } catch { return ts; }
}

// ─────────────────────────────────────────────────────────────────────────────
// TemplateModal — create / edit
// ─────────────────────────────────────────────────────────────────────────────

function TemplateModal({ open, template, onClose, onSaved }) {
  const isEdit = !!template;
  const [alias, setAlias] = useState('');
  const [command, setCommand] = useState('');
  const [argsJson, setArgsJson] = useState('');
  const [envKeys, setEnvKeys] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  useEscape(open, onClose);

  useEffect(() => {
    if (!open) return;
    if (template) {
      setAlias(template.alias || '');
      setCommand(template.command || '');
      setArgsJson(template.args || '');
      let envArr = [];
      try { envArr = JSON.parse(template.allowed_env_keys || '[]') || []; } catch { envArr = []; }
      setEnvKeys(Array.isArray(envArr) ? envArr.join(', ') : '');
      setDescription(template.description || '');
    } else {
      setAlias('');
      setCommand('');
      setArgsJson('');
      setEnvKeys('');
      setDescription('');
    }
  }, [open, template]);

  if (!open) return null;

  const handleSave = async () => {
    if (!alias.trim() || !command.trim()) {
      addToast('alias and command are required', 'error');
      return;
    }
    let args;
    try { args = parseJsonArrayField(argsJson, 'args'); }
    catch (err) { addToast(err.message, 'error'); return; }
    const allowed = parseCommaList(envKeys);

    setSaving(true);
    try {
      const body = {
        alias: alias.trim(),
        command: command.trim(),
        args,
        allowed_env_keys: allowed,
        description: description.trim() || null,
      };
      if (isEdit) {
        // alias is immutable — don't send it on PATCH at all, so the server
        // never has to do a same-alias echo accept. command/args/env/desc only.
        delete body.alias;
        await apiFetchWithToast(`/api/mcp-server-templates/${template.id}`, {
          method: 'PATCH', body: JSON.stringify(body),
        });
        addToast('Template updated', 'success');
      } else {
        await apiFetchWithToast('/api/mcp-server-templates', {
          method: 'POST', body: JSON.stringify(body),
        });
        addToast('Template created', 'success');
      }
      onSaved();
      onClose();
    } catch { /* toast already shown by apiFetchWithToast */ }
    setSaving(false);
  };

  return html`
    <div class="modal-overlay">
      <div class="modal-backdrop" onClick=${onClose}></div>
      <div class="modal-panel" style=${{ maxWidth: '560px' }}>
        <div class="modal-header">
          <h2 class="modal-title">${isEdit ? 'Edit MCP Template' : 'New MCP Template'}</h2>
        </div>
        <div class="modal-body">
          <div class="form-row">
            <label class="form-label">Alias
              <span style=${{ color: 'var(--muted)', fontWeight: 'normal', marginLeft: '6px' }}>
                letters / digits / _ / -
              </span>
            </label>
            <input
              class="form-input"
              value=${alias}
              onInput=${e => setAlias(e.target.value)}
              disabled=${isEdit}
              placeholder="graphify"
            />
            ${isEdit && html`
              <div class="small" style=${{ color: 'var(--muted)', marginTop: '4px' }}>
                Alias is immutable — skill packs reference templates by this name.
              </div>
            `}
          </div>
          <div class="form-row">
            <label class="form-label">Command</label>
            <input
              class="form-input"
              value=${command}
              onInput=${e => setCommand(e.target.value)}
              placeholder="npx"
            />
          </div>
          <div class="form-row">
            <label class="form-label">Args
              <span style=${{ color: 'var(--muted)', fontWeight: 'normal', marginLeft: '6px' }}>
                JSON array of strings
              </span>
            </label>
            <textarea
              class="form-input"
              rows="2"
              value=${argsJson}
              onInput=${e => setArgsJson(e.target.value)}
              placeholder=${'["-y", "@graphify/mcp"]'}
              style=${{ fontFamily: 'ui-monospace, monospace' }}
            ></textarea>
          </div>
          <div class="form-row">
            <label class="form-label">Allowed env keys
              <span style=${{ color: 'var(--muted)', fontWeight: 'normal', marginLeft: '6px' }}>
                comma-separated
              </span>
            </label>
            <input
              class="form-input"
              value=${envKeys}
              onInput=${e => setEnvKeys(e.target.value)}
              placeholder="GRAPHIFY_ROOT, LOG_LEVEL"
            />
            <div class="small" style=${{ color: 'var(--muted)', marginTop: '4px' }}>
              Credential / process-loader patterns (*_KEY, NODE_OPTIONS, PATH, …) are globally denied.
            </div>
          </div>
          <div class="form-row">
            <label class="form-label">Description</label>
            <textarea
              class="form-input"
              rows="2"
              value=${description}
              onInput=${e => setDescription(e.target.value)}
              placeholder="What does this MCP server do?"
            ></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="ghost" onClick=${onClose} disabled=${saving}>Cancel</button>
          <button class="primary" onClick=${handleSave} disabled=${saving}>
            ${saving ? 'Saving...' : (isEdit ? 'Save' : 'Create')}
          </button>
        </div>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// DeleteConfirm — surfaces references on 409
// ─────────────────────────────────────────────────────────────────────────────

function DeleteConfirm({ open, template, onClose, onConfirm }) {
  const [deleting, setDeleting] = useState(false);
  const [refs, setRefs] = useState(null);
  useEscape(open, onClose);

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

  if (!open || !template) return null;
  const refsLoaded = refs !== null;
  const hasRefs = refsLoaded && (refs.presets?.length > 0 || refs.skillPacks?.length > 0);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await apiFetchWithToast(`/api/mcp-server-templates/${template.id}`, { method: 'DELETE' });
      addToast('Template deleted', 'success');
      onConfirm();
    } catch { /* toast already shown */ }
    setDeleting(false);
  };

  return html`
    <div class="modal-overlay">
      <div class="modal-backdrop" onClick=${onClose}></div>
      <div class="modal-panel" style=${{ maxWidth: '460px' }}>
        <div class="modal-header"><h2 class="modal-title">Delete MCP Template</h2></div>
        <div class="modal-body">
          <p>Delete <strong>${template.alias}</strong>?</p>
          ${hasRefs && html`
            <div style=${{
              marginTop: '12px', padding: '10px',
              background: 'color-mix(in srgb, #f59e0b 12%, transparent)',
              border: '1px solid color-mix(in srgb, #f59e0b 40%, transparent)',
              borderRadius: '6px', fontSize: '13px',
            }}>
              <strong style=${{ color: '#f59e0b' }}>In use</strong>
              <div style=${{ marginTop: '6px' }}>
                ${refs.presets?.length > 0 && html`
                  <div>Presets: ${refs.presets.map(p => p.name).join(', ')}</div>
                `}
                ${refs.skillPacks?.length > 0 && html`
                  <div>Skill packs: ${refs.skillPacks.map(p => p.name).join(', ')}</div>
                `}
                <div style=${{ marginTop: '6px', color: 'var(--muted)' }}>
                  Remove these references before deleting.
                </div>
              </div>
            </div>
          `}
          ${!hasRefs && refsLoaded && html`
            <div class="small" style=${{ color: 'var(--muted)', marginTop: '8px' }}>
              No references found — safe to delete.
            </div>
          `}
          ${!refsLoaded && html`
            <div class="small" style=${{ color: 'var(--muted)', marginTop: '8px' }}>
              Checking references…
            </div>
          `}
        </div>
        <div class="modal-footer">
          <button class="ghost" onClick=${onClose} disabled=${deleting}>Cancel</button>
          <button
            class="danger"
            onClick=${handleDelete}
            disabled=${deleting || hasRefs || !refsLoaded}
          >${deleting ? 'Deleting...' : 'Delete'}</button>
        </div>
      </div>
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
    <div class="skill-packs-view">
      <div class="skill-packs-header">
        <h1 class="skill-packs-title">MCP Servers</h1>
        <button
          class="primary"
          onClick=${() => { setEditTarget(null); setModalOpen(true); }}
        >+ New MCP Server</button>
      </div>
      ${loading && html`<${Loading} />`}
      ${!loading && templates.length === 0 && html`
        <${EmptyState}
          icon="⦿"
          text="No MCP templates"
          sub="Register an MCP server so presets and skill packs can reference it by alias."
        />
      `}
      ${!loading && templates.length > 0 && html`
        <div class="skill-packs-list">
          ${templates.map(t => html`
            <div class="skill-pack-card static" key=${t.id}>
              <div class="skill-pack-card-header">
                <h3 class="skill-pack-name" style=${{ margin: 0 }}>${t.alias}</h3>
              </div>
              <div class="small" style=${{ color: 'var(--text-muted)', marginTop: '4px' }}>
                <code>${t.command}</code>
                ${t.args && html` <span style=${{ opacity: 0.7 }}>${argsPreview(t.args)}</span>`}
              </div>
              ${t.description && html`
                <p class="skill-pack-desc" style=${{ marginTop: '6px' }}>${t.description}</p>
              `}
              <div class="small" style=${{ color: 'var(--text-muted)', marginTop: '6px' }}>
                Updated ${formatTs(t.updated_at)}
              </div>
              <div class="skill-pack-card-actions">
                <button class="ghost small" onClick=${() => { setEditTarget(t); setModalOpen(true); }}>Edit</button>
                <button class="ghost small" onClick=${() => setDeleteTarget(t)}>Delete</button>
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
