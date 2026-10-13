'use strict';
const { meta, message, TS } = require('./a1a.cjs');
const { records: sendNow } = require('./answer-send-now.cjs');
const claude = [
  { name: 'human origin', kind: 'human', content: 'New human input', fields: { origin: { kind: 'human' } } },
  { name: 'human turnOrigin', kind: 'human', content: 'New human input', fields: { turnOrigin: 'human' } },
  ...['typed', 'queued', 'suggestion_accepted'].map(promptSource => ({ name: 'human ' + promptSource, kind: 'human', content: 'New human input', fields: { promptSource } })),
  { name: 'human image only', kind: 'human', content: [{ type: 'image', source: { type: 'base64', data: 'SYNTHETIC_IMAGE' } }], fields: { origin: { kind: 'human' } } },
  { name: 'human empty content follows core', kind: 'human', content: '', fields: { origin: { kind: 'human' } } },
  { name: 'slash command-name without origin', kind: 'slash', content: '<command-name>/synthetic</command-name>' },
  { name: 'slash command-message without origin', kind: 'slash', content: [{ type: 'text', text: '<command-message>synthetic</command-message>' }] },
  { name: 'slash wrapper with human origin is human', kind: 'human', content: '<command-name>/synthetic</command-name>', fields: { origin: { kind: 'human' } } },
  { name: 'shell without origin', kind: 'shell', content: '<bash-input>synthetic-command</bash-input>' },
  { name: 'shell blocks without origin', kind: 'shell', content: [{ type: 'text', text: '<bash-input>synthetic-command</bash-input>' }] },
  { name: 'shell with human origin', kind: 'shell', content: '<bash-input>synthetic-command</bash-input>', fields: { origin: { kind: 'human' } } },
  { name: 'shell source conflict overrides typed', kind: null, content: '<bash-input>synthetic-command</bash-input>', fields: { origin: { kind: 'agent' }, promptSource: 'typed' } },
  { name: 'slash source conflict overrides typed', kind: null, content: '<command-name>/synthetic</command-name>', fields: { origin: { kind: 'agent' }, promptSource: 'typed' } },
  { name: 'plain source conflict overrides typed', kind: null, content: 'Injected user', fields: { origin: { kind: 'agent' }, promptSource: 'typed' } },
  ...['task-notification', 'local-command-stdout', 'local-command-caveat', 'bash-stdout', 'bash-stderr'].map(tag => ({ name: 'excluded output ' + tag, kind: null,
    content: `<${tag}>PRIVATE_OUTPUT</${tag}>`, fields: { origin: { kind: 'human' }, turnOrigin: 'human' } })),
  ...['isMeta', 'isCompactSummary'].map(flag => ({ name: 'excluded ' + flag, kind: null, content: '<bash-input>PRIVATE_INJECTION</bash-input>', fields: { [flag]: true, origin: { kind: 'human' } } })),
  ...['task_notification', 'scheduled'].map(turnOrigin => ({ name: 'excluded origin ' + turnOrigin, kind: null,
    content: '<bash-input>PRIVATE_INJECTION</bash-input>', fields: { turnOrigin, origin: { kind: 'human' } } })),
  { name: 'excluded system source', kind: null, content: '<command-name>/injected</command-name>', fields: { promptSource: 'system', origin: { kind: 'human' } } },
  { name: 'excluded tool result despite human origin', kind: null, content: [{ type: 'tool_result', tool_use_id: 'ebX', content: 'PRIVATE_TOOL_RESULT' }], fields: { origin: { kind: 'human' } } },
  { name: 'unknown unmarked plain text', kind: null, content: 'Unknown source' },
  { name: 'unknown slash with empty origin object', kind: null, content: '<command-name>/synthetic</command-name>', fields: { origin: {} } }
];
function claudeRecords(c) {
  const rows = sendNow({ followingAnswer: true }).map(r => r.uuid === '242' ? {
    type: 'user', sessionId: 's', uuid: '242', parentUuid: '241', timestamp: TS,
    message: { content: c.content }, ...c.fields
  } : r);
  rows.push({ type: 'system', sessionId: 's', uuid: '244', parentUuid: '243', timestamp: TS, subtype: 'turn_duration' });
  return rows;
}
const codex = [
  { name: 'human', kind: 'human', content: [{ type: 'input_text', text: 'New human input' }] },
  { name: 'reply', kind: 'reply', content: [{ type: 'input_text', text: '<send_user_message_question_reply>Choice</send_user_message_question_reply>' }] },
  { name: 'reply mixed with injected and human', kind: 'reply', content: [{ type: 'input_text', text: '<environment_context>PRIVATE_INJECTION</environment_context>' },
    { type: 'input_text', text: 'Human input' }, { type: 'input_text', text: '<send_user_message_question_reply>Choice</send_user_message_question_reply>' }] },
  { name: 'human image only', kind: 'human', content: [{ type: 'input_image', image_url: 'SYNTHETIC_IMAGE' }] },
  ...['<environment_context>', '<codex_internal_context>', '# AGENTS.md instructions'].map(prefix => ({ name: 'excluded injection ' + prefix, kind: null, content: [{ type: 'input_text', text: prefix + 'PRIVATE_INJECTION' }] })),
  { name: 'excluded unknown tag', kind: null, content: [{ type: 'input_text', text: '<unknown>PRIVATE_UNKNOWN</unknown>' }] },
  { name: 'excluded unknown block', kind: null, content: [{ type: 'unknown', text: 'PRIVATE_UNKNOWN' }] },
  { name: 'excluded empty blocks', kind: null, content: [] }
];
function codexRecords(c) {
  const event = (type, turn_id) => ({ type: 'event_msg', timestamp: TS, payload: { type, turn_id } });
  return [meta(), event('task_started', 'T0'), message(), event('turn_aborted', 'T0'),
    event('task_started', 'T1'), message({ content: c.content }),
    { type: 'event_msg', timestamp: TS, payload: { type: 'task_complete', turn_id: 'T1', last_agent_message: 'ANSWER_BODY_SENTINEL' } }];
}
module.exports = { claude, claudeRecords, codex, codexRecords };
