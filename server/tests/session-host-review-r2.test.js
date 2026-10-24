'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/session-host-fixture');

test('R2-01 two resumes preserve saved conversation id when adapter omits response id', t => {
  const f = fixture(t), start = f.adapter.start;
  f.adapter.start = args => ({ ...start(args), ...(args.resume ? {} : { claude_session_id: 'sdk-original' }) });
  f.start();
  // Strip any fake response id on resume to exercise the core's preservation rule.
  f.adapter.start = args => { const p = start(args); delete p.claude_session_id; return p; };
  for (let n = 0; n < 2; n++) {
    f.core.submit(f.req('stop')); const r = f.core.submit(f.req('resume'));
    assert.equal(r.state, 'done'); f.iid = r.incarnation_id;
    assert.equal(f.adapter.log.startRequests.at(-1).claude_session_id, 'sdk-original');
    assert.equal(f.state().session.claude_session_id, 'sdk-original');
  }
  assert.equal(f.adapter.log.starts.length, 3);
});

test('R2-01 fake start returns conversation id; missing start id stays null and blocks handoff', t => {
  const f = fixture(t), start = f.adapter.start; let returned;
  f.adapter.start = args => { returned = start(args); return returned; };
  f.start(); assert.equal(typeof returned.claude_session_id, 'string');
  assert.equal(f.state().session.claude_session_id, returned.claude_session_id);
  f.core.submit(f.req('handoff')); assert.equal(f.state().session.state, 'handed_off');
  f.adapter.start = args => { const p = start(args); delete p.claude_session_id; return p; };
  f.start(); assert.equal(f.state().session.claude_session_id, null);
  assert.equal(f.core.submit(f.req('handoff')).reason, 'no_session_id');
  assert.equal(f.adapter.log.closes.length, 1);
});

test('R2-02 completed interrupt still processes late survivor receipt without state regression', t => {
  const f = fixture(t, { drop: true, noReceipt: true }); f.start(); const p = f.prompt();
  const interrupt = f.core.submit(f.req('interrupt'));
  f.adapter.emit(f.iid, 'result', { user_message_uuids: [p.message_uuid], is_error: true, subtype: 'error_during_execution' });
  assert.equal(f.d(interrupt.id).state, 'completed');
  f.adapter.emit(f.iid, 'interrupt_receipt', { interrupt_id: interrupt.id, still_queued: [p.message_uuid] });
  assert.equal(f.d(interrupt.id).state, 'completed'); assert.equal(f.d(p.id).state, 'provider_observed');
  assert.equal(f.state().incarnations[0].attribution_uncertain, 1);
  f.adapter.emit(f.iid, 'lifecycle', { command_uuid: p.message_uuid, state: 'completed' });
  assert.equal(f.d(p.id).outcome, null); assert.equal(f.prompt().state, 'rejected');
  assert.equal(f.adapter.log.received.length, 1);
});

for (const alreadyClosing of [false, true]) test(`R2-03 capability close wins user stop, alreadyClosing=${alreadyClosing}`, t => {
  const f = fixture(t, { manual: true, capabilities: [], noExit: true }); f.start(); const p = f.prompt();
  if (alreadyClosing) f.adapter.emit(f.iid, 'lifecycle', { command_uuid: p.message_uuid, state: 'completed' });
  const stop = f.core.submit(f.req('stop'));
  assert.equal(stop.state, 'rejected'); assert.equal(stop.reason, 'capability_close_pending');
  const c = f.state().controls.find(c => c.reason === 'capability_missing');
  assert.equal(c?.kind, 'close'); assert.equal(c?.stage, 'close_sent');
  assert.equal(f.adapter.log.closes.length, 1); f.adapter.exit(f.iid);
  assert.equal(f.state().session.state, 'closed');
});

test('R2-04 missing lifecycle closes on exact result without external exit or completed delivery', t => {
  const f = fixture(t, { capabilities: [], omitLifecycle: true, noExit: true }); f.start(); const p = f.prompt();
  assert.equal(f.adapter.log.closes.length, 1);
  assert.equal(f.state().controls.find(c => c.reason === 'capability_missing')?.stage, 'close_sent');
  assert.equal(f.d(p.id).state, 'written'); assert.equal(f.d(p.id).outcome, null);
  assert.equal(f.prompt().state, 'rejected'); assert.equal(f.adapter.log.received.length, 1);
});

test('R2-04 wrong result cannot initiate capability close, exact result can', t => {
  const f = fixture(t, { capabilities: [], manual: true, noExit: true }); f.start(); const p = f.prompt();
  f.adapter.emit(f.iid, 'result', { user_message_uuids: ['other'], is_error: false });
  assert.equal(f.adapter.log.closes.length, 0);
  f.adapter.emit(f.iid, 'result', { user_message_uuids: [p.message_uuid], is_error: false });
  assert.equal(f.adapter.log.closes.length, 1); assert.equal(f.d(p.id).outcome, null);
});

for (const tickFirst of [false, true]) test(`R2-05 late receipt durable deadline is order independent, tickFirst=${tickFirst}`, t => {
  const f = fixture(t, { manual: true, noReceipt: true }); f.start(); const p = f.prompt();
  const d = f.core.submit(f.req('interrupt')); f.advance(10000);
  if (tickFirst) f.core.tick();
  f.adapter.emit(f.iid, 'interrupt_receipt', { interrupt_id: d.id, still_queued: [] });
  if (!tickFirst) f.core.tick();
  assert.equal(f.d(d.id).state, 'provider_observed');
  assert.equal(f.state().incarnations[0].interrupt_unknown, 1);
  assert.equal(f.prompt().state, 'rejected');
  f.adapter.emit(f.iid, 'result', { user_message_uuids: [p.message_uuid], is_error: true, subtype: 'error_during_execution' });
  assert.equal(f.state().incarnations[0].interrupt_unknown, 0);
  assert.equal(f.d(d.id).state, 'completed'); assert.equal(f.adapter.log.interrupts.length, 1);
});

for (const withResult of [false, true]) test(`R2-06 unknown prompt receives terminal outcome on exit, withResult=${withResult}`, t => {
  const f = fixture(t, { late: true }); f.start(); const send = f.adapter.send;
  f.adapter.send = (...args) => { send(...args); throw new Error('ambiguous_effect'); };
  const p = f.prompt(); assert.equal(p.state, 'unknown');
  if (withResult) f.adapter.emit(f.iid, 'result', { user_message_uuids: [p.message_uuid], is_error: true, subtype: 'error_max_turns' });
  f.adapter.exit(f.iid);
  assert.equal(f.d(p.id).state, 'unknown'); assert.equal(f.d(p.id).outcome, withResult ? 'errored' : 'outcome_unknown');
  if (withResult) assert.equal(f.d(p.id).reason, 'error_max_turns');
  assert.equal(f.adapter.log.received.length, 1);
});

test('R2-07 multiple tool effect barriers clear only their own cause and release after last positive result', t => {
  const f = fixture(t, { manualTools: true }); f.start(); const decide = f.adapter.decide;
  f.adapter.decide = (...args) => { decide(...args); throw new Error('ambiguous_decision'); };
  f.adapter.toolRequest(f.iid, 'a'); f.adapter.toolRequest(f.iid, 'b');
  const a = f.core.submit(f.req('tool_decision', { target_tool_use_id: 'a' }));
  const b = f.core.submit(f.req('tool_decision', { target_tool_use_id: 'b' }));
  assert.equal(a.state, 'unknown'); assert.equal(b.state, 'unknown');
  f.adapter.emit(f.iid, 'tool_result', { tool_use_id: 'other', is_error: false, content: 'ok' });
  assert.equal(f.state().incarnations[0].attribution_uncertain, 2);
  f.adapter.emit(f.iid, 'tool_result', { tool_use_id: 'a', is_error: false, content: 'ok' });
  assert.equal(f.d(a.id).state, 'provider_observed'); assert.equal(f.d(b.id).state, 'unknown');
  assert.equal(f.state().incarnations[0].attribution_uncertain, 2); assert.equal(f.prompt().state, 'rejected');
  f.adapter.emit(f.iid, 'tool_result', { tool_use_id: 'b', is_error: false, content: 'ok' });
  assert.equal(f.state().incarnations[0].attribution_uncertain, 0);
  assert.equal(f.prompt().state, 'completed'); assert.equal(f.adapter.log.executions.length, 2);
});

test('R2-07 unrelated unknown prompt cannot clear another delivery barrier', t => {
  const f = fixture(t, { late: true, manualTools: true }); f.start();
  const send = f.adapter.send;
  f.adapter.send = (...args) => { send(...args); throw new Error('ambiguous_prompt'); };
  const p = f.prompt(); assert.equal(p.state, 'unknown');
  f.adapter.toolRequest(f.iid, 'a'); const decide = f.adapter.decide;
  f.adapter.decide = (...args) => { decide(...args); throw new Error('ambiguous_decision'); };
  f.core.submit(f.req('tool_decision', { target_tool_use_id: 'a' }));
  f.adapter.emit(f.iid, 'lifecycle', { command_uuid: p.message_uuid, state: 'queued' });
  assert.equal(f.state().incarnations.at(-1).attribution_uncertain, 2);
  f.adapter.emit(f.iid, 'tool_result', { tool_use_id: 'a', is_error: false, content: 'ok' });
  assert.equal(f.state().incarnations.at(-1).attribution_uncertain, 0);
});

test('R2-07 resolving temporary cause never clears permanent survivor barrier', t => {
  const f = fixture(t, { manualTools: true, noReceipt: true }); f.start();
  f.adapter.toolRequest(f.iid, 'a'); const decide = f.adapter.decide;
  f.adapter.decide = (...args) => { decide(...args); throw new Error('ambiguous_decision'); };
  const a = f.core.submit(f.req('tool_decision', { target_tool_use_id: 'a' }));
  const interrupt = f.core.submit(f.req('interrupt'));
  f.adapter.emit(f.iid, 'interrupt_receipt', { interrupt_id: interrupt.id, still_queued: ['survivor'] });
  f.adapter.emit(f.iid, 'tool_result', { tool_use_id: 'a', is_error: false, content: 'ok' });
  assert.equal(f.state().incarnations[0].attribution_uncertain, 1);
  assert.equal(f.prompt().state, 'rejected'); assert.equal(f.adapter.log.executions.length, 1);
  assert.equal(f.d(a.id).state, 'unknown'); assert.equal(f.d(a.id).reason, 'tool_finished');
});
