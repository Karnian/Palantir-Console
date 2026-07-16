// AgentsView + AgentModal + AgentDetailModal — Agent profiles management view.
// Extracted from server/public/app.js as part of P5-4 (ESM phase 4b).

import { h } from '../../vendor/preact.module.js';
import { useState, useEffect } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { apiFetch } from '../lib/api.js';
import { apiFetchWithToast } from '../lib/toast.js';
import { COMMON_ACTIONS, AGENTS_LABELS } from '../lib/copy.js';
import { EmptyState } from './EmptyState.js';
import { Modal } from './Modal.js';

// ─────────────────────────────────────────────────────────────────────────────
// Loading spinner — minimal inline component (avoids coupling to app.js Loading)
// ─────────────────────────────────────────────────────────────────────────────

function Loading() {
  return html`<div class="loading">${COMMON_ACTIONS.loading}</div>`;
}

function vendorFromCommand(command) {
  if (command.includes('codex')) return 'codex';
  if (command.includes('claude')) return 'claude';
  return 'other';
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentModal — create / edit agent profile (module-internal)
// ─────────────────────────────────────────────────────────────────────────────

function AgentModal({ open, onClose, agent, onSaved }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('claude-code');
  const [command, setCommand] = useState('');
  const [argsTemplate, setArgsTemplate] = useState('');
  const [model, setModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
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
      setModel(agent.model || '');
      setReasoningEffort(agent.reasoning_effort || '');
      setIcon(agent.icon || '');
      setColor(agent.color || '');
      setMaxConcurrent(agent.max_concurrent || 1);
      try {
        const caps = JSON.parse(agent.capabilities_json || '{}');
        setMcpTools(Array.isArray(caps.mcp_tools) ? caps.mcp_tools.join('\n') : '');
      } catch { setMcpTools(''); }
    } else if (open) {
      setName(''); setType('claude-code'); setCommand(''); setArgsTemplate('');
      setModel(''); setReasoningEffort('');
      setIcon(''); setColor(''); setMaxConcurrent(1); setMcpTools('');
    }
  }, [open, agent]);

  const vendor = vendorFromCommand(command);

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
        model: model.trim() || null,
        reasoning_effort: reasoningEffort || null,
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
        <h2 class="modal-title" id="agent-modal-title">${agent ? AGENTS_LABELS.modalEdit : AGENTS_LABELS.modalNew}</h2>
        <button class="ghost" onClick=${onClose}>${COMMON_ACTIONS.close}</button>
      </div>
      <div class="modal-body">
        <div class="form-field">
          <label class="form-label" for="agent-name">${AGENTS_LABELS.fieldName}</label>
          <input id="agent-name" class="form-input" value=${name} onInput=${e => setName(e.target.value)} placeholder=${AGENTS_LABELS.namePlaceholder} />
          </div>
          <div class="form-field">
            <label class="form-label" for="agent-type">${AGENTS_LABELS.fieldType}</label>
            <select id="agent-type" class="form-select" value=${type} onChange=${e => {
              const t = e.target.value;
              setType(t);
              if (!agent) {
                const presets = {
                  'claude-code': { cmd: 'claude', args: '-p {prompt} --permission-mode bypassPermissions' },
                  'codex': { cmd: 'codex', args: 'exec --full-auto --skip-git-repo-check {prompt}' },
                  'gemini': { cmd: 'gemini', args: '-p {prompt} --yolo' },
                  'opencode': { cmd: 'opencode', args: '{prompt}' },
                };
                const p = presets[t];
                if (p) { setCommand(p.cmd); setArgsTemplate(p.args); }
                if (t === 'codex') { setModel(''); setReasoningEffort('high'); }
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
            <label class="form-label" for="agent-command">${AGENTS_LABELS.fieldCommand}</label>
            <input id="agent-command" class="form-input" value=${command} onInput=${e => setCommand(e.target.value)} placeholder=${AGENTS_LABELS.commandPlaceholder} />
          </div>
          ${(vendor === 'codex' || vendor === 'claude') && html`
            <div class="form-field">
              <label class="form-label" for="agent-model">Model</label>
              <input id="agent-model" class="form-input" value=${model} onInput=${e => setModel(e.target.value)} />
            </div>
          `}
          ${vendor === 'codex' && html`
            <div class="form-field">
              <label class="form-label" for="agent-reasoning-effort">Reasoning effort</label>
              <select id="agent-reasoning-effort" class="form-select" value=${reasoningEffort} onChange=${e => setReasoningEffort(e.target.value)}>
                <option value="">(none)</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
            </div>
          `}
          <div class="form-field">
            <label class="form-label" for="agent-args">${AGENTS_LABELS.fieldArgsTemplate}</label>
            <input id="agent-args" class="form-input" value=${argsTemplate} onInput=${e => setArgsTemplate(e.target.value)} placeholder=${AGENTS_LABELS.argsTemplatePlaceholder} />
          </div>
          <div class="form-field">
            <label class="form-label" for="agent-icon">${AGENTS_LABELS.fieldIcon}</label>
            <input id="agent-icon" class="form-input" value=${icon} onInput=${e => setIcon(e.target.value)} placeholder=${AGENTS_LABELS.iconPlaceholder} />
          </div>
          <div class="form-field">
            <label class="form-label" for="agent-color">${AGENTS_LABELS.fieldColor}</label>
            <input id="agent-color" class="form-input" value=${color} onInput=${e => setColor(e.target.value)} placeholder="#6fd4a0" />
          </div>
          <div class="form-field">
            <label class="form-label" for="agent-max-concurrent">${AGENTS_LABELS.fieldMaxConcurrent}</label>
            <input id="agent-max-concurrent" class="form-input" type="number" min="1" value=${maxConcurrent} onInput=${e => setMaxConcurrent(e.target.value)} />
          </div>
          <div class="form-field">
            <label class="form-label" for="agent-mcp-tools">${AGENTS_LABELS.fieldMcpTools}</label>
            <textarea id="agent-mcp-tools" class="form-input" rows="3" value=${mcpTools}
              onInput=${e => setMcpTools(e.target.value)}
              placeholder="mcp__claude_ai_Slack__*\nmcp__claude_ai_Notion__*" />
            <small class="form-hint">${AGENTS_LABELS.mcpToolsHint}</small>
          </div>
        </div>
        <div class="modal-footer">
          <button class="ghost" onClick=${onClose}>${COMMON_ACTIONS.cancel}</button>
          <button class="primary" onClick=${handleSave} disabled=${saving || !name.trim()}>
            ${saving ? COMMON_ACTIONS.saving : agent ? COMMON_ACTIONS.update : COMMON_ACTIONS.create}
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
    if (diff <= 0) return AGENTS_LABELS.resetNow;
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
    const barColor = pct > 50 ? 'var(--success)' : pct > 20 ? 'var(--info)' : pct > 10 ? 'var(--warning)' : 'var(--status-failed)';
    return html`
      <div class="agent-usage-bar-track">
        <div class="agent-usage-bar-fill" style=${{ width: `${remaining}%`, background: barColor }} />
      </div>
    `;
  };

  return html`
    <${Modal} open=${open && !!agent} onClose=${onClose} labelledBy="agent-detail-title" panelClass="agent-detail-panel">
      <div class="agent-detail-header">
        <div class="agent-detail-header-title" id="agent-detail-title">${AGENTS_LABELS.detailTitle}</div>
        <div class="agent-detail-header-actions">
          <button class="ghost" onClick=${() => onEdit(agent)}>${COMMON_ACTIONS.edit}</button>
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
        <div class="agent-detail-section-title">${AGENTS_LABELS.configurationSection}</div>
        <div class="agent-detail-grid">
          ${agent.command && html`
            <div class="agent-detail-field">
              <span class="agent-detail-field-label">${AGENTS_LABELS.fieldCommand}</span>
              <span class="agent-detail-field-value mono">${agent.command}</span>
            </div>
          `}
          ${agent.args_template && html`
            <div class="agent-detail-field">
              <span class="agent-detail-field-label">${AGENTS_LABELS.fieldArgsTemplate}</span>
              <span class="agent-detail-field-value mono">${agent.args_template}</span>
            </div>
          `}
          <div class="agent-detail-field">
            <span class="agent-detail-field-label">${AGENTS_LABELS.fieldMaxConcurrent}</span>
            <span class="agent-detail-field-value">${agent.max_concurrent || 1}</span>
          </div>
          <div class="agent-detail-field">
            <span class="agent-detail-field-label">${AGENTS_LABELS.fieldRunningNow}</span>
            <span class="agent-detail-field-value">${runningCount}</span>
          </div>
          ${(() => {
            try {
              const caps = JSON.parse(agent.capabilities_json || '{}');
              if (Array.isArray(caps.mcp_tools) && caps.mcp_tools.length > 0) {
                return html`
                  <div class="agent-detail-field" style=${{ gridColumn: '1 / -1' }}>
                    <span class="agent-detail-field-label">${AGENTS_LABELS.fieldMcpTools}</span>
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
          <div class="agent-detail-section-title">${AGENTS_LABELS.usageSection}</div>
          <button class="ghost small" onClick=${loadUsage} disabled=${loadingUsage}>
            ${loadingUsage ? AGENTS_LABELS.usageRefreshing : AGENTS_LABELS.usageRefresh}
          </button>
        </div>
        ${loadingUsage && !usage && html`<div class="agent-detail-loading">${AGENTS_LABELS.usageLoading}</div>`}
        ${error && html`<div class="agent-detail-error">${error}</div>`}
        ${usage && html`
          <div class="agent-usage-card">
            ${usage.account ? html`
              <div class="agent-usage-account">
                ${usage.account.email && html`
                  <div class="agent-detail-field">
                    <span class="agent-detail-field-label">${AGENTS_LABELS.usageAccountLabel}</span>
                    <span class="agent-detail-field-value">${usage.account.email}</span>
                  </div>
                `}
                ${usage.account.planType && html`
                  <div class="agent-detail-field">
                    <span class="agent-detail-field-label">${AGENTS_LABELS.usagePlanLabel}</span>
                    <span class="agent-detail-field-value">${usage.account.planType}</span>
                  </div>
                `}
                ${usage.account.type && html`
                  <div class="agent-detail-field">
                    <span class="agent-detail-field-label">${AGENTS_LABELS.usageAuthTypeLabel}</span>
                    <span class="agent-detail-field-value">${usage.account.type}</span>
                  </div>
                `}
              </div>
            ` : ''}
            ${usage.requiresOpenaiAuth && !usage.account && html`
              <div class="agent-detail-warning">${AGENTS_LABELS.usageOpenaiLoginRequired}</div>
            `}
            ${(usage.limits || []).map(limit => html`
              <div class="agent-usage-limit">
                <div class="agent-usage-limit-header">
                  <span class="agent-usage-limit-label">${limit.label}</span>
                  ${limit.remainingPct !== null && limit.remainingPct !== undefined
                    ? html`<span class="agent-usage-limit-pct">${Math.round(limit.remainingPct)}${AGENTS_LABELS.usageRemainingSuffix}</span>`
                    : ''}
                </div>
                ${renderBar(limit.remainingPct)}
                ${limit.errorMessage ? html`<div class="agent-usage-limit-error">${limit.errorMessage}</div>` : ''}
                ${limit.resetAt ? html`
                  <div class="agent-usage-limit-reset">${AGENTS_LABELS.usageResetsInPrefix} ${formatResetTime(limit.resetAt) || new Date(limit.resetAt).toLocaleString()}</div>
                ` : ''}
              </div>
            `)}
            ${usage.updatedAt && html`
              <div class="agent-usage-updated">${AGENTS_LABELS.usageUpdatedPrefix}: ${new Date(usage.updatedAt).toLocaleString()}</div>
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
    if (!confirm(`${AGENTS_LABELS.deleteConfirmPrefix} "${agent.name}"${AGENTS_LABELS.deleteConfirmSuffix}`)) return;
    try {
      await apiFetchWithToast(`/api/agents/${agent.id}`, { method: 'DELETE' });
      if (selectedAgent?.id === agent.id) setSelectedAgent(null);
      reloadAgents();
    } catch { /* toast already shown */ }
  };

  if (loading) return html`<${Loading} />`;

  return html`
    <div class="agents-view" data-view="agents">
      <div class="agents-header">
        <h1 class="agents-title">${AGENTS_LABELS.pageTitle}</h1>
        <button class="primary" onClick=${() => { setEditAgent(null); setShowModal(true); }}>+ ${AGENTS_LABELS.newAgent}</button>
      </div>
      <div class="agents-list">
        ${agents.length === 0 && html`
          <${EmptyState}
            icon="\u2699"
            text=${AGENTS_LABELS.emptyText}
            sub=${AGENTS_LABELS.emptySub}
          />
        `}
        ${agents.map(a => html`
          <article key=${a.id} class="agent-card">
            <h2 class="card-heading"><button class="agent-card-trigger" onClick=${() => setSelectedAgent(a)} aria-label=${a.name}>
              <span class="agent-card-top">
                <span class="agent-card-icon" style=${a.color ? `color: ${a.color}` : ''}>${a.icon || '\u2699'}</span>
                <span class="agent-card-info">
                  <span class="agent-card-name">${a.name}</span>
                  <span class="agent-card-type">${a.type || 'custom'}</span>
                </span>
              </span>
              ${a.command && html`<span class="agent-card-detail"><span class="agent-detail-label">${AGENTS_LABELS.fieldCommand}:</span> ${a.command}</span>`}
              <span class="agent-card-detail"><span class="agent-detail-label">${AGENTS_LABELS.fieldMaxConcurrent}:</span> ${a.max_concurrent || 1}</span>
            </button></h2>
            <div class="agent-card-actions">
              <button class="ghost" onClick=${() => { setEditAgent(a); setShowModal(true); }}>${COMMON_ACTIONS.edit}</button>
              <button class="ghost danger" onClick=${() => handleDelete(a)}>${COMMON_ACTIONS.delete}</button>
            </div>
          </article>
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
