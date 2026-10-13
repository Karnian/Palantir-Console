'use strict';
const { user, TS } = require('./a1a.cjs');
const start = () => user('Synthetic instruction A');
const assistant = (uuid, parentUuid, stop = 'end_turn') => ({ type: 'assistant', sessionId: 's', uuid, parentUuid,
  timestamp: TS, message: { id: uuid + '-message', stop_reason: stop, content: [{ type: 'text', text: 'ANSWER_BODY_SENTINEL' }] } });
const meta = (uuid, parentUuid, extra = {}) => user('PRIVATE_INJECTION', { uuid, parentUuid, isMeta: true, ...extra });
const compact = (parentUuid = null) => user('PRIVATE_SUMMARY', { uuid: 'compact', parentUuid, isCompactSummary: true });
const hook = (uuid, parentUuid) => ({ type: 'attachment', sessionId: 's', uuid, parentUuid, timestamp: TS,
  attachment: { type: 'hook_success', content: 'PRIVATE_HOOK_BODY' } });
const result = (parentUuid) => user('', { uuid: 'result', parentUuid, message: { content: [{ type: 'tool_result', content: 'PRIVATE_TOOL_BODY' }] } });
const cases = [
  { name: 'a meta user bridges tool_use to end_turn', records: [start(), assistant('tool', 'u', 'tool_use'), meta('meta', 'tool'), assistant('final', 'meta')],
    status: 'final', evidence_ids: ['final'], end_id: 'final', audit: true },
  { name: 'b compact root leaves prior execution pending', records: [start(), assistant('tool', 'u', 'tool_use'), compact(), assistant('after', 'compact')],
    status: 'pending', evidence_ids: [], end_id: 'tool', audit: true },
  { name: 'c hook_success sibling is not a competing branch', records: [start(), assistant('tool', 'u', 'tool_use'), hook('hook', 'tool'), result('tool'), assistant('final', 'result')],
    status: 'final', evidence_ids: ['final'], end_id: 'final', audit: true },
  { name: 'd absent middle parent is chain_broken', records: [start(), assistant('tool', 'u', 'tool_use'), assistant('final', 'missing')],
    status: 'unbound', reason: 'chain_broken', evidence_ids: ['final'], end_id: 'final', audit: false }
];
cases.push(
  { name: 'linked compact summary and metadata are transparent', records: [start(), assistant('tool', 'u', 'tool_use'), compact('tool'), meta('meta', 'compact'), assistant('final', 'meta')],
    status: 'final', evidence_ids: ['final'], end_id: 'final', audit: true },
  { name: 'trailing meta tool_result is not resumption or segment end', records: [start(), assistant('final', 'u'),
    meta('meta', 'final', { message: { content: [{ type: 'tool_result', content: 'PRIVATE_META_RESULT' }] } })],
    status: 'final', evidence_ids: ['final'], end_id: 'final', audit: true },
  { name: 'prior unrelated missing parents cannot invalidate final', records: [assistant('old', 'unavailable-history', 'tool_use'),
    meta('old-meta', 'other-missing'), start(), assistant('final', 'u')],
    status: 'final', evidence_ids: ['final'], end_id: 'final', audit: true },
  { name: 'later execution with missing earlier history is outside the prior segment', records: [start(), assistant('final', 'u'),
    user('Next instruction', { uuid: 'next', parentUuid: 'absent-later-parent' }), assistant('later', 'next', 'tool_use')],
    status: 'final', evidence_ids: ['final'], end_id: 'final', audit: true },
  { name: 'sidechain missing parents are a separate graph', records: [start(), assistant('final', 'u'),
    { ...assistant('side', 'absent-side-parent', 'tool_use'), isSidechain: true }],
    status: 'final', evidence_ids: ['final'], end_id: 'final', audit: true },
  { name: 'compact root excludes finished postcompact records', records: [start(), assistant('final', 'u'), compact(), assistant('after', 'compact')],
    status: 'final', evidence_ids: ['final'], end_id: 'final', audit: true },
  { name: 'transparent branches reaching two significant children still conflict', records: [start(),
    assistant('final', 'u'), meta('meta', 'u'), assistant('branch', 'meta', 'tool_use')],
    status: 'unbound', reason: 'branch_conflict', evidence_ids: ['final'], end_id: 'final', audit: false },
  { name: 'real resumption through meta changes final to pending', records: [start(), assistant('final', 'u'), meta('meta', 'final'), result('meta')],
    status: 'pending', evidence_ids: [], end_id: 'result', audit: true },
  { name: 'missing ancestor behind transparent metadata is still broken', records: [start(), meta('meta', 'absent-middle-parent'), assistant('final', 'meta')],
    status: 'unbound', reason: 'chain_broken', evidence_ids: ['final'], end_id: 'final', audit: false },
  { name: 'unconnected missing parent after another starter remains ambiguous', records: [start(), assistant('final', 'u'),
    user('Next instruction', { uuid: 'next', parentUuid: 'final' }), assistant('orphan', 'missing-after-next', 'tool_use')],
    status: 'unbound', reason: 'chain_broken', evidence_ids: ['final'], end_id: 'final', audit: false }
);
module.exports = { cases, start, assistant, meta, compact, hook, result };
