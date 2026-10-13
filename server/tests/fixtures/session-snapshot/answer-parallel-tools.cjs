'use strict';
const { user, TS } = require('./a1a.cjs');
const start = () => user('Synthetic instruction A');
function tool(uuid, parentUuid, messageId, ids) {
  return { type: 'assistant', sessionId: 's', uuid, parentUuid, timestamp: TS,
    message: { id: messageId, stop_reason: 'tool_use', content: ids.map(id => ({ type: 'tool_use', id,
      name: 'synthetic_tool', input: { secret: 'PRIVATE_TOOL_INPUT' } })) } };
}
function result(uuid, parentUuid, ids) {
  return user('', { uuid, parentUuid, message: { content: ids.map(tool_use_id => ({ type: 'tool_result', tool_use_id,
    content: 'PRIVATE_TOOL_RESULT' })) } });
}
function final(parentUuid) {
  return { type: 'assistant', sessionId: 's', uuid: 'final', parentUuid, timestamp: TS,
    message: { id: 'final-message', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ANSWER_BODY_SENTINEL' }] } };
}
function parallel(count) {
  const records = [start()];
  for (let i = 1; i <= count; i++) records.push(tool('a' + i, i === 1 ? 'u' : 'a' + (i - 1), 'parallel-message', ['call' + i]));
  for (let i = 1; i <= count; i++) records.push(result('r' + i, 'a' + i, ['call' + i]));
  records.push(final('r' + count)); return records;
}
const cases = [2, 3].map(count => ({ name: `parallel ${count} calls finish normally`, records: parallel(count),
  status: 'final', audit: true, evidence_ids: ['final'], end_id: 'final' }));
cases.push(
  { name: 'rewind assistants with distinct message ids still conflict', records: [start(),
    tool('first', 'u', 'message-one', ['one']), tool('fork', 'u', 'message-two', ['two']), final('fork')],
    status: 'unbound', reason: 'branch_conflict', audit: false, evidence_ids: ['final'], end_id: 'final' },
  { name: 'mismatched tool result beside message continuation conflicts', records: [start(),
    tool('a1', 'u', 'parallel-message', ['call1']), tool('a2', 'a1', 'parallel-message', ['call2']),
    result('bad', 'a1', ['unrelated-call']), result('r2', 'a2', ['call2']), final('r2')],
    status: 'unbound', reason: 'branch_conflict', audit: false, evidence_ids: ['final'], end_id: 'final' }
);
cases.push(
  { name: 'ancestor call id in the same message is a valid result', records: [start(),
    tool('a1', 'u', 'parallel-message', ['call1']), tool('a2', 'a1', 'parallel-message', ['call2']),
    result('r1', 'a2', ['call1', 'call2']), final('r1')],
    status: 'final', audit: true, evidence_ids: ['final'], end_id: 'final' },
  { name: 'v6 call id from a forward continuation is in the message group', records: [start(),
    tool('a1', 'u', 'parallel-message', ['call1']), tool('a2', 'a1', 'parallel-message', ['call2']),
    result('bad', 'a1', ['call2']), result('r2', 'a2', ['call2']), final('r2')],
    status: 'final', audit: true, evidence_ids: ['final'], end_id: 'final' },
  { name: 'call id from a different ancestor message is not a valid sibling result', records: [start(),
    tool('previous', 'u', 'previous-message', ['old-call']), tool('a1', 'previous', 'parallel-message', ['call1']),
    tool('a2', 'a1', 'parallel-message', ['call2']), result('bad', 'a1', ['old-call']), result('r2', 'a2', ['call2']), final('r2')],
    status: 'unbound', reason: 'branch_conflict', audit: false, evidence_ids: ['final'], end_id: 'final' },
  { name: 'a mixed matching and mismatching result row remains a competing sibling', records: [start(),
    tool('a1', 'u', 'parallel-message', ['call1']), tool('a2', 'a1', 'parallel-message', ['call2']),
    result('bad', 'a1', ['call1', 'unknown']), result('r2', 'a2', ['call2']), final('r2')],
    status: 'unbound', reason: 'branch_conflict', audit: false, evidence_ids: ['final'], end_id: 'final' },
  { name: 'parallel continuation and matched result through transparent metadata', records: [start(),
    tool('a1', 'u', 'parallel-message', ['call1']), user('Injected', { uuid: 'meta', parentUuid: 'a1', isMeta: true }),
    tool('a2', 'meta', 'parallel-message', ['call2']), result('r1', 'meta', ['call1']), result('r2', 'a2', ['call2']), final('r2')],
    status: 'final', audit: true, evidence_ids: ['final'], end_id: 'final' },
  { name: 'unverified result beside a verified result is still a branch', records: [start(),
    tool('a1', 'u', 'parallel-message', ['call1']), result('r1', 'a1', ['call1']), result('bad', 'a1', ['unknown']), final('bad')],
    status: 'unbound', reason: 'branch_conflict', audit: false, evidence_ids: ['final'], end_id: 'final' },
  { name: 'late terminal parallel result is a satellite of the completed main path', records: [...parallel(2), result('late', 'a1', ['call1'])],
    status: 'final', audit: true, evidence_ids: ['final'], end_id: 'final' }
);
module.exports = { cases, start, tool, result, final, parallel };
// R1 B1: a verified result stops being an allowed satellite when an execution continues below it.
const rewound = parallel(2);
rewound.splice(rewound.length - 1, 0, tool('rewind', 'r1', 'rewind-message', ['call3']));
cases.push({ name: 'R1 B1 rewind below a parallel result cannot be hidden', records: rewound,
  status: 'unbound', reason: 'branch_conflict', audit: false, evidence_ids: ['final'], end_id: 'final' });
const reversed = parallel(3);
const reversedRecords = [reversed[0], reversed[1], reversed[2], reversed[3], reversed[6], reversed[5], reversed[4], final('r1')];
cases.push({ name: 'R2 reversed parallel result arrivals finish on the first call', records: reversedRecords,
  status: 'final', audit: true, evidence_ids: ['final'], end_id: 'final' });
