// AgentsView + AgentModal + AgentDetailModal — Agent profiles management view.
// Extracted from server/public/app.js as part of P5-4 (ESM phase 4b).

import { h } from '../../vendor/preact.module.js';
import { useState, useEffect } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { apiFetch } from '../lib/api.js';
import { apiFetchWithToast } from '../lib/toast.js';
import { EmptyState } from './EmptyState.js';
import { Modal } from './Modal.js';

// ─────────────────────────────────────────────────────────────────────────────
// Loading spinner — minimal inline component (avoids coupling to app.js Loading)
// ─────────────────────────────────────────────────────────────────────────────

function Loading() {
  return html`<div class="loading">Loading...</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentModal — create / edit agent profile (module-internal)
// ─────────────────────────────────────────────────────────────────────────────

function AgentModal({ open, onClose, agent, onSaved }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('claude-code');
  const [command, setCommand] = useState('');
  const [argsTemplate, setArgsTemplate] = useState('');
  const [icon, setIcon] = useState('');
  const [color, setColor] = useState('');
  const [maxConcurrent, setMaxConcurrent] = useState(1);
  const [mcpTools, setMcpTools] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && agent) {
      setName(agent.name || '');
      setType(agent.type || 'claude-code');
      setCommand(agent.command || '');
      setArgsTemplate(agent.args_template || '');
      setIcon(agent.icon || '');
      setColor(agent.color || '');
      setMaxConcurrent(agent.max_concurrent || 1);
      try {
        const caps = JSON.parse(agent.capabilities_json || '{}');
        setMcpTools(Array.isArray(caps.mcp_tools) ? caps.mcp_tools.join('\n') : '');
      } catch { setMcpTools(''); }
    } else if (open) {
      setName(''); setType('claude-code'); setCommand(''); setArgsTemplate('');
      setIcon(''); setColor(''); setMaxConcurrent(1); setMcpTools('');
    }
  }, [open, agent]);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const parsedMcpTools = mcpTools.trim().split('\n').map(s => s.trim()).filter(Boolean);
      const capsObj = parsedMcpTools.length > 0 ? { mcp_tools: parsedMcpTools } : {};
      const body = {
        name: name.trim(),
        type,
        command: command.trim() || undefined,
        args_template: argsTemplate.trim() || undefined,
        icon: icon.trim() || undefined,
        color: color.trim() || undefined,
        max_concurrent: parseInt(maxConcurrent, 10) || 1,
        capabilities_json: JSON.stringify(capsObj),
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
    <${Modal} open=${open} onClose=${onClose} labelledBy="agent-modal-title">
      <div class="modal-header">
        <h2 class="modal-title" id="agent-modal-title">${agent ? 'Edit Agent' : 'New Agent'}</h2>
        <button class="ghost" onClick=${onClose}>Close</button>
      </div>
      <div class="modal-body">
        <div class="form-field">
          <label class="form-label" for="agent-name">Name</label>
          <input id="agent-name" class="form-input" value=${name} onInput=${e => setName(e.target.value)} placeholder="Agent name" />
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
          <div class="form-field">
            <label class="form-label">MCP Tools</label>
            <textarea class="form-input" rows="3" value=${mcpTools}
              onInput=${e => setMcpTools(e.target.value)}
              placeholder="mcp__claude_ai_Slack__*\nmcp__claude_ai_Notion__*" />
            <small class="form-hint">One pattern per line. Supports wildcards (e.g. mcp__slack__*)</small>
          </div>
        </div>
        <div class="modal-footer">
          <button class="ghost" onClick=${onClose}>Cancel</button>
          <button class="primary" onClick=${handleSave} disabled=${saving || !name.trim()}>
            ${saving ? 'Saving...' : agent ? 'Update' : 'Create'}
          </button>
        </div>
    </Modal>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentDetailModal — usage / detail panel (module-internal)
// ─────────────────────────────────────────────────────────────────────────────

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
    <${Modal} open=${open && !!agent} onClose=${onClose} labelledBy="agent-detail-title" panelClass="agent-detail-panel">
      <div class="agent-detail-header">
        <div class="agent-detail-header-title" id="agent-detail-title">Agent Detail</div>
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
          ${(() => {
            try {
              const caps = JSON.parse(agent.capabilities_json || '{}');
              if (Array.isArray(caps.mcp_tools) && caps.mcp_tools.length > 0) {
                return html`
                  <div class="agent-detail-field" style=${{ gridColumn: '1 / -1' }}>
                    <span class="agent-detail-field-label">MCP Tools</span>
                    <span class="agent-detail-field-value mono" style=${{ whiteSpace: 'pre-wrap', fontSize: '0.75rem' }}>${caps.mcp_tools.join('\n')}</span>
                  </div>
                `;
              }
            } catch { /* ignore */ }
            return null;
          })()}
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
    </Modal>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentsView — exported
// ─────────────────────────────────────────────────────────────────────────────

export function AgentsView({ agents, loading, reloadAgents }) {
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
