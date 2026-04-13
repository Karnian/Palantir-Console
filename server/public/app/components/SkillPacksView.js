// SkillPacksView — Skill pack management page (Phase 3-1).

import { h } from '../../vendor/preact.module.js';
import { useState, useEffect, useMemo } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { apiFetch } from '../lib/api.js';
import { addToast, apiFetchWithToast } from '../lib/toast.js';
import { useEscape } from '../lib/hooks.js';
import { EmptyState } from './EmptyState.js';

function Loading() {
  return html`<div class="loading">Loading...</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SkillPackModal — create / edit skill pack
// ─────────────────────────────────────────────────────────────────────────────

function SkillPackModal({ open, onClose, pack, projects, templates, onSaved }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState('global');
  const [projectId, setProjectId] = useState('');
  const [icon, setIcon] = useState('');
  const [color, setColor] = useState('');
  const [priority, setPriority] = useState(100);
  const [promptFull, setPromptFull] = useState('');
  const [promptCompact, setPromptCompact] = useState('');
  const [mcpServers, setMcpServers] = useState({}); // { alias: { env_overrides: {} } }
  const [checklist, setChecklist] = useState([]);
  const [newCheckItem, setNewCheckItem] = useState('');
  const [conflictPolicy, setConflictPolicy] = useState('warn');
  const [injectChecklist, setInjectChecklist] = useState(false);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('prompt'); // prompt | mcp | checklist
  useEscape(open, onClose);

  useEffect(() => {
    if (open && pack) {
      setName(pack.name || '');
      setDescription(pack.description || '');
      setScope(pack.scope || 'global');
      setProjectId(pack.project_id || '');
      setIcon(pack.icon || '');
      setColor(pack.color || '');
      setPriority(pack.priority ?? 100);
      setPromptFull(pack.prompt_full || '');
      setPromptCompact(pack.prompt_compact || '');
      try { setMcpServers(JSON.parse(pack.mcp_servers || '{}') || {}); } catch { setMcpServers({}); }
      try { setChecklist(JSON.parse(pack.checklist || '[]') || []); } catch { setChecklist([]); }
      setConflictPolicy(pack.conflict_policy || 'warn');
      setInjectChecklist(!!pack.inject_checklist);
      setActiveTab('prompt');
    } else if (open) {
      setName(''); setDescription(''); setScope('global'); setProjectId('');
      setIcon(''); setColor(''); setPriority(100);
      setPromptFull(''); setPromptCompact('');
      setMcpServers({}); setChecklist([]); setNewCheckItem('');
      setConflictPolicy('warn'); setInjectChecklist(false);
      setActiveTab('prompt');
    }
  }, [open, pack]);

  if (!open) return null;

  const estimatedTokens = Math.ceil((promptFull || '').length / 4);
  const estimatedTokensCompact = promptCompact ? Math.ceil(promptCompact.length / 4) : null;

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || undefined,
        scope,
        project_id: scope === 'project' ? projectId : undefined,
        icon: icon.trim() || undefined,
        color: color.trim() || undefined,
        priority: parseInt(priority, 10) || 100,
        prompt_full: promptFull || undefined,
        prompt_compact: promptCompact || undefined,
        mcp_servers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
        checklist: checklist.length > 0 ? checklist : undefined,
        conflict_policy: conflictPolicy,
        inject_checklist: injectChecklist,
      };
      if (pack) {
        await apiFetchWithToast(`/api/skill-packs/${pack.id}`, {
          method: 'PATCH', body: JSON.stringify(body),
        });
      } else {
        await apiFetchWithToast('/api/skill-packs', {
          method: 'POST', body: JSON.stringify(body),
        });
      }
      onSaved();
      onClose();
    } catch { /* toast shown */ }
    setSaving(false);
  };

  const addCheckItem = () => {
    const item = newCheckItem.trim();
    if (!item) return;
    setChecklist(prev => [...prev, item]);
    setNewCheckItem('');
  };

  const removeCheckItem = (idx) => {
    setChecklist(prev => prev.filter((_, i) => i !== idx));
  };

  const addMcpAlias = (alias) => {
    if (!alias || mcpServers[alias]) return;
    setMcpServers(prev => ({ ...prev, [alias]: { env_overrides: {} } }));
  };

  const removeMcpAlias = (alias) => {
    setMcpServers(prev => {
      const next = { ...prev };
      delete next[alias];
      return next;
    });
  };

  const setMcpEnv = (alias, key, value) => {
    setMcpServers(prev => ({
      ...prev,
      [alias]: {
        ...prev[alias],
        env_overrides: { ...(prev[alias]?.env_overrides || {}), [key]: value },
      },
    }));
  };

  const removeMcpEnv = (alias, key) => {
    setMcpServers(prev => {
      const envs = { ...(prev[alias]?.env_overrides || {}) };
      delete envs[key];
      return { ...prev, [alias]: { ...prev[alias], env_overrides: envs } };
    });
  };

  const selectedAliases = Object.keys(mcpServers);
  const availableTemplates = (templates || []).filter(t => !selectedAliases.includes(t.alias));

  return html`
    <div class="modal-overlay">
      <div class="modal-backdrop" onClick=${onClose}></div>
      <div class="modal-panel wide">
        <div class="modal-header">
          <h2 class="modal-title">${pack ? 'Edit Skill Pack' : 'New Skill Pack'}</h2>
          <button class="ghost" onClick=${onClose}>Close</button>
        </div>
        <div class="modal-body">
          <div class="form-row">
            <div class="form-field" style=${{ flex: 1 }}>
              <label class="form-label">Name</label>
              <input class="form-input" value=${name} onInput=${e => setName(e.target.value)} placeholder="e.g. Accessibility Expert" />
            </div>
            <div class="form-field" style=${{ width: '120px' }}>
              <label class="form-label">Priority</label>
              <input class="form-input" type="number" min="0" value=${priority} onInput=${e => setPriority(e.target.value)} />
            </div>
          </div>
          <div class="form-field">
            <label class="form-label">Description</label>
            <input class="form-input" value=${description} onInput=${e => setDescription(e.target.value)} placeholder="Short description..." />
          </div>
          <div class="form-row">
            <div class="form-field" style=${{ width: '140px', flex: 'none' }}>
              <label class="form-label">Scope</label>
              <select class="form-select" style=${{ width: '100%' }} value=${scope} onChange=${e => setScope(e.target.value)}>
                <option value="global">Global</option>
                <option value="project">Project</option>
              </select>
            </div>
            ${scope === 'project' && html`
              <div class="form-field" style=${{ flex: 2 }}>
                <label class="form-label">Project</label>
                <select class="form-select" value=${projectId} onChange=${e => setProjectId(e.target.value)}>
                  <option value="" disabled>Select Project...</option>
                  ${(projects || []).map(p => html`<option key=${p.id} value=${p.id}>${p.name}</option>`)}
                </select>
              </div>
            `}
            <div class="form-field" style=${{ width: '80px' }}>
              <label class="form-label">Icon</label>
              <input class="form-input" value=${icon} onInput=${e => setIcon(e.target.value)} placeholder="\u2726" />
            </div>
            <div class="form-field" style=${{ width: '100px' }}>
              <label class="form-label">Color</label>
              <input class="form-input" value=${color} onInput=${e => setColor(e.target.value)} placeholder="#6fd4a0" />
            </div>
          </div>

          <!-- Tabs -->
          <div class="skill-tabs">
            <button class="skill-tab ${activeTab === 'prompt' ? 'active' : ''}" onClick=${() => setActiveTab('prompt')}>
              Prompt${estimatedTokens > 0 ? ` (~${estimatedTokens} tok)` : ''}
            </button>
            <button class="skill-tab ${activeTab === 'mcp' ? 'active' : ''}" onClick=${() => setActiveTab('mcp')}>
              MCP Servers${selectedAliases.length > 0 ? ` (${selectedAliases.length})` : ''}
            </button>
            <button class="skill-tab ${activeTab === 'checklist' ? 'active' : ''}" onClick=${() => setActiveTab('checklist')}>
              Checklist${checklist.length > 0 ? ` (${checklist.length})` : ''}
            </button>
          </div>

          ${activeTab === 'prompt' && html`
            <div class="form-field">
              <label class="form-label">Full Prompt</label>
              <textarea class="form-textarea" rows="8" value=${promptFull}
                onInput=${e => setPromptFull(e.target.value)}
                placeholder="Full skill instructions for the agent..." />
            </div>
            <div class="form-field">
              <label class="form-label">Compact Prompt (optional)${estimatedTokensCompact !== null ? ` (~${estimatedTokensCompact} tok)` : ''}</label>
              <textarea class="form-textarea" rows="3" value=${promptCompact}
                onInput=${e => setPromptCompact(e.target.value)}
                placeholder="Shortened version for multi-skill token budget..." />
            </div>
          `}

          ${activeTab === 'mcp' && html`
            <div class="skill-mcp-section">
              ${availableTemplates.length > 0 && html`
                <div class="form-field">
                  <label class="form-label">Add MCP Server</label>
                  <select class="form-select" onChange=${e => { addMcpAlias(e.target.value); e.target.value = ''; }}>
                    <option value="">Select template...</option>
                    ${availableTemplates.map(t => html`<option key=${t.alias} value=${t.alias}>${t.alias} — ${t.description || ''}</option>`)}
                  </select>
                </div>
              `}
              ${selectedAliases.length === 0 && html`
                <div class="skill-mcp-empty">No MCP servers configured</div>
              `}
              ${selectedAliases.map(alias => {
                const tpl = (templates || []).find(t => t.alias === alias);
                const envOverrides = mcpServers[alias]?.env_overrides || {};
                let allowedKeys = [];
                try { allowedKeys = JSON.parse(tpl?.allowed_env_keys || '[]'); } catch { /* */ }
                return html`
                  <div class="skill-mcp-item" key=${alias}>
                    <div class="skill-mcp-item-header">
                      <span class="skill-mcp-alias">${alias}</span>
                      <span class="skill-mcp-cmd mono">${tpl ? `${tpl.command} ${(JSON.parse(tpl.args || '[]')).join(' ')}` : 'unknown template'}</span>
                      <button class="ghost small" onClick=${() => removeMcpAlias(alias)}>\u2715</button>
                    </div>
                    ${allowedKeys.length > 0 && html`
                      <div class="skill-mcp-env">
                        ${allowedKeys.map(key => html`
                          <div class="form-row" key=${key} style=${{ alignItems: 'center', gap: '6px' }}>
                            <span class="form-label" style=${{ width: '120px', marginBottom: 0 }}>${key}</span>
                            <input class="form-input" style=${{ flex: 1 }}
                              value=${envOverrides[key] || ''}
                              onInput=${e => setMcpEnv(alias, key, e.target.value)}
                              placeholder="(default)" />
                            ${envOverrides[key] && html`
                              <button class="ghost small" onClick=${() => removeMcpEnv(alias, key)}>\u2715</button>
                            `}
                          </div>
                        `)}
                      </div>
                    `}
                  </div>
                `;
              })}
              <div class="form-field" style=${{ marginTop: '8px' }}>
                <label class="form-label">Conflict Policy</label>
                <select class="form-select" value=${conflictPolicy} onChange=${e => setConflictPolicy(e.target.value)}>
                  <option value="warn">Warn (higher priority wins)</option>
                  <option value="fail">Fail (block execution)</option>
                </select>
              </div>
            </div>
          `}

          ${activeTab === 'checklist' && html`
            <div class="skill-checklist-section">
              ${checklist.map((item, idx) => html`
                <div class="skill-checklist-item" key=${idx}>
                  <span class="skill-checklist-text">${item}</span>
                  <button class="ghost small" onClick=${() => removeCheckItem(idx)}>\u2715</button>
                </div>
              `)}
              <div class="form-row" style=${{ gap: '6px' }}>
                <input class="form-input" style=${{ flex: 1 }} value=${newCheckItem}
                  onInput=${e => setNewCheckItem(e.target.value)}
                  onKeyDown=${e => { if (e.key === 'Enter') { e.preventDefault(); addCheckItem(); } }}
                  placeholder="Add checklist item..." />
                <button class="ghost" onClick=${addCheckItem} disabled=${!newCheckItem.trim()}>Add</button>
              </div>
              <label class="skill-checklist-inject" style=${{ marginTop: '8px' }}>
                <input type="checkbox" checked=${injectChecklist} onChange=${e => setInjectChecklist(e.target.checked)} />
                <span>Inject checklist into agent prompt</span>
              </label>
            </div>
          `}

          <!-- Adapter compatibility -->
          <div class="skill-adapter-compat">
            <span class="form-label">Adapter Support</span>
            <div class="skill-adapter-badges">
              <span class="skill-badge skill-badge-ok">Claude \u2714 Full</span>
              <span class="skill-badge skill-badge-ok">Codex \u2714 Prompt</span>
              <span class="skill-badge skill-badge-ok">Gemini \u2714 Prompt</span>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="ghost" onClick=${onClose}>Cancel</button>
          <button class="primary" onClick=${handleSave}
            disabled=${saving || !name.trim() || (scope === 'project' && !projectId)}>
            ${saving ? 'Saving...' : pack ? 'Update' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Delete confirmation modal
// ─────────────────────────────────────────────────────────────────────────────

function DeleteConfirm({ open, pack, onClose, onConfirm }) {
  const [deleting, setDeleting] = useState(false);
  useEscape(open, onClose);
  if (!open || !pack) return null;

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await apiFetchWithToast(`/api/skill-packs/${pack.id}`, { method: 'DELETE' });
      onConfirm();
    } catch { /* toast shown */ }
    setDeleting(false);
  };

  return html`
    <div class="modal-overlay">
      <div class="modal-backdrop" onClick=${onClose}></div>
      <div class="modal-panel" style=${{ maxWidth: '420px' }}>
        <div class="modal-header">
          <h2 class="modal-title">Delete Skill Pack</h2>
        </div>
        <div class="modal-body">
          <p>Delete <strong>${pack.name}</strong>? This will remove all project and task bindings.</p>
        </div>
        <div class="modal-footer">
          <button class="ghost" onClick=${onClose}>Cancel</button>
          <button class="danger" onClick=${handleDelete} disabled=${deleting}>
            ${deleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// SkillPacksView — main view
// ─────────────────────────────────────────────────────────────────────────────

export function SkillPacksView({ projects }) {
  const [packs, setPacks] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editPack, setEditPack] = useState(null);
  const [deletePack, setDeletePack] = useState(null);
  const [filterScope, setFilterScope] = useState('all'); // all | global | project
  const [filterProjectId, setFilterProjectId] = useState('');
  const [showTemplates, setShowTemplates] = useState(false);

  const loadData = async () => {
    try {
      const [packsRes, tplRes] = await Promise.all([
        apiFetch('/api/skill-packs'),
        apiFetch('/api/skill-packs/templates'),
      ]);
      setPacks(packsRes.skill_packs || []);
      setTemplates(tplRes.templates || []);
    } catch (err) {
      addToast(err.message, 'error');
    }
    setLoading(false);
  };

  useEffect(() => { loadData(); }, []);

  const filteredPacks = useMemo(() => {
    let list = packs;
    if (filterScope === 'global') list = list.filter(p => p.scope === 'global');
    else if (filterScope === 'project') {
      list = list.filter(p => p.scope === 'project');
      if (filterProjectId) list = list.filter(p => p.project_id === filterProjectId);
    }
    return list.sort((a, b) => (a.priority || 100) - (b.priority || 100));
  }, [packs, filterScope, filterProjectId]);

  // Export pack as JSON download (Phase 4-3)
  const handleExport = async (pack) => {
    try {
      const data = await apiFetch(`/api/skill-packs/${pack.id}/export`);
      const blob = new Blob([JSON.stringify(data.skill_pack, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `skill-pack-${pack.name.replace(/\s+/g, '-').toLowerCase()}.json`;
      a.click(); URL.revokeObjectURL(url);
    } catch (err) { addToast(err.message, 'error'); }
  };

  // Import pack from JSON file (Phase 4-3)
  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        await apiFetchWithToast('/api/skill-packs/import', {
          method: 'POST',
          body: JSON.stringify({ skill_pack: parsed }),
        });
        loadData();
      } catch (err) { addToast(err.message || 'Invalid JSON', 'error'); }
    };
    input.click();
  };

  if (loading) return html`<${Loading} />`;

  return html`
    <div class="skill-packs-view">
      <div class="skill-packs-header">
        <h1 class="skill-packs-title">Skill Packs</h1>
        <div class="skill-packs-actions">
          <button class="ghost small" onClick=${handleImport}>Import</button>
          <button class="ghost small" onClick=${() => setShowTemplates(v => !v)}>
            ${showTemplates ? 'Hide Templates' : 'MCP Templates'}
          </button>
          <button class="primary" onClick=${() => { setEditPack(null); setShowModal(true); }}>New Skill Pack</button>
        </div>
      </div>

      <!-- Filters -->
      <div class="skill-packs-filters">
        <select class="form-select small" value=${filterScope} onChange=${e => { setFilterScope(e.target.value); setFilterProjectId(''); }}>
          <option value="all">All Scopes</option>
          <option value="global">Global</option>
          <option value="project">Project</option>
        </select>
        ${filterScope === 'project' && html`
          <select class="form-select small" value=${filterProjectId} onChange=${e => setFilterProjectId(e.target.value)}>
            <option value="">All Projects</option>
            ${(projects || []).map(p => html`<option key=${p.id} value=${p.id}>${p.name}</option>`)}
          </select>
        `}
        <span class="skill-packs-count">${filteredPacks.length} pack${filteredPacks.length !== 1 ? 's' : ''}</span>
      </div>

      <!-- Token Budget Overview (Phase 4-1) -->
      ${filteredPacks.length > 0 && (() => {
        const BUDGET = 4000;
        const totalTokens = filteredPacks.reduce((s, p) => s + (p.estimated_tokens || 0), 0);
        const pct = Math.min(100, (totalTokens / BUDGET) * 100);
        const color = pct > 90 ? 'var(--status-failed)' : pct > 70 ? '#f59e0b' : 'var(--success)';
        return html`
          <div class="skill-budget-overview">
            <div class="skill-budget-header">
              <span class="form-label" style=${{ marginBottom: 0 }}>Token Budget</span>
              <span style=${{ fontSize: '11px', color: 'var(--text-muted)' }}>${totalTokens} / ${BUDGET}</span>
            </div>
            <div class="skill-budget-bar" style=${{ height: '8px' }}>
              <div class="skill-budget-fill" style=${{ width: `${pct}%`, background: color }}></div>
            </div>
            <div class="skill-budget-breakdown">
              ${filteredPacks.filter(p => (p.estimated_tokens || 0) > 0).map(p => {
                const w = Math.max(2, ((p.estimated_tokens || 0) / BUDGET) * 100);
                return html`
                  <div class="skill-budget-item" key=${p.id} title="${p.name}: ${p.estimated_tokens} tokens">
                    <div class="skill-budget-item-bar" style=${{ width: `${w}%`, background: p.color || 'var(--accent)' }}></div>
                    <span class="skill-budget-item-label">${p.name} (${p.estimated_tokens})</span>
                  </div>
                `;
              })}
            </div>
          </div>
        `;
      })()}

      <!-- MCP Templates (collapsible) -->
      ${showTemplates && html`
        <div class="skill-templates-section">
          <h3 class="skill-templates-title">MCP Server Templates</h3>
          <div class="skill-templates-table">
            <div class="skill-templates-row skill-templates-header-row">
              <span>Alias</span><span>Command</span><span>Description</span><span>Allowed Env Keys</span>
            </div>
            ${templates.map(t => {
              let envKeys = [];
              try { envKeys = JSON.parse(t.allowed_env_keys || '[]'); } catch { /* */ }
              let args = [];
              try { args = JSON.parse(t.args || '[]'); } catch { /* */ }
              return html`
                <div class="skill-templates-row" key=${t.id}>
                  <span class="mono">${t.alias}</span>
                  <span class="mono">${t.command} ${args.join(' ')}</span>
                  <span>${t.description || ''}</span>
                  <span class="mono">${envKeys.join(', ') || '\u2013'}</span>
                </div>
              `;
            })}
          </div>
        </div>
      `}

      <!-- Pack list -->
      ${filteredPacks.length === 0 && html`
        <${EmptyState} icon="\u2726" title="No Skill Packs" subtitle="Create your first skill pack to inject capabilities into agents." />
      `}
      <div class="skill-packs-list">
        ${filteredPacks.map(pack => {
          const tokens = pack.estimated_tokens || 0;
          let mcpCount = 0;
          try { mcpCount = Object.keys(JSON.parse(pack.mcp_servers || '{}')).length; } catch { /* */ }
          let checkCount = 0;
          try { checkCount = JSON.parse(pack.checklist || '[]').length; } catch { /* */ }
          const proj = pack.project_id ? (projects || []).find(p => p.id === pack.project_id) : null;

          return html`
            <div class="skill-pack-card" key=${pack.id} onClick=${() => { setEditPack(pack); setShowModal(true); }}>
              <div class="skill-pack-card-header">
                <span class="skill-pack-icon" style=${{ color: pack.color || undefined }}>${pack.icon || '\u2726'}</span>
                <span class="skill-pack-name">${pack.name}</span>
                <span class="skill-pack-priority">P${pack.priority ?? 100}</span>
              </div>
              ${pack.description && html`<div class="skill-pack-desc">${pack.description}</div>`}
              <div class="skill-pack-meta">
                <span class="skill-pack-scope ${pack.scope}">${pack.scope}${proj ? `: ${proj.name}` : ''}</span>
                ${tokens > 0 && html`<span class="skill-pack-tokens">${tokens} tok</span>`}
                ${mcpCount > 0 && html`<span class="skill-pack-mcp">${mcpCount} MCP</span>`}
                ${checkCount > 0 && html`<span class="skill-pack-check">\u2713 ${checkCount}</span>`}
              </div>
              <div class="skill-pack-card-actions" onClick=${e => e.stopPropagation()}>
                <button class="ghost small" onClick=${() => { setEditPack(pack); setShowModal(true); }}>Edit</button>
                <button class="ghost small" onClick=${() => handleExport(pack)}>Export</button>
                <button class="ghost small danger-text" onClick=${() => setDeletePack(pack)}>Delete</button>
              </div>
            </div>
          `;
        })}
      </div>

      <${SkillPackModal}
        open=${showModal}
        onClose=${() => { setShowModal(false); setEditPack(null); }}
        pack=${editPack}
        projects=${projects}
        templates=${templates}
        onSaved=${() => { setShowModal(false); setEditPack(null); loadData(); }}
      />
      <${DeleteConfirm}
        open=${!!deletePack}
        pack=${deletePack}
        onClose=${() => setDeletePack(null)}
        onConfirm=${() => { setDeletePack(null); loadData(); }}
      />
    </div>
  `;
}
