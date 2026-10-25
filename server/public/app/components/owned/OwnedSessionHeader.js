import { h } from '../../../vendor/preact.module.js';
import htm from '../../../vendor/htm.module.js';
import { OWNED_COPY } from '../../lib/copy.js';
import { ownedLabel, parseOwnedJson, formatOwnedTime } from './format.js';
import { getOwnedHeaderState } from './state.js';
const html = htm.bind(h);

function OwnedHeaderField({ label, value, lastValue, asOf }) {
  return html`
    <span class="owned-header-field">
      ${label}: ${ownedLabel(value)}
      ${lastValue && html`<span class="owned-last-known">
        (${formatOwnedTime(asOf)} ${OWNED_COPY.lastKnown}: ${ownedLabel(lastValue)})
      </span>`}
    </span>
  `;
}

export function OwnedSessionHeader({ state, incarnation, host, asOf }) {
  const account = parseOwnedJson(incarnation?.account_snapshot);
  const { current, lastKnown } = getOwnedHeaderState(host, state);
  const fields = [
    ['execution', OWNED_COPY.headerExecution],
    ['control', OWNED_COPY.headerControl],
    ['interaction', OWNED_COPY.headerInteraction],
    ['session', OWNED_COPY.headerSession]
  ];
  const capabilityNames = ['observe', 'prompt', 'tool_approval', 'cancel', 'resume'];
  return html`
    <div class="owned-card">
      <p class="owned-header-status">
        <span>${OWNED_COPY.headerHost}: ${host === 'running' ? OWNED_COPY.hostConnected : OWNED_COPY.hostLost}</span>
        ${fields.map(([name, label]) => html`<${OwnedHeaderField} key=${name} label=${label}
          value=${current[name]} lastValue=${lastKnown?.[name]} asOf=${asOf} />`)}
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
