'use strict';
const { meta, message, TS } = require('./a1a.cjs');
const event = (type, turn_id, extra = {}) => ({ type: 'event_msg', timestamp: TS, payload: { type, turn_id, ...extra } });
const context = turn_id => ({ type: 'turn_context', timestamp: TS, payload: { turn_id } });
const cases = [
  { name: 'abandoned empty first turn does not poison the next turn', records: [meta(), event('task_started', 'T0'),
    event('task_started', 'T1'), message(), event('task_complete', 'T1', { last_agent_message: 'SAFE' })],
    id: 'codex:s:n1', turn: 'T1', status: 'final' },
  { name: 'abandoned instruction is unbound', records: [meta(), event('task_started', 'T1'), message(),
    event('task_started', 'T2'), message(), event('task_complete', 'T2', { last_agent_message: 'SAFE' })],
    id: 'codex:s:n1', turn: 'T1', status: 'unbound' },
  { name: 'new instruction after an abandoned turn completes normally', records: [meta(), event('task_started', 'T1'), message(),
    event('task_started', 'T2'), message(), event('task_complete', 'T2', { last_agent_message: 'SAFE' })],
    id: 'codex:s:n2', turn: 'T2', status: 'final' },
  { name: 'other turn context inside the interval is overlap', records: [meta(), event('task_started', 'T1'), message(),
    context('T0'), event('task_complete', 'T1', { last_agent_message: 'SAFE' })],
    id: 'codex:s:n1', turn: 'T1', status: 'unbound' },
  { name: 'late own turn context beyond next start is overlap', records: [meta(), event('task_started', 'T1'), message(),
    event('task_complete', 'T1', { last_agent_message: 'SAFE' }), event('task_started', 'T2'), message(), context('T1'), event('task_complete', 'T2')],
    id: 'codex:s:n1', turn: 'T1', status: 'unbound' }
];
cases.push(
  { name: 'other task event inside the interval is overlap', records: [meta(), event('task_started', 'T1'), message(),
    event('task_progress', 'T0'), event('task_complete', 'T1', { last_agent_message: 'SAFE' })],
    id: 'codex:s:n1', turn: 'T1', status: 'unbound' },
  { name: 'instruction before any turn is structurally unbound without a fabricated turn id', records: [meta(), message(),
    event('task_started', 'T1'), event('task_complete', 'T1')],
    id: 'codex:s:n1', turn: null, status: 'unbound' }
);
module.exports = { cases, event, context };
