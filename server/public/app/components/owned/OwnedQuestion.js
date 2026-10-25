import { h } from '../../../vendor/preact.module.js';
import { useState, useRef } from '../../../vendor/hooks.module.js';
import htm from '../../../vendor/htm.module.js';
import { OWNED_COPY } from '../../lib/copy.js';
import { ownedRequestKey } from './client.js';
const html = htm.bind(h);

export function OwnedQuestion({ input, disabled, onAnswer }) {
  const [answers, setAnswers] = useState({});
  const group = useRef(ownedRequestKey());
  const questions = input?.questions || [];
  const updateAnswer = (question, value) => {
    setAnswers(previous => ({ ...previous, [question]: value }));
  };
  const selectOption = (question, option, checked) => {
    const previous = answers[question.question] || {};
    let selected = option.label;
    if (question.multiSelect) {
      const previousSelections = previous.selected || [];
      selected = checked
        ? [...previousSelections, option.label]
        : previousSelections.filter(selection => selection !== option.label);
    }
    updateAnswer(question.question, { ...previous, selected });
  };
  const isSelected = (question, option) => {
    const selected = answers[question.question]?.selected;
    return question.multiSelect ? (selected || []).includes(option.label) : selected === option.label;
  };
  const sendAnswers = () => {
    const entries = questions.map(question => {
      const answer = answers[question.question];
      const selected = Array.isArray(answer.selected) ? answer.selected.join(', ') : answer.selected;
      return [question.question, answer.custom?.trim() || selected];
    });
    onAnswer(Object.fromEntries(entries));
  };
  const incomplete = questions.some(question => {
    const answer = answers[question.question];
    return !answer?.custom?.trim() && !answer?.selected?.length;
  });
  return html`
    <div>
      ${questions.map((question, questionIndex) => html`
        <fieldset disabled=${disabled}>
          <legend>${question.question}</legend>
          ${(question.options || []).map(option => html`
            <label class="owned-choice">
              <input type=${question.multiSelect ? 'checkbox' : 'radio'}
                name=${`${group.current}-${questionIndex}`}
                checked=${isSelected(question, option)}
                onChange=${event => selectOption(question, option, event.target.checked)} />
              ${option.label}${option.description ? ` — ${option.description}` : ''}
            </label>
          `)}
          <label>${OWNED_COPY.custom}
            <input value=${answers[question.question]?.custom || ''}
              onInput=${event => updateAnswer(question.question, {
                ...answers[question.question], custom: event.target.value
              })} />
          </label>
        </fieldset>
      `)}
      <button disabled=${disabled || !questions.length || incomplete} onClick=${sendAnswers}>${OWNED_COPY.answer}</button>
    </div>
  `;
}
