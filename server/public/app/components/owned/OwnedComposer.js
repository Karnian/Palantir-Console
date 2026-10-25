import { h } from '../../../vendor/preact.module.js';
import { useState } from '../../../vendor/hooks.module.js';
import htm from '../../../vendor/htm.module.js';
import { OWNED_COPY } from '../../lib/copy.js';
const html = htm.bind(h);

export function OwnedComposer({ interaction, disabled, uncertain, interruptUnknown, onSubmit }) {
  const [body, setBody] = useState('');
  const locked = disabled || uncertain || interruptUnknown || interaction === 'unknown';
  const submitDisabled = locked || !body.trim();
  let submitControls = html`
    <button disabled=${submitDisabled} onClick=${() => onSubmit('interrupt-send', { body })}>${OWNED_COPY.interruptSend}</button>
    <button disabled=${submitDisabled} onClick=${() => onSubmit('prompt', { body })}>${OWNED_COPY.queue}</button>
  `;
  if (interaction === 'idle') {
    submitControls = html`<button disabled=${submitDisabled} onClick=${() => onSubmit('prompt', { body })}>${OWNED_COPY.send}</button>`;
  }
  return html`
    <div>
      ${uncertain && html`<p class="owned-unknown">${OWNED_COPY.uncertain}</p>`}
      ${interruptUnknown && html`<p class="owned-unknown">${OWNED_COPY.interruptUnknown}</p>`}
      <label>${OWNED_COPY.prompt}
        <textarea value=${body} disabled=${locked} onInput=${event => setBody(event.target.value)} />
      </label>
      ${submitControls}
    </div>
  `;
}
