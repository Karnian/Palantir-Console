import { h } from '../../../vendor/preact.module.js';
import htm from '../../../vendor/htm.module.js';
import { OWNED_COPY } from '../../lib/copy.js';
import { ownedLabel } from './format.js';
const html = htm.bind(h);

export function OwnedSessionList({ sessions, disabled, onStart }) {
  return html`
    <button class="btn btn-sm btn-primary" disabled=${disabled} onClick=${onStart}>${OWNED_COPY.newSession}</button>
    ${!sessions.length && html`<p>${OWNED_COPY.empty}</p>`}
    <ul>
      ${sessions.map(session => html`
        <li class="owned-card">
          <a href=${`#owned/${encodeURIComponent(session.id)}`}>${session.cwd || session.id}</a>
          <p>
            ${ownedLabel(session.state)} · ${ownedLabel(session.incarnation?.state)} ·
            ${OWNED_COPY.approvals}: ${session.pending_approvals} · ${OWNED_COPY.activity}: ${session.last_activity_seq}
          </p>
        </li>
      `)}
    </ul>
  `;
}
