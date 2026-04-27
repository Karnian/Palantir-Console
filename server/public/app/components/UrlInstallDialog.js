// UrlInstallDialog — "Install from URL" flow for Skill Pack Gallery v1.1

import { h } from '../../vendor/preact.module.js';
import { useState } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { apiFetch } from '../lib/api.js';
import { addToast, apiFetchWithToast } from '../lib/toast.js';
import { PackPreviewModal } from './PackPreviewModal.js';
import { Modal } from './Modal.js';
import { COMMON_ACTIONS, URL_INSTALL_LABELS } from '../lib/copy.js';

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
      addToast(URL_INSTALL_LABELS.invalidHttpsToast, 'error');
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
      addToast(err.message || URL_INSTALL_LABELS.fetchFailedToast, 'error');
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
      addToast(`"${data.skill_pack.name}"${URL_INSTALL_LABELS.installedFromUrlToastSuffix}`, 'success');
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
        <h2 class="modal-title" id="url-install-title">${URL_INSTALL_LABELS.modalTitle}</h2>
        <button class="ghost" onClick=${handleClose}>${COMMON_ACTIONS.close}</button>
      </div>
      <div class="modal-body">
        <div class="url-install-help">
          ${URL_INSTALL_LABELS.helpText}
        </div>
        <div class="form-group">
          <label class="form-label" for="url-install-input">${URL_INSTALL_LABELS.fieldUrlLabel}</label>
          <input
            id="url-install-input"
            type="url"
            class="form-input"
            placeholder=${URL_INSTALL_LABELS.urlPlaceholder}
            value=${url}
            onInput=${e => setUrl(e.target.value)}
            onKeyDown=${e => { if (e.key === 'Enter') handleFetch(); }}
          />
        </div>
        <div class="url-install-note">
          <strong>${URL_INSTALL_LABELS.securityNotePrefix}:</strong> ${URL_INSTALL_LABELS.securityNote}
        </div>
      </div>
      <div class="modal-footer">
        <button
          class="primary"
          disabled=${fetching || !url.trim()}
          onClick=${handleFetch}
        >${fetching ? URL_INSTALL_LABELS.fetching : URL_INSTALL_LABELS.fetchPreviewBtn}</button>
        <button class="ghost" onClick=${handleClose}>${COMMON_ACTIONS.cancel}</button>
      </div>
    </Modal>
  `;
}
