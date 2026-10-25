import { h } from '../../../vendor/preact.module.js';
import htm from '../../../vendor/htm.module.js';
import { OWNED_COPY } from '../../lib/copy.js';
import { buildOwnedConversation, canResendOwnedPrompt } from './state.js';
import { OwnedPrompt } from './OwnedPrompt.js';
import { OwnedMessage } from './OwnedMessage.js';
const html = htm.bind(h);

export function OwnedConversation({ state, events, sessionId, disabled, controllable, nextPage, onHistory, onSubmit }) {
  const conversation = buildOwnedConversation(state, events);
  return html`
    <h2>${OWNED_COPY.conversation}</h2>
    ${nextPage && html`<button class="btn btn-sm" disabled=${disabled} onClick=${onHistory}>${OWNED_COPY.history}</button>`}
    ${conversation.map(({ kind, row }) => {
      if (kind === 'prompt') {
        const resendDisabled = disabled || !controllable || !canResendOwnedPrompt(state, row);
        return html`<${OwnedPrompt} key=${row.id} row=${row} sessionId=${sessionId} disabled=${resendDisabled}
          onResend=${body => onSubmit('prompt', { body })} />`;
      }
      const incarnation = state.incarnations?.find(incarnation => incarnation.id === row.incarnation_id);
      const uncertain = !row.incarnation_id || !!incarnation?.attribution_uncertain;
      return html`<${OwnedMessage} key=${row.seq} event=${row} sessionId=${sessionId} uncertain=${uncertain} />`;
    })}
  `;
}
