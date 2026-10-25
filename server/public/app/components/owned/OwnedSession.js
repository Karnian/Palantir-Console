import { h } from '../../../vendor/preact.module.js';
import htm from '../../../vendor/htm.module.js';
import { OWNED_COPY } from '../../lib/copy.js';
import { canRestartOwnedSession, canInterruptOwnedSession, canHandoffOwnedSession } from './state.js';
import { OwnedSessionHeader } from './OwnedSessionHeader.js';
import { OwnedConversation } from './OwnedConversation.js';
import { OwnedApproval } from './OwnedApproval.js';
import { OwnedComposer } from './OwnedComposer.js';
const html = htm.bind(h);

export function OwnedSession({ sessionId, controller, onRemove }) {
  const { snapshot, incarnation, disabled, controllable, interaction, resumeReady, submit } = controller;
  if (!snapshot?.session) {
    return html`<a href="#owned">${OWNED_COPY.back}</a>
      <p>${controller.host === 'loading' ? OWNED_COPY.loading : OWNED_COPY.notFound}</p>`;
  }
  return html`
    <a href="#owned">${OWNED_COPY.back}</a>
    <${OwnedSessionHeader} state=${snapshot} incarnation=${incarnation} host=${controller.host}
      asOf=${controller.asOf} onHandoff=${() => submit('handoff')}
      handoffDisabled=${disabled || !canHandoffOwnedSession(snapshot)} />
    <div class="owned-actions">
      <button class="btn btn-sm" disabled=${!canInterruptOwnedSession(snapshot, !disabled)}
        onClick=${() => submit('interrupt')}>${OWNED_COPY.interrupt}</button>
      <button class="btn btn-sm" disabled=${disabled || !canRestartOwnedSession(snapshot)} onClick=${() => submit('restart')}>${OWNED_COPY.restart}</button>
      <button class="btn btn-sm" disabled=${disabled || !resumeReady} onClick=${() => submit('resume')}>${OWNED_COPY.resume}</button>
      <button class="btn btn-sm btn-danger" disabled=${disabled || snapshot.session.state !== 'active'}
        onClick=${() => submit('close')}>${OWNED_COPY.close}</button>
      <button class="btn btn-sm btn-danger" disabled=${disabled || !['closed', 'handed_off'].includes(snapshot.session.state)}
        onClick=${onRemove}>${OWNED_COPY.remove}</button>
    </div>
    ${controller.restartNotice && html`<p role="status">${controller.restartNotice}</p>`}
    <${OwnedConversation} state=${snapshot} events=${controller.events} sessionId=${sessionId}
      disabled=${disabled} controllable=${controllable} nextPage=${controller.nextPage}
      onHistory=${controller.history} onSubmit=${submit} />
    ${(snapshot.tool_requests || []).map(card => {
      const cardDisabled = disabled || !controllable || card.incarnation_id !== incarnation?.id;
      const delivery = snapshot.deliveries?.find(delivery => delivery.id === card.answer_delivery_id);
      return html`<${OwnedApproval} key=${card.id} card=${card} sessionId=${sessionId} cwd=${snapshot.session.cwd}
        disabled=${cardDisabled} delivery=${delivery} onSubmit=${submit} />`;
    })}
    <${OwnedComposer} manualNotice=${controller.interruptNotice} state=${snapshot} interaction=${interaction} disabled=${disabled || !controllable}
      uncertain=${!!incarnation?.attribution_uncertain} interruptUnknown=${!!incarnation?.interrupt_unknown} onSubmit=${submit} />
  `;
}
