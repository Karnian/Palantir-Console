import { h } from '../../../vendor/preact.module.js';
import { useState, useEffect, useRef } from '../../../vendor/hooks.module.js';
import htm from '../../../vendor/htm.module.js';
import { apiFetch } from '../../lib/api.js';
import { OWNED_COPY } from '../../lib/copy.js';
import { Modal } from '../Modal.js';
import { DirectoryPicker } from '../BoardView.js';
import { ownedApiPath } from './client.js';
import { ownedLabel } from './format.js';
const html = htm.bind(h);

function OwnedSettingsPreview({ preview }) {
  if (!preview) return null;
  return html`
    <div>
      <h3>${OWNED_COPY.hooks}</h3>
      ${(preview.hooks || []).map(hook => html`<p>${hook.event} · ${hook.paths.join(' · ')}</p>`)}
      <h3>${OWNED_COPY.mcp}</h3>
      ${(preview.mcp_servers || []).map(server => html`<p>${server.name} · ${server.paths.join(' · ')}</p>`)}
      <h3>${OWNED_COPY.sources}</h3>
      ${(preview.source_paths || []).map(path => html`<p>${path}</p>`)}
      ${(preview.warnings || []).includes('permission_request_hook') && html`
        <p class="owned-unknown" role="alert">${OWNED_COPY.permissionWarning}</p>
      `}
      ${!preview.ok && html`<p role="alert">${ownedLabel(preview.reason)} ${preview.detail || ''}</p>`}
    </div>
  `;
}

export function OwnedStart({ open, disabled, onClose, onStart, onPreview = () => {} }) {
  const [cwd, setCwd] = useState('');
  const [preview, setPreview] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requestSequence = useRef(0);
  useEffect(() => () => {
    requestSequence.current++;
  }, []);

  const selectDirectory = directory => {
    requestSequence.current++;
    setCwd(directory);
    setPreview(null);
    setConfirmed(false);
    setBusy(false);
  };
  const inspectSettings = async () => {
    const requestToken = ++requestSequence.current;
    setBusy(true);
    setError('');
    setConfirmed(false);
    setPreview(null);
    try {
      const result = await apiFetch(`${ownedApiPath()}/settings-preview`, {
        method: 'POST', body: JSON.stringify({ cwd, node_id: 'local' })
      });
      if (requestToken === requestSequence.current) {
        setPreview(result);
        onPreview();
      }
    } catch (error) {
      if (requestToken === requestSequence.current) setError(ownedLabel(error.reason || error.message));
    } finally {
      if (requestToken === requestSequence.current) setBusy(false);
    }
  };
  return html`
    <${Modal} open=${open} onClose=${onClose} labelledBy="owned-start-title">
      <div class="modal-header"><h2 id="owned-start-title">${OWNED_COPY.newSession}</h2></div>
      <div class="modal-body owned-view">
        <${DirectoryPicker} value=${cwd} onSelect=${selectDirectory} nodeId="local" directoryNodeId="local" />
        <button class="btn btn-sm" disabled=${disabled || !cwd || busy} onClick=${inspectSettings}>${OWNED_COPY.settings}</button>
        <p>${OWNED_COPY.projectWarning}</p>
        <p>${OWNED_COPY.userWarning}</p>
        <${OwnedSettingsPreview} preview=${preview} />
        <label>
          <input type="checkbox" checked=${confirmed} disabled=${disabled || !preview?.ok || busy}
            onChange=${event => setConfirmed(event.target.checked)} />
          ${OWNED_COPY.confirm}
        </label>
        <p role="status">${busy ? OWNED_COPY.settings_checking : error}</p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-sm btn-primary" disabled=${disabled || !preview?.ok || !confirmed || busy}
          onClick=${() => onStart(cwd)}>${OWNED_COPY.start}</button>
      </div>
    </${Modal}>
  `;
}
