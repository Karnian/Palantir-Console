// PresetsView — Worker Preset management (Phase 10E).
// Minimal list + create/edit modal. See docs/specs/worker-preset-and-plugin-injection.md.

import { h } from '../../vendor/preact.module.js';
import { useState, useEffect, useMemo } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { apiFetch } from '../lib/api.js';
import { addToast, apiFetchWithToast } from '../lib/toast.js';
import { EmptyState } from './EmptyState.js';
import { Modal } from './Modal.js';

function Loading() { return html`<div class="loading">Loading...</div>`; }

function parseMaybeJsonArray(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// PresetModal — create / edit
// ─────────────────────────────────────────────────────────────────────────────

function PresetModal({ open, onClose, preset, pluginRefs, templates, onSaved }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isolated, setIsolated] = useState(false);
  const [basePrompt, setBasePrompt] = useState('');
  const [selectedPlugins, setSelectedPlugins] = useState(new Set());
  const [selectedMcp, setSelectedMcp] = useState(new Set());
  const [minVersion, setMinVersion] = useState('');
  const [settingSources, setSettingSources] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (preset) {
      setName(preset.name || '');
      setDescription(preset.description || '');
      setIsolated(!!preset.isolated);
      setBasePrompt(preset.base_system_prompt || '');
      setSelectedPlugins(new Set(parseMaybeJsonArray(preset.plugin_refs)));
      setSelectedMcp(new Set(parseMaybeJsonArray(preset.mcp_server_ids)));
      setMinVersion(preset.min_claude_version || '');
      setSettingSources(preset.setting_sources || '');
    } else {
      setName(''); setDescription(''); setIsolated(false);
      setBasePrompt(''); setSelectedPlugins(new Set()); setSelectedMcp(new Set());
      setMinVersion(''); setSettingSources('');
    }
  }, [open, preset]);

  const togglePlugin = (name) => {
    setSelectedPlugins(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };
  const toggleMcp = (id) => {
    setSelectedMcp(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const byteLen = new TextEncoder().encode(basePrompt).length;
  const promptOverLimit = byteLen > 16 * 1024;

  const handleSave = async () => {
    if (!name.trim()) return;
    if (promptOverLimit) { addToast('base_system_prompt exceeds 16KB', 'error'); return; }
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        isolated,
        plugin_refs: [...selectedPlugins],
        mcp_server_ids: [...selectedMcp],
        base_system_prompt: basePrompt || null,
        setting_sources: settingSources,
        min_claude_version: minVersion.trim() || null,
      };
      if (preset) {
        await apiFetchWithToast(`/api/worker-presets/${preset.id}`, {
          method: 'PATCH', body: JSON.stringify(body),
        });
        addToast('Preset updated', 'success');
      } else {
        await apiFetchWithToast('/api/worker-presets', {
          method: 'POST', body: JSON.stringify(body),
        });
        addToast('Preset created', 'success');
      }
      onSaved();
      onClose();
    } catch { /* toast already shown */ }
    setSaving(false);
  };

  return html`
    <${Modal} open=${open} onClose=${onClose} labelledBy="preset-modal-title" maxWidth="640px">
      <div class="modal-header">
        <h2 class="modal-title" id="preset-modal-title">${preset ? 'Edit Preset' : 'New Worker Preset'}</h2>
        <button class="modal-close" onClick=${onClose}>\u2715</button>
      </div>
      <div class="modal-body">
          <div class="form-field">
            <label class="form-label">Name</label>
            <input class="form-input" value=${name} onInput=${e => setName(e.target.value)}
              placeholder="e.g. agent-olympus-isolated" />
          </div>
          <div class="form-field">
            <label class="form-label">Description</label>
            <input class="form-input" value=${description} onInput=${e => setDescription(e.target.value)} />
          </div>
          <div class="form-field">
            <label style=${{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input type="checkbox" checked=${isolated} onChange=${e => setIsolated(e.target.checked)} />
              <span class="form-label" style=${{ marginBottom: 0 }}>Isolated (Tier 2 — Claude only)</span>
            </label>
            ${isolated && html`
              <div class="small" style=${{ marginTop: '4px', color: 'var(--muted)' }}>
                Applies only to Claude workers. Codex / OpenCode receive a
                <code>preset:tier2_skipped</code> warning and fall back to Tier 1.
              </div>
            `}
          </div>

          <div class="form-field">
            <label class="form-label">Base System Prompt (≤16KB, ${byteLen} bytes)</label>
            <textarea class="form-textarea" rows="6" value=${basePrompt}
              onInput=${e => setBasePrompt(e.target.value)}
              style=${promptOverLimit ? { borderColor: 'var(--status-failed)' } : null}
              placeholder="Optional preset base prompt. Prepended to skill-pack sections." />
          </div>

          <div class="form-field">
            <label class="form-label">Plugin Refs (server/plugins/)</label>
            ${pluginRefs.length === 0 && html`
              <div class="small" style=${{ color: 'var(--muted)' }}>
                No plugin.json-bearing directories in <code>server/plugins/</code>.
              </div>
            `}
            ${pluginRefs.map(p => html`
              <label key=${p.name} style=${{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0' }}>
                <input type="checkbox" checked=${selectedPlugins.has(p.name)}
                  onChange=${() => togglePlugin(p.name)} />
                <code>${p.name}</code>
                ${p.version && html`<span class="small" style=${{ color: 'var(--muted)' }}>v${p.version}</span>`}
                ${p.description && html`<span class="small">${p.description}</span>`}
              </label>
            `)}
          </div>

          <div class="form-field">
            <label class="form-label">MCP Server Templates</label>
            ${templates.length === 0 && html`
              <div class="small" style=${{ color: 'var(--muted)' }}>No MCP templates registered.</div>
            `}
            ${templates.map(t => html`
              <label key=${t.id} style=${{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0' }}>
                <input type="checkbox" checked=${selectedMcp.has(t.id)}
                  onChange=${() => toggleMcp(t.id)} />
                <code>${t.alias}</code>
                ${t.description && html`<span class="small">${t.description}</span>`}
              </label>
            `)}
          </div>

          <div class="form-field">
            <label class="form-label">Min Claude Version (optional, semver)</label>
            <input class="form-input" value=${minVersion}
              onInput=${e => setMinVersion(e.target.value)}
              placeholder="e.g. 2.0.0" />
          </div>
          <div class="form-field">
            <label class="form-label">Setting Sources (Tier 2 flag, default empty)</label>
            <input class="form-input" value=${settingSources}
              onInput=${e => setSettingSources(e.target.value)}
              placeholder="(empty = --setting-sources '')" />
          </div>
        </div>
        <div class="modal-footer">
          <button class="ghost" onClick=${onClose}>Cancel</button>
          <button class="primary" onClick=${handleSave}
            disabled=${saving || !name.trim() || promptOverLimit}>
            ${saving ? 'Saving...' : preset ? 'Update' : 'Create'}
          </button>
        </div>
    </Modal>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Delete confirmation
// ─────────────────────────────────────────────────────────────────────────────

function DeleteConfirm({ open, preset, onClose, onConfirm }) {
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await apiFetchWithToast(`/api/worker-presets/${preset.id}`, { method: 'DELETE' });
      addToast('Preset deleted', 'success');
      onConfirm();
    } catch { /* */ }
    setDeleting(false);
  };

  return html`
    <${Modal} open=${open && !!preset} onClose=${onClose} labelledBy="preset-delete-title" maxWidth="420px">
      <div class="modal-header"><h2 class="modal-title" id="preset-delete-title">Delete Preset</h2></div>
      <div class="modal-body">
        <p>Delete <strong>${preset?.name}</strong>? Task links to this preset will be cleared. Past run snapshots are preserved.</p>
      </div>
      <div class="modal-footer">
        <button class="ghost" onClick=${onClose}>Cancel</button>
        <button class="danger" onClick=${handleDelete} disabled=${deleting}>
          ${deleting ? 'Deleting...' : 'Delete'}
        </button>
      </div>
    </Modal>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// PresetsView — list
// ─────────────────────────────────────────────────────────────────────────────

export function PresetsView() {
  const [loading, setLoading] = useState(true);
  const [presets, setPresets] = useState([]);
  const [pluginRefs, setPluginRefs] = useState([]);
  const [pluginWarnings, setPluginWarnings] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [editTarget, setEditTarget] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const reload = async () => {
    setLoading(true);
    try {
      const [p, r, t] = await Promise.all([
        apiFetch('/api/worker-presets'),
        apiFetch('/api/worker-presets/plugin-refs'),
        apiFetch('/api/skill-packs/templates'),
      ]);
      setPresets(p.presets || []);
      setPluginRefs(r.plugin_refs || []);
      setPluginWarnings(r.warnings || []);
      setTemplates(t.templates || []);
    } catch (err) { addToast(err.message, 'error'); }
    setLoading(false);
  };

  useEffect(() => { reload(); }, []);

  return html`
    <div class="skill-packs-view">
      <div class="skill-packs-header">
        <h1 class="skill-packs-title">Worker Presets</h1>
        <button class="primary" onClick=${() => { setEditTarget(null); setModalOpen(true); }}>
          + New Preset
        </button>
      </div>
      ${!loading && pluginWarnings.length > 0 && html`
        <div style=${{
          display: 'flex', alignItems: 'flex-start', gap: '8px',
          padding: '8px 12px',
          background: 'color-mix(in srgb, #f59e0b 12%, transparent)',
          border: '1px solid color-mix(in srgb, #f59e0b 40%, transparent)',
          borderRadius: '6px',
          marginBottom: '12px',
          fontSize: '12px',
        }}>
          <span style=${{ color: '#f59e0b', flexShrink: 0 }} title="Malformed plugin.json detected">⚠</span>
          <div>
            <span style=${{ color: '#f59e0b', fontWeight: 600 }}>
              ${pluginWarnings.length} plugin director${pluginWarnings.length === 1 ? 'y has' : 'ies have'} a malformed plugin.json and will be skipped:
            </span>
            <ul style=${{ margin: '4px 0 0 0', paddingLeft: '16px', color: 'var(--text-secondary)' }}>
              ${pluginWarnings.map((w, i) => {
                const REASON_LABELS = {
                  invalid_json: 'JSON 파싱 실패',
                  not_an_object: 'JSON 객체가 아님',
                  io_error: '파일 읽기 실패',
                  other: '알 수 없는 오류',
                };
                const label = REASON_LABELS[w.reason] || w.reason;
                return html`
                  <li key=${i}>
                    <code>${w.dir}</code> — ${label}
                    ${w.message && html`<span style=${{ opacity: 0.7, fontSize: '11px', marginLeft: '4px' }}>(${w.message})</span>`}
                  </li>
                `;
              })}
            </ul>
          </div>
        </div>
      `}
      ${loading && html`<${Loading} />`}
      ${!loading && presets.length === 0 && html`
        <${EmptyState}
          icon="❖"
          text="No presets yet"
          sub="Worker presets bundle plugin directories, MCP servers, and a system prompt for reuse across worker runs. Create one to get started."
        />
      `}
      ${!loading && presets.length > 0 && html`
        <div class="skill-pack-grid">
          ${presets.map(p => html`
            <div class="skill-pack-card" key=${p.id}>
              <div class="skill-pack-header">
                <h3 class="skill-pack-name">${p.name}</h3>
                ${p.isolated && html`<span class="skill-badge skill-badge-ok">Isolated (Tier 2)</span>`}
              </div>
              ${p.description && html`<p class="skill-pack-desc">${p.description}</p>`}
              <div class="small" style=${{ color: 'var(--muted)', marginTop: '6px' }}>
                ${parseMaybeJsonArray(p.plugin_refs).length} plugin${parseMaybeJsonArray(p.plugin_refs).length === 1 ? '' : 's'},
                ${parseMaybeJsonArray(p.mcp_server_ids).length} MCP server${parseMaybeJsonArray(p.mcp_server_ids).length === 1 ? '' : 's'}
                ${p.min_claude_version ? html`, min ${p.min_claude_version}` : ''}
              </div>
              <div class="skill-pack-actions" style=${{ marginTop: '10px', display: 'flex', gap: '6px' }}>
                <button class="ghost small" onClick=${() => { setEditTarget(p); setModalOpen(true); }}>Edit</button>
                <button class="ghost small" onClick=${() => setDeleteTarget(p)}>Delete</button>
              </div>
            </div>
          `)}
        </div>
      `}
      <${PresetModal}
        open=${modalOpen}
        preset=${editTarget}
        pluginRefs=${pluginRefs}
        templates=${templates}
        onClose=${() => { setModalOpen(false); setEditTarget(null); }}
        onSaved=${reload}
      />
      <${DeleteConfirm}
        open=${!!deleteTarget}
        preset=${deleteTarget}
        onClose=${() => setDeleteTarget(null)}
        onConfirm=${() => { setDeleteTarget(null); reload(); }}
      />
    </div>
  `;
}
