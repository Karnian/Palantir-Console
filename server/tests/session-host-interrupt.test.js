'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/session-host-fixture');

test('§8.1 interrupt before decision cancels card; provider resolve spy excludes second decision', t => {
  const f = fixture(t); f.start(); f.adapter.toolRequest(f.iid, 'first');
  f.core.submit(f.req('tool_decision', { target_tool_use_id: 'first' }));
  assert.equal(f.adapter.log.decisions.length, 1);
  f.adapter.toolRequest(f.iid, 'second'); f.core.submit(f.req('interrupt'));
  assert.equal(f.core.submit(f.req('tool_decision', { target_tool_use_id: 'second' })).state, 'rejected');
  assert.equal(f.adapter.log.decisions.length, 1); assert.equal(f.state().tool_requests.find(x => x.tool_use_id === 'second').state, 'cancelled');
});

test('§8.1 same-tick signal abort invalidates pre-effect decision and cannot cancel post-effect state', t => {
  const f = fixture(t, { manualTools: true }); f.start(); f.adapter.toolRequest(f.iid, 'ok');
  const ok = f.core.submit(f.req('tool_decision', { target_tool_use_id: 'ok' })); assert.equal(f.adapter.log.decisions.length, 1);
  const a = f.adapter.toolRequest(f.iid, 'abort'); a.abort();
  assert.equal(f.core.submit(f.req('tool_decision', { target_tool_use_id: 'abort' })).state, 'rejected');
  assert.equal(f.adapter.log.decisions.length, 1);
  f.adapter.emit(f.iid, 'signal_abort', { tool_use_id: 'ok' }); assert.equal(f.d(ok.id).state, 'written');
  f.adapter.emit(f.iid, 'tool_result', { tool_use_id: 'ok', is_error: false, content: 'ok' });
  assert.equal(f.d(ok.id).state, 'unknown'); assert.equal(f.d(ok.id).reason, 'tool_finished');
  assert.ok(f.core.eventsSince(0).events.some(x => x.type === 'decision_tool_aborted'));
});

test('§4.5 last synchronous facts check after sending commit cancels without provider effect', t => {
  const f = fixture(t); f.start(); f.prompt(); assert.equal(f.adapter.log.received.length, 1);
  const hit = f.faults.hit.bind(f.faults);
  f.faults.hit = p => { hit(p); if (p === 'after_sending_commit') f.adapter.children.get(f.iid).exited = true; };
  assert.equal(f.prompt().state, 'cancelled'); assert.equal(f.adapter.log.received.length, 1);
});

test('§8.1 still_queued receipt taints incarnation and prevents all result attribution and queue drain', t => {
  const f = fixture(t, { manual: true }); f.start(); const p = f.prompt(), q = f.prompt('q');
  f.adapter.options.stillQueued = [p.message_uuid];
  const int = f.core.submit(f.req('interrupt')); assert.equal(int.state, 'provider_observed');
  f.adapter.emit(f.iid, 'result', { user_message_uuids: [p.message_uuid], is_error: true, subtype: 'error_during_execution' });
  f.adapter.emit(f.iid, 'lifecycle', { command_uuid: p.message_uuid, state: 'cancelled' });
  assert.equal(f.d(p.id).outcome, null); assert.equal(f.d(q.id).state, 'queued');
  assert.equal(f.prompt().state, 'rejected'); assert.equal(f.adapter.log.received.length, 1);
});

test('§5-5 absent receipt unknown clears only on target generation result; duplicate interrupt returns same request', t => {
  const f = fixture(t, { manual: true, noReceipt: true }); f.start(); const old = f.prompt();
  f.adapter.emit(f.iid, 'lifecycle', { command_uuid: old.message_uuid, state: 'completed' });
  const p = f.prompt(); const int = f.core.submit(f.req('interrupt'));
  assert.equal(int.state, 'written'); f.advance(10000); f.core.tick();
  assert.equal(f.d(int.id).state, 'unknown'); assert.equal(f.core.submit(f.req('interrupt')).id, int.id);
  assert.equal(f.adapter.log.interrupts.length, 1);
  f.adapter.emit(f.iid, 'result', { user_message_uuids: [old.message_uuid], is_error: false }); assert.equal(f.d(int.id).state, 'unknown');
  f.adapter.emit(f.iid, 'result', { user_message_uuids: [p.message_uuid], is_error: true, subtype: 'error_during_execution' }); assert.equal(f.d(int.id).state, 'completed');
  assert.equal(f.core.idle(f.sid), false);
  f.adapter.emit(f.iid, 'lifecycle', { command_uuid: p.message_uuid, state: 'cancelled' });
  assert.equal(f.d(p.id).outcome, 'interrupted'); assert.equal(f.core.idle(f.sid), true);
  f.prompt(); assert.equal(f.adapter.log.received.length, 3);
});

test('§8.1 interrupt after allow makes only that decision unknown; next turn positive allow observed', t => {
  const f = fixture(t, { manualTools: true }); f.start(); f.prompt(); f.adapter.toolRequest(f.iid, 'a');
  const a = f.core.submit(f.req('tool_decision', { target_tool_use_id: 'a' })); f.core.submit(f.req('interrupt'));
  f.adapter.emit(f.iid, 'tool_result', { tool_use_id: 'a', is_error: false, content: 'ok' }); assert.equal(f.d(a.id).state, 'unknown');
  f.prompt(); f.adapter.toolRequest(f.iid, 'b'); const b = f.core.submit(f.req('tool_decision', { target_tool_use_id: 'b' }));
  f.adapter.emit(f.iid, 'tool_result', { tool_use_id: 'b', is_error: false, content: 'ok' }); assert.equal(f.d(b.id).state, 'provider_observed');
  assert.equal(f.adapter.log.executions.length, 2);
});
