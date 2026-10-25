import { h } from '../../../vendor/preact.module.js';
import { useState, useEffect } from '../../../vendor/hooks.module.js';
import htm from '../../../vendor/htm.module.js';
import { OWNED_COPY } from '../../lib/copy.js';
import { ownedFullText } from './client.js';
import { parseOwnedJson } from './format.js';
import { OwnedDeliveryBadge } from './OwnedDeliveryBadge.js';
const html = htm.bind(h);

export function OwnedPrompt({ row, sessionId, disabled, onResend }) {
  const [body, setBody] = useState(row.body_truncated ? null : parseOwnedJson(row.body));
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    if (row.body_truncated) {
      ownedFullText(sessionId, 'delivery_body', row.id).then(text => {
        if (active) setBody(parseOwnedJson(text));
      }, () => {
        if (active) setError(true);
      });
    }
    return () => {
      active = false;
    };
  }, [sessionId, row.id, row.body_truncated]);

  let bodyText = typeof body === 'string' ? body : JSON.stringify(body);
  if (body === null) bodyText = error ? OWNED_COPY.fullError : OWNED_COPY.loading;
  return html`
    <article class="owned-card">
      <pre>${bodyText}</pre>
      <${OwnedDeliveryBadge} delivery=${row} />
      ${row.state === 'unknown' && html`
        <p>${OWNED_COPY.resendWarning}
          <button disabled=${disabled || typeof body !== 'string'} onClick=${() => onResend(body)}>
            ${OWNED_COPY.resend}
          </button>
        </p>
      `}
    </article>
  `;
}
