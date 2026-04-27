// PackPreviewModal — Preview registry pack details before install/update

import { h } from '../../vendor/preact.module.js';
import { useState } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { Modal } from './Modal.js';
import { COMMON_ACTIONS, PACK_PREVIEW_LABELS, GALLERY_LABELS } from '../lib/copy.js';

export function PackPreviewModal({ open, pack, onClose, onInstall, onUpdate, installing }) {
  const [promptExpanded, setPromptExpanded] = useState(false);

  if (!open || !pack) return null;

  // K-low-2 (Codex r2 BLOCK): URL-installed packs don't carry a
  // registry_id, so a strict id-equality check leaves the install
  // button enabled while the request is in-flight, allowing a
  // double-click that the server will reject with a consumed
  // preview_token. UrlInstallDialog passes 'url' as the installing
  // sentinel for this case; mirror it here.
  const isInstalling = installing != null
    && (installing === pack.registry_id || installing === 'url');
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
    <${Modal} open=${open} onClose=${onClose} labelledBy="pack-preview-title" wide>
      <div class="modal-header">
        <div class="preview-header-title">
          <span class="preview-icon" style=${colorStyle}>${pack.icon || '◉'}</span>
          <div>
            <h2 class="modal-title" id="pack-preview-title">${pack.name}</h2>
            <span class="preview-author">${pack.author || PACK_PREVIEW_LABELS.unknownAuthor}</span>
          </div>
        </div>
        <button class="ghost" onClick=${onClose}>${COMMON_ACTIONS.close}</button>
      </div>
        <div class="modal-body" style=${{ maxHeight: '65vh', overflow: 'auto' }}>
          ${pack.description && html`
            <div class="preview-description">${pack.description}</div>
          `}

          <div class="preview-meta-row">
            <span class="preview-meta-item">
              <span class="preview-meta-label">${PACK_PREVIEW_LABELS.metaCategory}</span>
              <span class="preview-meta-value">${GALLERY_LABELS.categoryLabel[pack.category] || pack.category}</span>
            </span>
            <span class="preview-meta-item">
              <span class="preview-meta-label">${PACK_PREVIEW_LABELS.metaVersion}</span>
              <span class="preview-meta-value">${pack.registry_version || '—'}</span>
            </span>
            <span class="preview-meta-item">
              <span class="preview-meta-label">${PACK_PREVIEW_LABELS.metaTokensFull}</span>
              <span class="preview-meta-value">${estimatedFull}</span>
            </span>
            ${estimatedCompact > 0 && html`
              <span class="preview-meta-item">
                <span class="preview-meta-label">${PACK_PREVIEW_LABELS.metaTokensCompact}</span>
                <span class="preview-meta-value">${estimatedCompact}</span>
              </span>
            `}
            <span class="preview-meta-item">
              <span class="preview-meta-label">${PACK_PREVIEW_LABELS.metaPriority}</span>
              <span class="preview-meta-value">${pack.priority ?? 100}</span>
            </span>
          </div>

          ${pack.installed && pack.updateAvailable && html`
            <div class="preview-update-notice">
              ${PACK_PREVIEW_LABELS.updateNoticePrefix}${pack.localVersion || '?'} → ${pack.registry_version}
            </div>
          `}

          ${pack.source_url_display && html`
            <div class="preview-section">
              <div class="preview-section-header">${PACK_PREVIEW_LABELS.sourceSection}</div>
              <div class="preview-source-info">
                <div class="preview-source-row">
                  <span class="preview-source-label">${PACK_PREVIEW_LABELS.sourceUrlLabel}</span>
                  <span class="preview-source-value mono" title=${pack.source_url_display}>${pack.source_url_display}</span>
                </div>
                ${pack.source_fetched_at && html`
                  <div class="preview-source-row">
                    <span class="preview-source-label">${PACK_PREVIEW_LABELS.sourceFetchedLabel}</span>
                    <span class="preview-source-value">${new Date(pack.source_fetched_at).toLocaleString()}</span>
                  </div>
                `}
                ${pack.source_hash && html`
                  <div class="preview-source-row">
                    <span class="preview-source-label">${PACK_PREVIEW_LABELS.sourceHashLabel}</span>
                    <span class="preview-source-value mono">${String(pack.source_hash).slice(0, 16)}…</span>
                  </div>
                `}
              </div>
            </div>
          `}

          <!-- Prompt -->
          ${pack.prompt_full && html`
            <div class="preview-section">
              <div
                class="preview-section-header clickable"
                onClick=${() => setPromptExpanded(v => !v)}
              >
                <span>${PACK_PREVIEW_LABELS.promptSection}</span>
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
              <div class="preview-section-header">${PACK_PREVIEW_LABELS.mcpSection}</div>
              <div class="preview-mcp-list">
                ${mcpEntries.map(([alias, config]) => html`
                  <div key=${alias} class="preview-mcp-item">
                    <span class="mono">${alias}</span>
                    ${config && config.env_overrides && Object.keys(config.env_overrides).length > 0 && html`
                      <span class="preview-mcp-env">${PACK_PREVIEW_LABELS.mcpEnvPrefix}: ${Object.keys(config.env_overrides).join(', ')}</span>
                    `}
                  </div>
                `)}
              </div>
            </div>
          `}

          <!-- Checklist -->
          ${checklist.length > 0 && html`
            <div class="preview-section">
              <div class="preview-section-header">${PACK_PREVIEW_LABELS.checklistSection}</div>
              <ul class="preview-checklist">
                ${checklist.map((item, i) => html`<li key=${i}>${item}</li>`)}
              </ul>
            </div>
          `}

          <!-- Capabilities -->
          ${capabilities.length > 0 && html`
            <div class="preview-section">
              <div class="preview-section-header">${PACK_PREVIEW_LABELS.capabilitiesSection}</div>
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
            >${isInstalling ? GALLERY_LABELS.installing : GALLERY_LABELS.installBtn}</button>
          `}
          ${pack.updateAvailable && html`
            <button
              class="primary"
              disabled=${isInstalling}
              onClick=${() => onUpdate(pack)}
            >${isInstalling ? GALLERY_LABELS.updating : GALLERY_LABELS.updateBtn}</button>
          `}
          ${pack.installed && !pack.updateAvailable && html`
            <span class="preview-installed-label">${PACK_PREVIEW_LABELS.installedLabelPrefix} (${pack.localVersion || pack.registry_version})</span>
          `}
          <button class="ghost" onClick=${onClose}>${COMMON_ACTIONS.close}</button>
        </div>
    </Modal>
  `;
}
