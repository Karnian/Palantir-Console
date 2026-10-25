import { h } from '../../../vendor/preact.module.js';
import { useState } from '../../../vendor/hooks.module.js';
import htm from '../../../vendor/htm.module.js';
import { canSubmitOwnedPrompt, canInterruptOwnedSession } from './state.js';
import { OWNED_COPY } from '../../lib/copy.js';
const html = htm.bind(h);

export function OwnedComposer({ interaction, disabled, uncertain, interruptUnknown, onSubmit, state, manualNotice }) {
  const [body, setBody] = useState('');
  const eligible = state ? canSubmitOwnedPrompt(state, !disabled, interaction !== 'idle') : interaction !== 'unknown';
  const locked = disabled || uncertain || interruptUnknown || !eligible;
  const submitDisabled = locked || !body.trim();
  const interruptEligible = state ? canInterruptOwnedSession(state, !disabled)
    : ['running', 'awaiting_permission', 'awaiting_user'].includes(interaction);
  let submitControls = html`
    <button class="btn btn-sm" disabled=${submitDisabled || !interruptEligible}
      onClick=${() => onSubmit('interrupt-send', { body })}>${OWNED_COPY.interruptSend}</button>
    <button class="btn btn-sm" disabled=${submitDisabled} onClick=${() => onSubmit('queue-prompt', { body })}>${OWNED_COPY.queue}</button>
  `;
  if (interaction === 'idle') {
    submitControls = html`
      <button class="btn btn-sm btn-primary" disabled=${submitDisabled} onClick=${() => onSubmit('prompt', { body })}>
        ${OWNED_COPY.send}
      </button>
    `;
  }
  return html`
    <div>
      ${uncertain && html`<p class="owned-unknown">${OWNED_COPY.uncertain}</p>`}
      ${interruptUnknown && html`<p class="owned-unknown">${OWNED_COPY.interruptUnknown}</p>`}
      ${manualNotice && html`<p role="status">${manualNotice}</p>`}
      <label>${OWNED_COPY.prompt}
        <textarea value=${body} disabled=${locked} onInput=${event => setBody(event.target.value)} />
      </label>
      ${submitControls}
    </div>
  `;
}
