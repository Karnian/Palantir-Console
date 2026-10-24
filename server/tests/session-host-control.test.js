'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/session-host-fixture');
const { SimulatedCrash } = require('../sessionHost/faults');

test('§5-8 live handoff interrupts before close and retains handed_off read-only session', t => {
  const f = fixture(t); f.start(); f.adapter.toolRequest(f.iid, 'pending');
  const order = [];
  const interrupt = f.adapter.interrupt, close = f.adapter.close;
  f.adapter.interrupt = id => { order.push('interrupt'); interrupt(id); };
  f.adapter.close = id => { order.push('close'); close(id); };
  assert.equal(f.core.submit(f.req('handoff')).state, 'done');
  assert.deepEqual(order, ['interrupt', 'close']);
  assert.equal(f.state().session.state, 'handed_off');
  assert.equal(f.state().tool_requests[0].state, 'cancelled');
  assert.equal(f.adapter.log.interrupts.length, 1); assert.equal(f.adapter.log.closes.length, 1);
});

test('§4.4 stop keeps active then resume succeeds; close prevents subsequent resume', t => {
  const f = fixture(t); f.start(); f.prompt();
  assert.equal(f.core.submit(f.req('stop')).state, 'done'); assert.equal(f.state().session.state, 'active');
  assert.equal(f.state().incarnations[0].end_reason, 'user_restart');
  const r = f.core.submit(f.req('resume')); assert.equal(r.state, 'done'); f.iid = r.incarnation_id; f.prompt();
  assert.equal(f.adapter.log.starts.length, 2); assert.equal(f.adapter.log.received.length, 2);
  assert.equal(f.core.submit(f.req('close')).state, 'done'); assert.equal(f.state().session.state, 'closed');
  assert.equal(f.core.submit(f.req('resume')).state, 'rejected'); assert.equal(f.adapter.log.starts.length, 2);
});

test('§8.1 attribution uncertainty has no human override; only stop then resume clears incarnation barrier', t => {
  const f = fixture(t, { manual: true }); f.start(); const p = f.prompt();
  f.adapter.emit(f.iid, 'result', { user_message_uuids: [p.message_uuid, 'merged'], is_error: false });
  assert.equal(f.core.submit(f.req('prompt', { body: 'override', confirmed: true })).state, 'rejected');
  assert.equal(f.adapter.log.received.length, 1);
  assert.equal(f.core.submit(f.req('stop')).state, 'done'); const r = f.core.submit(f.req('resume')); assert.equal(r.state, 'done'); f.iid = r.incarnation_id;
  f.prompt(); assert.equal(f.adapter.log.received.length, 2);
});

test('§8.1 control exclusivity rejects another key while close waits for exit; final state releases lock', t => {
  const f = fixture(t, { noExit: true }); f.start();
  const a = f.core.submit(f.req('stop')); assert.equal(a.state, 'accepted');
  assert.equal(f.core.submit(f.req('close')).reason, 'busy'); assert.equal(f.adapter.log.closes.length, 1);
  f.adapter.exit(f.iid); assert.equal(f.core.submit({ ...f.req('stop'), request_key: a.request_key }).state, 'done');
  const b = f.core.submit(f.req('close')); assert.equal(b.state, 'done'); assert.equal(f.state().session.state, 'closed');
});

for (const kind of ['close', 'stop', 'handoff']) test(`§8.1 ${kind} crash close_sent never resends; dead target resumes confirmation`, t => {
  const f = fixture(t); f.start(); f.faults.arm('after_close_sent'); const req = f.req(kind);
  assert.throws(() => f.core.submit(req), SimulatedCrash); assert.equal(f.adapter.log.starts.length, 1);
  f.probe.exit(f.iid); f.reboot().recover(); assert.equal(f.core.submit(req).state, 'done'); assert.equal(f.adapter.log.closes.length, 0);
  assert.equal(f.state().session.state, kind === 'stop' ? 'active' : kind === 'handoff' ? 'handed_off' : 'closed');
  // Positive close uses the very same adapter transport spy.
  f.start(); f.core.submit(f.req('close')); assert.equal(f.adapter.log.closes.length, 1);
});

test('§8.1 close crash orphan blocks old control; new key rechecks identity and signals once', t => {
  const f = fixture(t); f.start(); f.faults.arm('after_close_sent'); const req = f.req('close');
  assert.throws(() => f.core.submit(req), SimulatedCrash); f.reboot().recover();
  assert.equal(f.core.submit(req).state, 'blocked'); assert.equal(f.adapter.log.closes.length, 0);
  assert.equal(f.core.submit(f.req('close')).state, 'done'); assert.equal(f.adapter.log.signals.length, 1);
});

test('§8.1 orphan identity mismatch signals zero; liveness_unknown close rejected', t => {
  const f = fixture(t); f.start(); f.reboot().recover();
  assert.equal(f.core.submit(f.req('close')).state, 'done'); assert.equal(f.adapter.log.signals.length, 1);
  f.start(); f.reboot().recover(); const i = f.state().incarnations[0];
  f.probe.checks.set(`${i.pid}:${i.pid_started_at}`, 'mismatch_confirmed');
  assert.equal(f.core.submit(f.req('close')).reason, 'identity_mismatch'); assert.equal(f.adapter.log.signals.length, 1);
  f.probe.checks.set(`${i.pid}:${i.pid_started_at}`, 'query_failed'); f.core.recover();
  assert.equal(f.core.submit(f.req('close')).reason, 'liveness_unknown'); assert.equal(f.adapter.log.signals.length, 1);
});

for (const kind of ['close', 'handoff']) test(`§8.1 exited target ${kind} has no close/signal effect; descendants block then new key completes`, t => {
  const f = fixture(t); f.start(); f.core.submit(f.req('close')); assert.equal(f.adapter.log.closes.length, 1);
  f.start(); f.adapter.exit(f.iid); f.probe.descendants.set(f.iid, { status: 'ok', pids: [{ pid: 9, startedAt: 'x' }] });
  assert.equal(f.core.submit(f.req(kind)).state, 'blocked'); assert.equal(f.state().session.state, 'active');
  f.probe.descendants.delete(f.iid); assert.equal(f.core.submit(f.req(kind)).state, 'done');
  assert.equal(f.adapter.log.closes.length, 1); assert.equal(f.adapter.log.signals.length, 0);
});

for (const result of [{ status: 'ok', pids: [{ pid: 44, startedAt: 'x' }] }, { status: 'query_failed' }]) test(`§3.4 descendants ${result.status} block resume and handoff despite human confirmation`, t => {
  const f = fixture(t); f.start(); f.adapter.exit(f.iid); f.probe.descendants.set(f.iid, result);
  assert.equal(f.core.submit(f.req('resume', { confirmed: true })).state, 'rejected');
  assert.equal(f.core.submit(f.req('handoff', { confirmed: true })).state, 'blocked'); assert.equal(f.adapter.log.starts.length, 1);
  f.probe.descendants.delete(f.iid); const r = f.core.submit(f.req('resume')); assert.equal(r.state, 'done'); assert.equal(f.adapter.log.starts.length, 2);
});

for (const gate of ['settings', 'auth']) test(`§8.1 injected ${gate} failure fails closed; successful condition actually starts/sends`, t => {
  const f = fixture(t); f.start(); f.prompt(); assert.equal(f.adapter.log.received.length, 1);
  f.adapter.options[gate] = false;
  if (gate === 'settings') {
    const c = f.core.submit({ request_key: f.key(), kind: 'start' }); assert.equal(c.reason, 'settings_failed'); assert.equal(f.adapter.log.starts.length, 1);
  } else {
    assert.equal(f.prompt().reason, 'auth_failed'); assert.equal(f.adapter.log.received.length, 1);
    const c = f.core.submit({ request_key: f.key(), kind: 'start' }); assert.equal(c.reason, 'auth_failed'); assert.equal(f.adapter.log.closes.length, 1);
  }
});

test('§8.1 failed auth with no exit signals after identity recheck and records liveness_unknown', t => {
  const f = fixture(t, { noExit: true }); f.start(); f.adapter.options.auth = false;
  const c = f.core.submit({ request_key: f.key(), kind: 'start' });
  assert.equal(c.state, 'failed'); assert.equal(f.core.snapshot(c.session_id).state.incarnations[0].state, 'liveness_unknown');
  assert.equal(f.adapter.log.closes.length, 1); assert.equal(f.adapter.log.signals.length, 1);
});
