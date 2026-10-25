import { h } from '../../../vendor/preact.module.js';
import { useState, useEffect } from '../../../vendor/hooks.module.js';
import htm from '../../../vendor/htm.module.js';
import { OWNED_COPY } from '../../lib/copy.js';
import { ownedFullText } from './client.js';
import { ownedLabel, parseOwnedJson, formatOwnedTime } from './format.js';
import { OwnedDeliveryBadge } from './OwnedDeliveryBadge.js';
import { getOwnedToolInputPreview } from './state.js';
import { OwnedQuestion } from './OwnedQuestion.js';
const html = htm.bind(h);

export function OwnedApproval({ card, sessionId, cwd, disabled, delivery, onSubmit }) {
  const [fullInput, setFullInput] = useState(card.input_truncated ? null : card.input || '');
  const [error, setError] = useState(false);
  const [reason, setReason] = useState('');
  useEffect(() => {
    let active = true;
    if (card.input_truncated) {
      ownedFullText(sessionId, 'tool_input', card.id).then(value => {
        if (active) setFullInput(value);
      }, () => {
        if (active) setError(true);
      });
    }
    return () => {
      active = false;
    };
  }, [sessionId, card.id, card.input, card.input_truncated]);

  const locked = disabled || card.state !== 'pending' || fullInput === null;
  let inputText = fullInput;
  if (fullInput === null) inputText = error ? OWNED_COPY.fullError : OWNED_COPY.loading;
  const answerQuestion = answer => onSubmit('question-answer', { tool_use_id: card.tool_use_id, answer });
  const allowTool = () => onSubmit('tool-decision', { tool_use_id: card.tool_use_id, behavior: 'allow' });
  const denyTool = () => onSubmit('tool-decision', { tool_use_id: card.tool_use_id, behavior: 'deny', message: reason });
  let decisionControls = html`
    <label>${OWNED_COPY.reason}
      <input value=${reason} disabled=${locked} onInput=${event => setReason(event.target.value)} />
    </label>
    <button class="btn btn-sm btn-primary" disabled=${locked} onClick=${allowTool}>${OWNED_COPY.allow}</button>
    <button class="btn btn-sm btn-danger" disabled=${locked} onClick=${denyTool}>${OWNED_COPY.deny}</button>
  `;
  if (card.tool_name === 'AskUserQuestion') {
    decisionControls = html`<${OwnedQuestion} input=${parseOwnedJson(fullInput)} disabled=${locked} onAnswer=${answerQuestion} />`;
  }
  const inputPreview = getOwnedToolInputPreview(inputText);
  return html`
    <article class="owned-card">
      <h3>${card.tool_name}</h3>
      <p>${cwd} · ${OWNED_COPY.timestamp}: ${formatOwnedTime(card.created_at)}</p>
      <div class="owned-approval-actions">${decisionControls}</div>
      <p>${ownedLabel(card.state)} ${delivery && html`<${OwnedDeliveryBadge} delivery=${delivery} />`}</p>
      ${inputPreview.long && html`
        <p>${OWNED_COPY.inputPreview}</p>
        <pre class="owned-tool-preview">${inputPreview.preview}</pre>
      `}
      <details class="owned-tool-input" open=${!inputPreview.long}>
        <summary>${inputPreview.long ? OWNED_COPY.expandInput : OWNED_COPY.input}</summary>
        <pre class="owned-tool-full">${inputText}</pre>
      </details>
    </article>
  `;
}
