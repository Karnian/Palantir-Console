// Route shell. Rendering and host/request state live in the owned/ modules.
import { h } from '../../vendor/preact.module.js';
import { useState } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
import { OWNED_COPY } from '../lib/copy.js';
import { Modal } from './Modal.js';
import { ownedApiPath } from './owned/client.js';
import { formatOwnedTime } from './owned/format.js';
import { useOwnedSessions } from './owned/useOwnedSessions.js';
import { OwnedSessionList } from './owned/OwnedSessionList.js';
import { OwnedSession } from './owned/OwnedSession.js';
import { OwnedStart } from './owned/OwnedStart.js';
const html = htm.bind(h);

export function OwnedSessionsView({ sessionId }) {
  const controller = useOwnedSessions(sessionId);
  const [startOpen, setStartOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const { host, busy, pending, notice, asOf, snapshot, execute } = controller;
  const startDisabled = !controller.canStart;
  const startSession = cwd => execute(`${ownedApiPath()}/start`, {
    cwd, node_id: 'local', confirmed_settings: true
  });
  const deleteSession = () => {
    setRemoveOpen(false);
    execute(ownedApiPath(sessionId), { incarnation_id: snapshot?.current_incarnation_id }, 'DELETE');
  };
  let hostStatus = '';
  if (host === 'unreachable') {
    hostStatus = html`<p class="owned-unknown">${OWNED_COPY.lost} ${formatOwnedTime(asOf)} ${OWNED_COPY.asOf}</p>`;
  } else if (host === 'not_running') {
    hostStatus = OWNED_COPY.off;
  }
  let content = html`<${OwnedSessionList} sessions=${controller.sessions}
    disabled=${startDisabled} onStart=${() => setStartOpen(true)} />`;
  if (sessionId) {
    content = html`<${OwnedSession} sessionId=${sessionId} controller=${controller} onRemove=${() => setRemoveOpen(true)} />`;
  }
  return html`
    <section class="owned-view">
      <h1>${OWNED_COPY.title}</h1>
      <div aria-live="polite" role="status">
        ${hostStatus}
        ${notice && html`<p>${notice}</p>`}
      </div>
      ${pending && html`
        <p class="owned-unknown">${OWNED_COPY.acceptanceUnknown}
          <button class="btn btn-sm" disabled=${host !== 'running' || busy} onClick=${controller.retry}>${OWNED_COPY.retry}</button>
        </p>
      `}
      ${controller.storageWarning && html`<p role="alert">${OWNED_COPY.pendingStorageWarning}</p>`}
      ${content}
      ${startOpen && html`<${OwnedStart} open disabled=${startDisabled}
        onClose=${() => setStartOpen(false)} onStart=${startSession} onPreview=${controller.synchronize} />`}
      <${Modal} open=${removeOpen} onClose=${() => setRemoveOpen(false)} labelledBy="owned-delete-title">
        <div class="modal-body">
          <h2 id="owned-delete-title">${OWNED_COPY.remove}</h2>
          <p>${OWNED_COPY.deleteWarning}</p>
          <button class="btn btn-sm btn-danger" disabled=${controller.disabled} onClick=${deleteSession}>${OWNED_COPY.remove}</button>
        </div>
      </${Modal}>
    </section>
  `;
}
