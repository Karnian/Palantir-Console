'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { fixture } = require('./helpers/session-host-fixture');
const pin = require('../sessionHost/pin');
const settings = () => ({ effective: {}, sources: [], provenance: {} });
const account = () => ({ email: 'fake@example.test', organization: 'fake', subscriptionType: 'Claude Max', apiProvider: 'firstParty' });
function initialize(f, override = {}) {
  f.adapter.emit(f.iid, 'initialization', { initialization: {
    account: account(), pid: f.adapter.children.get(f.iid).pid,
    claude_code_version: pin.cliVersion, current_permission_mode: 'default',
    remote_control_auto_enable: false, ...override
  } });
}
async function start(f) {
  const accepted = f.start();
  await f.settle();
  return f.core.lookup(accepted.request_key);
}
async function microtasks() {
  for (let n = 0; n < 32; n++) await Promise.resolve();
}

for (const async of [false, true]) {
  for (const kind of ['tool_decision', 'question_answer']) {
    test(`B2a-R1-01 async=${async} ${kind} keeps pre-gate card pending and permits a new answer after done`, async t => {
      const f = fixture(t, { async, noInitialization: true });
      const accepted = await start(f);
      assert.equal(accepted.stage, 'gating');
      f.adapter.toolRequest(f.iid, 'card', kind === 'question_answer' ? 'AskUserQuestion' : 'Bash');
      const request = f.req(kind, { target_tool_use_id: 'card', body: kind === 'question_answer' ? { answer: 'yes' } : { behavior: 'allow' } });
      const rejected = f.core.submit(request);
      assert.equal(rejected.state, 'rejected');
      assert.equal(rejected.reason, 'gate_pending');
      assert.equal(f.state().tool_requests[0].state, 'pending');
      assert.equal(f.state().tool_requests[0].answer_delivery_id, null);
      assert.equal(f.adapter.log.decisions.length, 0);
      initialize(f);
      await f.settle();
      assert.equal(f.core.lookup(accepted.request_key).state, 'done');
      assert.equal(f.core.submit(request).reason, 'gate_pending');
      const answered = f.core.submit({ ...request, request_key: f.key() });
      assert.equal(answered.state, 'provider_observed');
      assert.equal(f.state().tool_requests[0].state, 'decided');
      assert.equal(f.adapter.log.decisions.length, 1);
      assert.equal(f.adapter.log.executions.length, kind === 'tool_decision' ? 1 : 0);
    });

    test(`B2a-R1-01 async=${async} ${kind} blocks throughout gate cleanup and expires card`, async t => {
      const good = fixture(t, { async });
      assert.equal((await start(good)).state, 'done');
      good.adapter.toolRequest(good.iid, 'card', kind === 'question_answer' ? 'AskUserQuestion' : 'Bash');
      assert.equal(good.core.submit(good.req(kind, { target_tool_use_id: 'card', body: kind === 'question_answer' ? { answer: 'yes' } : { behavior: 'allow' } })).state, 'provider_observed');
      const f = fixture(t, { async, noInitialization: true, noExit: true });
      const accepted = await start(f);
      f.adapter.toolRequest(f.iid, 'card', kind === 'question_answer' ? 'AskUserQuestion' : 'Bash');
      initialize(f, { remote_control_auto_enable: true });
      assert.equal(f.core.lookup(accepted.request_key).stage, 'gate_close_sent');
      const reply = () => f.core.submit(f.req(kind, { target_tool_use_id: 'card', body: kind === 'question_answer' ? { answer: 'yes' } : { behavior: 'allow' } }));
      assert.equal(reply().reason, 'gate_pending');
      assert.equal(f.state().tool_requests[0].state, 'pending');
      f.advance(pin.closeWaitMs); f.core.tick();
      assert.equal(f.core.lookup(accepted.request_key).stage, 'gate_signal_sent');
      assert.equal(reply().reason, 'gate_pending');
      f.advance(pin.sigtermWaitMs); f.core.tick();
      assert.equal(f.core.lookup(accepted.request_key).reason, 'gate_rejected_unverified');
      assert.equal(f.state().tool_requests[0].state, 'expired');
      assert.equal(f.adapter.log.decisions.length, 0);
    });
  }

  test(`B2a-R1-01 async=${async} tool_request during spawn is retained before identity commit`, async t => {
    const f = fixture(t, { async, noInitialization: true });
    const spawn = f.adapter.start;
    f.adapter.start = request => {
      const identity = spawn(request);
      f.adapter.toolRequest(request.incarnation_id, 'early-card');
      return identity;
    };
    await start(f);
    assert.equal(f.state().tool_requests.length, 1);
    assert.equal(f.state().tool_requests[0].state, 'pending');
    assert.equal(f.core.submit(f.req('tool_decision', { target_tool_use_id: 'early-card', body: { behavior: 'allow' } })).reason, 'gate_pending');
    initialize(f, { current_permission_mode: 'plan' });
    assert.equal(f.state().tool_requests[0].state, 'expired');
    assert.equal(f.adapter.log.decisions.length, 0);
  });
}

for (const shape of ['value', 'promise', 'thenable']) {
  for (const elapsed of [pin.resolveSettingsDeadlineMs, pin.resolveSettingsDeadlineMs + 1]) {
    test(`B2a-R1-02 ${shape} returned after ${elapsed}ms cannot reset the settings deadline`, async t => {
      const good = fixture(t, { async: true });
      good.adapter.checkSettings = () => {
        good.advance(pin.resolveSettingsDeadlineMs - 1);
        return shape === 'value' ? settings() : shape === 'promise' ? Promise.resolve(settings()) : { then(resolve) { resolve(settings()); } };
      };
      assert.equal((await start(good)).state, 'done');
      assert.equal(good.adapter.log.starts.length, 1);
      const f = fixture(t, { async: true });
      f.adapter.checkSettings = () => {
        f.advance(elapsed);
        return shape === 'value' ? settings() : shape === 'promise' ? Promise.resolve(settings()) : { then(resolve) { resolve(settings()); } };
      };
      const result = await start(f);
      assert.equal(result.state, 'failed');
      assert.equal(result.reason, 'settings_check_failed');
      assert.equal(f.state().incarnations[0].state, 'never_started');
      assert.equal(f.adapter.log.starts.length, 0);
    });
  }
}
for (const shape of ['throw', 'reject']) {
  test(`B2a-R1-02 late ${shape} still fails settings with spawn zero`, async t => {
    const good = fixture(t, { async: true });
    assert.equal((await start(good)).state, 'done');
    const f = fixture(t, { async: true });
    f.adapter.checkSettings = () => {
      f.advance(pin.resolveSettingsDeadlineMs);
      if (shape === 'throw') throw new Error('private failure');
      return Promise.reject(new Error('private failure'));
    };
    assert.equal((await start(f)).reason, 'settings_check_failed');
    assert.equal(f.adapter.log.starts.length, 0);
  });
}

test('B2a-R1-02 pending thenable gets only the time remaining after the adapter call', async t => {
  const good = fixture(t, { async: true });
  good.adapter.checkSettings = () => { good.advance(6000); return Promise.resolve(settings()); };
  assert.equal((await start(good)).state, 'done');
  const f = fixture(t, { async: true });
  let resolve;
  f.adapter.checkSettings = () => { f.advance(6000); return new Promise(done => { resolve = done; }); };
  const accepted = f.start();
  await microtasks();
  f.advance(3999); f.core.tick();
  await microtasks();
  assert.equal(f.core.lookup(accepted.request_key).state, 'accepted');
  f.advance(1); f.core.tick();
  await microtasks();
  try {
    assert.equal(f.core.lookup(accepted.request_key).state, 'failed');
    assert.equal(f.core.lookup(accepted.request_key).reason, 'settings_check_failed');
  } finally {
    resolve(settings());
    await f.settle();
  }
  assert.equal(f.adapter.log.starts.length, 0);
});

for (const async of [false, true]) {
  test(`B2a-R1-03 async=${async} rate limit metadata is absent from durable events and both read APIs`, async t => {
    const f = fixture(t, { async });
    await start(f);
    const info = { status: 'allowed', resetsAt: 123, rateLimitType: 'five_hour', overageStatus: null, overageDisabledReason: 'disabled', isUsingOverage: false };
    f.adapter.emit(f.iid, 'rate_limit', { rate_limit_info: info });
    assert.deepEqual(f.state().incarnations[0].rate_limit_info, info);
    const secret = { email: 'PRIVATE_EMAIL_MARKER', organization: 'PRIVATE_ORG_MARKER', account: { token: 'PRIVATE_ACCOUNT_MARKER' } };
    f.adapter.emit(f.iid, 'rate_limit', { ...secret, rate_limit_info: { ...info, ...secret } });
    assert.deepEqual(f.state().incarnations[0].rate_limit_info, info);
    const db = new Database(f.dbPath);
    const rows = db.prepare('SELECT type,json FROM events').all();
    db.close();
    for (const serialized of [JSON.stringify(rows), JSON.stringify(f.core.snapshot(f.sid)), JSON.stringify(f.core.eventsSince(0))]) {
      for (const key of Object.keys(secret)) assert.equal(serialized.includes(`${JSON.stringify(key)}:`), false);
      for (const marker of ['PRIVATE_EMAIL_MARKER', 'PRIVATE_ORG_MARKER', 'PRIVATE_ACCOUNT_MARKER']) assert.equal(serialized.includes(marker), false);
    }
    const sdk = rows.filter(row => row.type === 'sdk').map(row => JSON.parse(row.json)).filter(event => event.type === 'rate_limit');
    assert.deepEqual(sdk[1], { type: 'rate_limit', incarnation_id: f.iid, rate_limit_info: info });
    f.reboot().recover();
    assert.deepEqual(f.state().incarnations[0].rate_limit_info, info);
  });
}

for (const [label, value] of [
  ['object', { email: 'PRIVATE_NESTED_EMAIL' }], ['array', ['PRIVATE_NESTED_EMAIL']],
  ['undefined', undefined], ['function', () => 'PRIVATE_NESTED_EMAIL'], ['symbol', Symbol('private')],
  ['bigint', 1n], ['NaN', NaN], ['Infinity', Infinity]
]) {
  test(`B2a-R1-03 rate limit ${label} is dropped before any event serialization`, async t => {
    const f = fixture(t, { async: true });
    await start(f);
    f.adapter.emit(f.iid, 'rate_limit', { rate_limit_info: { status: 'allowed', resetsAt: 123 } });
    assert.deepEqual(f.state().incarnations[0].rate_limit_info, { status: 'allowed', resetsAt: 123 });
    assert.doesNotThrow(() => f.adapter.emit(f.iid, 'rate_limit', { rate_limit_info: { status: 'allowed', resetsAt: value } }));
    assert.deepEqual(f.state().incarnations[0].rate_limit_info, { status: 'allowed' });
    const serialized = JSON.stringify(f.core.eventsSince(0));
    assert.equal(serialized.includes('PRIVATE_NESTED_EMAIL'), false);
    const db = new Database(f.dbPath);
    const sdk = db.prepare("SELECT json FROM events WHERE type='sdk' ORDER BY seq DESC LIMIT 1").get();
    db.close();
    assert.deepEqual(JSON.parse(sdk.json).rate_limit_info, { status: 'allowed' });
  });
}

for (const async of [false, true]) {
  test(`B2a-R1-04 async=${async} late main exit preserves unverified control; descendants block resume and failed gate blocks handoff`, async t => {
    const f = fixture(t, { async, noInitialization: true, noExit: true });
    const accepted = await start(f);
    f.probe.descendants.set(f.iid, { status: 'ok', pids: [{ pid: 3000, startedAt: 'tool-start' }] });
    initialize(f, { remote_control_auto_enable: true });
    f.advance(pin.closeWaitMs); f.core.tick();
    f.advance(pin.sigtermWaitMs); f.core.tick();
    assert.equal(f.core.lookup(accepted.request_key).reason, 'gate_rejected_unverified');
    assert.equal(f.state().incarnations[0].state, 'liveness_unknown');
    f.adapter.exit(f.iid);
    assert.equal(f.state().incarnations[0].state, 'exited');
    assert.equal(f.core.lookup(accepted.request_key).reason, 'gate_rejected_unverified');
    const resume = f.core.submit(f.req('resume'));
    assert.equal(resume.state, 'rejected');
    assert.equal(resume.reason, 'subprocess_remaining');
    const handoff = f.core.submit(f.req('handoff'));
    assert.equal(handoff.state, 'rejected');
    assert.equal(handoff.reason, 'handoff_identity_unavailable');
    assert.equal(f.adapter.log.starts.length, 1);
    f.probe.descendants.delete(f.iid);
    f.adapter.options.noInitialization = false;
    const retry = f.core.submit(f.req('resume'));
    await f.settle();
    assert.equal(f.core.lookup(retry.request_key).state, 'done');
    assert.equal(f.adapter.log.starts.length, 2);
    assert.equal(f.core.lookup(accepted.request_key).reason, 'gate_rejected_unverified');
  });
}
