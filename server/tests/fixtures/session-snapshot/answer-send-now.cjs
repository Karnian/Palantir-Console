'use strict';
const { user, TS } = require('./a1a.cjs');
function records({ queue = true, queueUuid = false, sendNow = true, followingAnswer = false, shell = false } = {}) {
  const hook = (uuid, parentUuid, type) => ({ type: 'attachment', sessionId: 's', uuid, parentUuid, timestamp: TS,
    attachment: { type, content: 'PRIVATE_HOOK_BODY' } });
  const rows = [
    user('Synthetic instruction A', { uuid: '234' }),
    { type: 'assistant', sessionId: 's', uuid: '235', parentUuid: '234', timestamp: TS,
      message: { id: 'ACr', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'ebX', name: 'synthetic', input: {} }] } },
    hook('236', '235', 'hook_success'),
    user('', { uuid: '237', parentUuid: '235', message: { content: [{ type: 'tool_result', tool_use_id: 'ebX', content: 'PRIVATE_TOOL_RESULT' }] } }),
    hook('238', '237', 'hook_success')
  ];
  if (queue) rows.push({ type: 'queue-operation', operation: 'dequeue', sessionId: 's', timestamp: TS,
    ...(queueUuid ? { uuid: '239' } : {}), content: 'PRIVATE_QUEUE_BODY' });
  rows.push(hook('240', '238', 'total_tokens_reminder'),
    user('', { uuid: '241', parentUuid: '240', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] },
      ...(sendNow === null ? {} : { interruptedBySendNow: sendNow, interruptedMessageId: 'ACr' }) }),
    shell ? { type: 'user', sessionId: 's', uuid: '242', parentUuid: '241', timestamp: TS,
      message: { content: '<bash-input>synthetic-command</bash-input>' } }
      : user('Synthetic next human instruction', { uuid: '242', parentUuid: '241' }));
  if (followingAnswer) rows.push({ type: 'assistant', sessionId: 's', uuid: '243', parentUuid: '242', timestamp: TS,
    message: { id: 'next-message', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ANSWER_BODY_SENTINEL' }] } });
  if (shell && followingAnswer) rows.push({ type: 'system', sessionId: 's', uuid: '244', parentUuid: '243', timestamp: TS, subtype: 'turn_duration' });
  return rows;
}
const cases = [
  { name: 'exact observed structure', options: {} },
  { name: 'queue-operation with a UUID and no parent', options: { queueUuid: true } },
  { name: 'without queue-operation', options: { queue: false } },
  { name: 'without send-now metadata', options: { sendNow: null } },
  { name: 'send-now false does not change interruption', options: { sendNow: false } },
  { name: 'following human execution ends independently', options: { followingAnswer: true } },
  { name: 'shell instruction without origin starts the next execution', options: { shell: true, followingAnswer: true } }
];
module.exports = { records, cases };
