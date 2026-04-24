// UrlInstallDialog — "Install from URL" flow for Skill Pack Gallery v1.1

import { h } from '../../vendor/preact.module.js';
import { useState } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { apiFetch } from '../lib/api.js';
import { addToast, apiFetchWithToast } from '../lib/toast.js';
import { PackPreviewModal } from './PackPreviewModal.js';
import { Modal } from './Modal.js';

export function UrlInstallDialog({ open, onClose, onInstalled }) {
  const [url, setUrl] = useState('');
  const [fetching, setFetching] = useState(false);
  const [preview, setPreview] = useState(null); // { pack, hash, preview_token, source_url_display }
  const [installing, setInstalling] = useState(false);

  const resetState = () => {
    setUrl('');
    setPreview(null);
    setFetching(false);
    setInstalling(false);
  };

  const handleClose = () => {
    resetState();
    onClose();
  };

  const handleFetch = async () => {
    if (!url.trim()) return;
    if (!/^https:\/\//i.test(url.trim())) {
      addToast('URL must start with https://', 'error');
      return;
    }
    setFetching(true);
    try {
      const data = await apiFetch('/api/skill-packs/registry/install-url', {
        method: 'POST',
        body: JSON.stringify({ url: url.trim(), dry_run: true }),
      });
      setPreview(data);
    } catch (err) {
      addToast(err.message || 'Failed to fetch URL', 'error');
    }
    setFetching(false);
  };

  const handleConfirmInstall = async () => {
    if (!preview) return;
    setInstalling(true);
    try {
      const data = await apiFetchWithToast('/api/skill-packs/registry/install-url', {
        method: 'POST',
        body: JSON.stringify({
          url: url.trim(),
          preview_token: preview.preview_token,
          expected_hash: preview.hash,
        }),
      });
      addToast(`Installed "${data.skill_pack.name}" from URL`, 'success');
      resetState();
      onInstalled && onInstalled();
      onClose();
    } catch { /* toast shown */ }
    setInstalling(false);
  };

  if (!open) return null;

  // If we have preview data, show the PackPreviewModal
  if (preview) {
    const packWithMeta = {
      ...preview.pack,
      source_url_display: preview.source_url_display,
      source_fetched_at: new Date().toISOString(),
      source_hash: preview.hash,
      installed: false,
      _preview_context: 'url-dry-run',
    };
    return html`
      <${PackPreviewModal}
        open=${true}
        pack=${packWithMeta}
        onClose=${handleClose}
        onInstall=${handleConfirmInstall}
        installing=${installing ? preview.pack.registry_id || 'url' : null}
      />
    `;
  }

  // URL input dialog
  return html`
    <${Modal} open=${open} onClose=${handleClose} labelledBy="url-install-title">
      <div class="modal-header">
        <h2 class="modal-title" id="url-install-title">Install from URL</h2>
        <button class="ghost" onClick=${handleClose}>Close</button>
      </div>
      <div class="modal-body">
        <div class="url-install-help">
          Paste an <b>https://</b> URL pointing to a skill pack JSON file (e.g. GitHub raw, gist).
          The server will fetch, validate, and preview before install.
        </div>
        <div class="form-group">
          <label class="form-label" for="url-install-input">Skill Pack URL</label>
          <input
            id="url-install-input"
            type="url"
            class="form-input"
            placeholder="https://raw.githubusercontent.com/..."
            value=${url}
            onInput=${e => setUrl(e.target.value)}
            onKeyDown=${e => { if (e.key === 'Enter') handleFetch(); }}
          />
        </div>
        <div class="url-install-note">
          <strong>Security:</strong> Only HTTPS accepted. Private IPs, loopback,
          and metadata endpoints are blocked. Response size capped at 256KB.
        </div>
      </div>
      <div class="modal-footer">
        <button
          class="primary"
          disabled=${fetching || !url.trim()}
          onClick=${handleFetch}
        >${fetching ? 'Fetching...' : 'Fetch & Preview'}</button>
        <button class="ghost" onClick=${handleClose}>Cancel</button>
      </div>
    </Modal>
  `;
}
