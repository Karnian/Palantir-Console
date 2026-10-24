'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/session-host-fixture');

test('§8.1 same key concurrent submissions: one row, provider effect once; body conflict 409', async t => {
  const f = fixture(t); f.start(); const req = f.req('prompt', { body: 'one' });
  const [a, b] = await Promise.all([Promise.resolve().then(() => f.core.submit(req)), Promise.resolve().then(() => f.core.submit(req))]);
  assert.equal(a.id, b.id); assert.equal(f.state().deliveries.length, 1); assert.equal(f.adapter.log.received.length, 1);
  assert.equal(f.core.submit({ ...req, body: 'two' }).status, 409);
});

test('§8.1 normal 20 prompts + 10 approvals, denial and question: unknown zero, provider executions ten', t => {
  const f = fixture(t); f.start();
  for (let n = 0; n < 20; n++) assert.equal(f.prompt().state, 'completed');
  for (let n = 0; n < 10; n++) {
    f.adapter.toolRequest(f.iid, `tool-${n}`);
    assert.equal(f.core.submit(f.req('tool_decision', { target_tool_use_id: `tool-${n}`, body: { behavior: 'allow' } })).state, 'provider_observed');
  }
  f.adapter.toolRequest(f.iid, 'deny');
  assert.equal(f.core.submit(f.req('tool_decision', { target_tool_use_id: 'deny', body: { behavior: 'deny' } })).state, 'provider_observed');
  f.adapter.toolRequest(f.iid, 'q', 'AskUserQuestion');
  assert.equal(f.core.submit(f.req('question_answer', { target_tool_use_id: 'q', body: { answer: 'yes' } })).state, 'provider_observed');
  assert.equal(f.adapter.log.received.length, 20); assert.equal(f.adapter.log.executions.length, 10);
  assert.equal(f.state().deliveries.filter(d => d.state === 'unknown').length, 0);
});

test('§8.1 two tabs decide same card under different keys: pending CAS permits one provider execution', t => {
  const f = fixture(t); f.start(); f.adapter.toolRequest(f.iid, 't');
  const a = f.core.submit(f.req('tool_decision', { target_tool_use_id: 't', body: { behavior: 'allow' } }));
  const b = f.core.submit(f.req('tool_decision', { target_tool_use_id: 't', body: { behavior: 'deny' } }));
  assert.equal(a.state, 'provider_observed'); assert.equal(b.state, 'rejected');
  assert.equal(f.adapter.log.decisions.length, 1); assert.equal(f.adapter.log.executions.length, 1);
});

test('§8.1 result alone does not drain queued prompt; lifecycle terminal drains once', t => {
  const f = fixture(t, { manual: true }); f.start();
  const a = f.prompt('a'), b = f.prompt('b');
  assert.equal(b.state, 'queued'); assert.equal(f.adapter.log.received.length, 1);
  f.adapter.emit(f.iid, 'result', { user_message_uuids: [a.message_uuid], is_error: false });
  assert.equal(f.core.idle(f.sid), false); assert.equal(f.adapter.log.received.length, 1);
  f.adapter.emit(f.iid, 'lifecycle', { command_uuid: a.message_uuid, state: 'completed' });
  assert.equal(f.d(a.id).outcome, 'completed'); assert.equal(f.adapter.log.received.length, 2);
  assert.equal(f.d(b.id).turn_gen, 2);
});

for (const error of [false, true]) test(`§8.1 prompt terminal outcome ${error ? 'errored' : 'completed'} and synchronous observation never regresses`, t => {
  const f = fixture(t, { resultError: error }); f.start(); const d = f.prompt();
  assert.equal(d.state, 'completed'); assert.equal(d.outcome, error ? 'errored' : 'completed');
  assert.equal(f.core.idle(f.sid), true); assert.equal(f.adapter.log.received.length, 1);
});

test('§8.1 completed without result gives outcome_unknown and allows next prompt', t => {
  const f = fixture(t, { manual: true }); f.start(); const a = f.prompt();
  f.adapter.emit(f.iid, 'lifecycle', { command_uuid: a.message_uuid, state: 'completed' });
  assert.equal(f.d(a.id).outcome, 'outcome_unknown'); assert.equal(f.core.idle(f.sid), true);
  f.prompt(); assert.equal(f.adapter.log.received.length, 2);
});

test('§8.1 wrong correlation IDs cannot observe prompt or tool decision', t => {
  const f = fixture(t, { drop: true, manualTools: true }); f.start(); const d = f.prompt();
  f.adapter.emit(f.iid, 'lifecycle', { command_uuid: 'other', state: 'queued' });
  f.adapter.emit(f.iid, 'result', { user_message_uuids: ['other'], is_error: false });
  assert.equal(f.d(d.id).state, 'written');
  f.adapter.emit(f.iid, 'lifecycle', { command_uuid: d.message_uuid, state: 'queued' });
  assert.equal(f.d(d.id).state, 'provider_observed');
  f.adapter.toolRequest(f.iid, 't'); const a = f.core.submit(f.req('tool_decision', { target_tool_use_id: 't' }));
  f.adapter.emit(f.iid, 'tool_result', { tool_use_id: 'other', content: 'ok', is_error: false }); assert.equal(f.d(a.id).state, 'written');
  f.adapter.emit(f.iid, 'tool_result', { tool_use_id: 't', content: 'ok', is_error: false }); assert.equal(f.d(a.id).state, 'provider_observed');
});

test('§8.1 merged result attribution is zero and blocks next input permanently in incarnation', t => {
  const f = fixture(t, { manual: true }); f.start(); const d = f.prompt();
  f.adapter.emit(f.iid, 'result', { user_message_uuids: [d.message_uuid, 'other'], is_error: false });
  f.adapter.emit(f.iid, 'lifecycle', { command_uuid: d.message_uuid, state: 'completed' });
  assert.equal(f.d(d.id).outcome, null); assert.equal(f.state().incarnations[0].attribution_uncertain, 1);
  assert.equal(f.prompt().state, 'rejected'); assert.equal(f.adapter.log.received.length, 1);
});

for (const error of [false, true]) test(`§8.1 allowed tool ${error ? 'natural error is unknown' : 'positive result is observed'}`, t => {
  const f = fixture(t, { toolError: error }); f.start(); f.adapter.toolRequest(f.iid, 't');
  const d = f.core.submit(f.req('tool_decision', { target_tool_use_id: 't' }));
  assert.equal(d.state, error ? 'unknown' : 'provider_observed');
  if (error) assert.equal(d.reason, 'tool_finished_error');
  assert.equal(f.adapter.log.executions.length, 1);
  assert.equal(f.core.submit(f.req('tool_decision', { target_tool_use_id: 't' })).state, 'rejected');
  assert.equal(f.adapter.log.executions.length, 1);
});

test('§8.1 denial requires exact nonce-bearing message, not arbitrary error', t => {
  const f = fixture(t, { manualTools: true }); f.start(); f.adapter.toolRequest(f.iid, 't');
  const d = f.core.submit(f.req('tool_decision', { target_tool_use_id: 't', body: { behavior: 'deny' } }));
  f.adapter.emit(f.iid, 'tool_result', { tool_use_id: 't', is_error: true, content: 'not the nonce' }); assert.equal(f.d(d.id).state, 'unknown');
  const decision = JSON.parse(f.state().tool_requests[0].decision);
  f.adapter.emit(f.iid, 'tool_result', { tool_use_id: 't', is_error: true, content: decision.message }); assert.equal(f.d(d.id).state, 'provider_observed');
});

test('§8.1 missing lifecycle remains written then unknown on exit; late consumption not resent', t => {
  const f = fixture(t, { late: true, omitLifecycle: true }); f.start(); const d = f.prompt();
  assert.equal(d.state, 'written'); f.adapter.flush(); assert.equal(f.d(d.id).state, 'written');
  const b = f.prompt(); assert.equal(b.state, 'queued');
  f.adapter.exit(f.iid); assert.equal(f.d(d.id).state, 'unknown'); assert.equal(f.d(b.id).state, 'expired');
  assert.equal(f.adapter.log.received.length, 1);
});

test('§8.1 first system_init missing capability closes after first turn and sends no new prompt', t => {
  const f = fixture(t, { capabilities: [] }); f.start(); const d = f.prompt();
  assert.equal(d.state, 'completed'); assert.equal(f.state().session.state, 'closed');
  assert.equal(f.prompt().state, 'rejected'); assert.equal(f.adapter.log.received.length, 1); assert.equal(f.adapter.log.closes.length, 1);
});
