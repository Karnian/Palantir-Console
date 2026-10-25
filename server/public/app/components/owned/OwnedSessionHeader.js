import { h } from '../../../vendor/preact.module.js';
import htm from '../../../vendor/htm.module.js';
import { OWNED_COPY } from '../../lib/copy.js';
import { ownedLabel, parseOwnedJson } from './format.js';
const html = htm.bind(h);

export function OwnedSessionHeader({ state, incarnation, host, controllable, interaction }) {
  const account = parseOwnedJson(incarnation?.account_snapshot);
  let liveness = OWNED_COPY.unknown;
  if (['alive', 'orphaned'].includes(incarnation?.state)) liveness = OWNED_COPY.alive;
  if (['exited', 'never_started'].includes(incarnation?.state)) liveness = OWNED_COPY.exited;
  const capabilityNames = ['observe', 'prompt', 'tool_approval', 'cancel', 'resume'];
  return html`
    <div class="owned-card">
      <p>
        ${host === 'running' ? OWNED_COPY.connected : OWNED_COPY.disconnected} · ${liveness} ·
        ${controllable ? OWNED_COPY.control : OWNED_COPY.noControl} ·
        ${ownedLabel(interaction)} · ${ownedLabel(state.session.state)}
      </p>
      <p>${OWNED_COPY.cwd}: ${state.session.cwd}</p>
      <p>
        ${OWNED_COPY.cli}: ${incarnation?.cli_version || OWNED_COPY.verdict} ·
        ${OWNED_COPY.auth}: ${account?.subscriptionType || OWNED_COPY.verdict}
      </p>
      ${incarnation?.rate_limit_info?.isUsingOverage && html`<p class="owned-unknown">${OWNED_COPY.overage}</p>`}
      <p>
        ${capabilityNames.map(name => {
          const verdict = incarnation?.capabilityVerdict?.[name];
          const verdictText = !verdict || verdict === 'unknown' ? OWNED_COPY.verdict : ownedLabel(verdict);
          return html`<span class="owned-badge">${OWNED_COPY[name]}: ${verdictText}</span>`;
        })}
      </p>
      ${(state.controls || []).map(control => html`
        <p>
          ${ownedLabel(control.kind)} · ${ownedLabel(control.stage)} · ${ownedLabel(control.state)}
          ${control.reason ? ownedLabel(control.reason) : ''}
        </p>
      `)}
    </div>
  `;
}
