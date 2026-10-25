'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/session-host-fixture');
const { SimulatedCrash } = require('../sessionHost/faults');

for (const point of ['after_sending_commit', 'after_effect_before_written', 'before_accepted_reply']) {
  test(`§8.1 crash ${point}: same DB recovery never retransmits`, t => {
    const f = fixture(t, { drop: true }); f.start(); f.prompt('baseline');
    // Finish the baseline so the next delivery can cross the effect boundary.
    const baseline = f.state().deliveries[0];
    f.adapter.emit(f.iid, 'lifecycle', { command_uuid: baseline.message_uuid, state: 'completed' });
    const req = f.req('prompt', { body: 'crash' }); f.faults.arm(point);
    assert.throws(() => f.core.submit(req), SimulatedCrash);
    const count = f.adapter.log.received.length;
    f.reboot().recover(); const d = f.core.submit(req);
    assert.equal(d.state, 'unknown'); assert.equal(f.adapter.log.received.length, count);
    assert.equal(count, point === 'after_sending_commit' ? 1 : 2);
    assert.equal(f.state().incarnations[0].state, 'orphaned');
  });
}

test('§8.1 decided commit crash preserves decided card and refuses second answer', t => {
  const f = fixture(t); f.start(); f.adapter.toolRequest(f.iid, 'baseline');
  f.core.submit(f.req('tool_decision', { target_tool_use_id: 'baseline', body: { behavior: 'allow' } }));
  f.adapter.toolRequest(f.iid, 'crash'); f.faults.arm('after_decided_commit');
  assert.throws(() => f.core.submit(f.req('tool_decision', { target_tool_use_id: 'crash', body: { behavior: 'allow' } })), SimulatedCrash);
  f.reboot().recover();
  assert.equal(f.state().tool_requests.find(t => t.tool_use_id === 'crash').state, 'decided');
  assert.equal(f.state().deliveries.find(d => d.target_tool_use_id === 'crash').state, 'unknown');
  assert.equal(f.core.submit(f.req('tool_decision', { target_tool_use_id: 'crash', body: { behavior: 'allow' } })).state, 'rejected');
  assert.equal(f.adapter.log.decisions.length, 1);
});

for (const point of ['after_control_accept_before_reply', 'after_spawn_sent_before_spawn', 'after_spawn_before_identity']) {
  test(`§8.1 start crash ${point}: reservation stable, marked identity recovery, spawn at most once`, t => {
    const f = fixture(t); f.start(); assert.equal(f.adapter.log.starts.length, 1);
    const req = { request_key: f.key(), kind: 'start', cwd: '/other' }; f.faults.arm(point);
    assert.throws(() => f.core.submit(req), SimulatedCrash);
    f.reboot().recover(); const c = f.core.submit(req), same = f.core.submit(req);
    assert.equal(c.session_id, same.session_id); assert.equal(c.incarnation_id, same.incarnation_id);
    const i = f.core.snapshot(c.session_id).state.incarnations[0];
    assert.equal(i.state, point === 'after_spawn_before_identity' ? 'orphaned' : 'never_started');
    assert.equal(c.reason, point === 'after_spawn_before_identity' ? 'control_lost' : 'not_started');
    assert.equal(f.adapter.log.starts.length, point === 'after_spawn_before_identity' ? 2 : 1);
  });
}

for (const mode of ['match', 'mismatch_confirmed', 'query_failed']) test(`§3.3 alive recovery identity ${mode} preserves three-valued liveness`, t => {
  const f = fixture(t, { manual: true }); f.start(); const d = f.prompt();
  const i = f.state().incarnations[0]; f.probe.checks.set(`${i.pid}:${i.pid_started_at}`, mode);
  f.reboot().recover(); assert.equal(f.state().incarnations[0].state, mode === 'match' ? 'orphaned' : mode === 'mismatch_confirmed' ? 'exited' : 'liveness_unknown');
  assert.equal(f.d(d.id).state, 'provider_observed'); assert.equal(f.d(d.id).outcome, 'outcome_unknown');
  assert.equal(f.adapter.log.received.length, 1);
  const r = f.core.submit(f.req('resume'));
  if (mode === 'mismatch_confirmed') {
    assert.equal(r.state, 'done'); f.iid = r.incarnation_id; assert.equal(f.core.idle(f.sid), true); f.prompt(); assert.equal(f.adapter.log.received.length, 2);
  } else { assert.equal(r.state, 'rejected'); assert.equal(f.adapter.log.starts.length, 1); }
});

test('§3.3 spawn identity gap query failure is liveness_unknown, never a second spawn', t => {
  const f = fixture(t); f.start(); const req = { request_key: f.key(), kind: 'start' }; f.faults.arm('after_spawn_before_identity');
  assert.throws(() => f.core.submit(req), SimulatedCrash);
  const id = f.adapter.log.starts.at(-1); f.probe.marked.set(id, { status: 'query_failed' });
  f.reboot().recover(); const c = f.core.submit(req);
  assert.equal(f.core.snapshot(c.session_id).state.incarnations[0].state, 'liveness_unknown'); assert.equal(f.adapter.log.starts.length, 2);
});

test('§8.1 observed tool decision remains observed on recovery without prompt outcome', t => {
  const f = fixture(t); f.start(); f.adapter.toolRequest(f.iid, 't'); const d = f.core.submit(f.req('tool_decision', { target_tool_use_id: 't', body: { behavior: 'allow' } }));
  f.reboot().recover(); assert.equal(f.d(d.id).state, 'provider_observed'); assert.equal(f.d(d.id).outcome, null); assert.equal(f.adapter.log.executions.length, 1);
});

test('§8.1 observed prompt accepted reply crash retries existing completed result once', t => {
  const f = fixture(t); f.start(); const req = f.req('prompt'); f.faults.arm('before_accepted_reply');
  assert.throws(() => f.core.submit(req), SimulatedCrash); f.reboot().recover();
  assert.equal(f.core.submit(req).state, 'completed'); assert.equal(f.adapter.log.received.length, 1);
});
