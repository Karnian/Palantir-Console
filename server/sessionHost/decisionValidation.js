'use strict';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = value => typeof value === 'string' && value.trim().length > 0;
// Shared admission and SDK boundary rules. No side effects or user values in errors.
function validateDecision(input, decision, kind = decision?.behavior === 'answer' ? 'question_answer' : 'tool_decision') {
  if (!object(decision)) return { ok: false };
  if (kind === 'tool_decision' && !['allow', 'deny'].includes(decision.behavior) ||
      kind === 'question_answer' && decision.behavior !== 'answer') return { ok: false };
  if (decision.message !== undefined && typeof decision.message !== 'string') return { ok: false };
  if (decision.behavior === 'allow' || decision.behavior === 'deny') return { ok: true };
  if (decision.behavior !== 'answer' || !Array.isArray(input?.questions) || !input.questions.length ||
      !input.questions.every(question => object(question) && text(question.question))) return { ok: false };
  const { answer } = decision;
  if (typeof answer === 'string' && (input.questions.length !== 1 || !text(answer))) return { ok: false };
  const answers = typeof answer === 'string' ? { [input.questions[0].question]: answer } : answer;
  if (!object(answers) || !Object.values(answers).every(text)) return { ok: false };
  const keys = Object.keys(answers);
  const expected = new Set(input.questions.map(question => question.question));
  if (keys.length !== expected.size || keys.some(key => !expected.has(key))) return { ok: false };
  return { ok: true, answers };
}
module.exports = { validateDecision };
