// PackPreviewModal — Preview registry pack details before install/update

import { h } from '../../vendor/preact.module.js';
import { useState } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { useEscape } from '../lib/hooks.js';

export function PackPreviewModal({ open, pack, onClose, onInstall, onUpdate, installing }) {
  const [promptExpanded, setPromptExpanded] = useState(false);
  useEscape(open, onClose);

  if (!open || !pack) return null;

  const isInstalling = installing === pack.registry_id;
  const mcpEntries = pack.mcp_servers && typeof pack.mcp_servers === 'object'
    ? Object.entries(pack.mcp_servers)
    : [];
  const checklist = Array.isArray(pack.checklist) ? pack.checklist : [];
  const capabilities = Array.isArray(pack.requires_capabilities) ? pack.requires_capabilities : [];
  const colorStyle = pack.color && /^#[0-9a-fA-F]{3,8}$/.test(pack.color)
    ? { color: pack.color }
    : {};

  const estimatedFull = pack.prompt_full ? Math.ceil(pack.prompt_full.length / 4) : 0;
  const estimatedCompact = pack.prompt_compact ? Math.ceil(pack.prompt_compact.length / 4) : 0;

  return html`
    <div class="modal-overlay">
      <div class="modal-backdrop" onClick=${onClose}></div>
      <div class="modal-panel wide">
        <div class="modal-header">
          <div class="preview-header-title">
            <span class="preview-icon" style=${colorStyle}>${pack.icon || '◉'}</span>
            <div>
              <h2 class="modal-title">${pack.name}</h2>
              <span class="preview-author">${pack.author || 'Unknown'}</span>
            </div>
          </div>
          <button class="ghost" onClick=${onClose}>Close</button>
        </div>
        <div class="modal-body" style=${{ maxHeight: '65vh', overflow: 'auto' }}>
          ${pack.description && html`
            <div class="preview-description">${pack.description}</div>
          `}

          <div class="preview-meta-row">
            <span class="preview-meta-item">
              <span class="preview-meta-label">Category</span>
              <span class="preview-meta-value">${pack.category}</span>
            </span>
            <span class="preview-meta-item">
              <span class="preview-meta-label">Version</span>
              <span class="preview-meta-value">${pack.registry_version || '—'}</span>
            </span>
            <span class="preview-meta-item">
              <span class="preview-meta-label">Tokens (full)</span>
              <span class="preview-meta-value">${estimatedFull}</span>
            </span>
            ${estimatedCompact > 0 && html`
              <span class="preview-meta-item">
                <span class="preview-meta-label">Tokens (compact)</span>
                <span class="preview-meta-value">${estimatedCompact}</span>
              </span>
            `}
            <span class="preview-meta-item">
              <span class="preview-meta-label">Priority</span>
              <span class="preview-meta-value">${pack.priority ?? 100}</span>
            </span>
          </div>

          ${pack.installed && pack.updateAvailable && html`
            <div class="preview-update-notice">
              Update available: ${pack.localVersion || '?'} → ${pack.registry_version}
            </div>
          `}

          <!-- Prompt -->
          ${pack.prompt_full && html`
            <div class="preview-section">
              <div
                class="preview-section-header clickable"
                onClick=${() => setPromptExpanded(v => !v)}
              >
                <span>Prompt (Full)</span>
                <span class="preview-expand-icon">${promptExpanded ? '▾' : '▸'}</span>
              </div>
              ${promptExpanded && html`
                <pre class="preview-prompt-content">${pack.prompt_full}</pre>
              `}
            </div>
          `}

          <!-- MCP Servers -->
          ${mcpEntries.length > 0 && html`
            <div class="preview-section">
              <div class="preview-section-header">MCP Servers</div>
              <div class="preview-mcp-list">
                ${mcpEntries.map(([alias, config]) => html`
                  <div key=${alias} class="preview-mcp-item">
                    <span class="mono">${alias}</span>
                    ${config && config.env_overrides && Object.keys(config.env_overrides).length > 0 && html`
                      <span class="preview-mcp-env">env: ${Object.keys(config.env_overrides).join(', ')}</span>
                    `}
                  </div>
                `)}
              </div>
            </div>
          `}

          <!-- Checklist -->
          ${checklist.length > 0 && html`
            <div class="preview-section">
              <div class="preview-section-header">Checklist</div>
              <ul class="preview-checklist">
                ${checklist.map((item, i) => html`<li key=${i}>${item}</li>`)}
              </ul>
            </div>
          `}

          <!-- Capabilities -->
          ${capabilities.length > 0 && html`
            <div class="preview-section">
              <div class="preview-section-header">Required Capabilities (informational)</div>
              <div class="preview-caps">
                ${capabilities.map((cap, i) => html`
                  <span key=${i} class="preview-cap-badge">${cap}</span>
                `)}
              </div>
            </div>
          `}
        </div>
        <div class="modal-footer">
          ${!pack.installed && html`
            <button
              class="primary"
              disabled=${isInstalling}
              onClick=${() => onInstall(pack)}
            >${isInstalling ? 'Installing...' : 'Install'}</button>
          `}
          ${pack.updateAvailable && html`
            <button
              class="primary"
              disabled=${isInstalling}
              onClick=${() => onUpdate(pack)}
            >${isInstalling ? 'Updating...' : 'Update'}</button>
          `}
          ${pack.installed && !pack.updateAvailable && html`
            <span class="preview-installed-label">Installed (${pack.localVersion || pack.registry_version})</span>
          `}
          <button class="ghost" onClick=${onClose}>Close</button>
        </div>
      </div>
    </div>
  `;
}
