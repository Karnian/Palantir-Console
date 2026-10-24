'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/session-host-fixture');
const pin = require('../sessionHost/pin');

const account = () => ({ email: 'fake@example.test', organization: 'fake', subscriptionType: 'Claude Max', apiProvider: 'firstParty' });
const settings = () => ({ effective: {}, sources: [], provenance: {} });
async function start(f) {
  const accepted = f.start();
  await f.core.flush();
  return f.core.lookup(accepted.request_key);
}
async function prompt(f) {
  const accepted = f.prompt();
  await f.core.flush();
  return f.core.lookup(accepted.request_key);
}
const microtasks = async () => {
  for (let index = 0; index < 12; index++) await Promise.resolve();
};

for (const [name, checkSettings, reason] of [
  ['auth env', async () => ({ ...settings(), effective: { env: { ANTHROPIC_BASE_URL: 'https://invalid.test' } } }), 'settings_rejected'],
  ['helper', async () => ({ ...settings(), effective: { apiKeyHelper: 'blocked' } }), 'settings_rejected'],
  ['throw', async () => { throw new Error('private detail'); }, 'settings_check_failed'],
  ['missing effective', async () => ({ sources: [], provenance: {} }), 'settings_check_failed'],
  ['invalid env', async () => ({ ...settings(), effective: { env: { A: 1 } } }), 'settings_check_failed'],
  ['invalid sources', async () => ({ ...settings(), sources: {} }), 'settings_check_failed']
]) test(`S1-b2a settings ${name} refuses spawn with passing control`, async t => {
  const good = fixture(t);
  assert.equal((await start(good)).state, 'done');
  assert.equal(good.adapter.log.starts.length, 1);
  const bad = fixture(t, { checkSettings });
  assert.equal((await start(bad)).reason, reason);
  assert.equal(bad.state().incarnations[0].state, 'never_started');
  assert.equal(bad.adapter.log.starts.length, 0);
});

test('S1-b2a settings timeout uses tick and ignores late result', async t => {
  const good = fixture(t);
  assert.equal((await start(good)).state, 'done');
  let resolve;
  const f = fixture(t, { checkSettings: () => new Promise(done => { resolve = done; }) });
  const accepted = f.start();
  await microtasks();
  assert.equal(f.core.lookup(accepted.request_key).stage, 'settings_checking');
  f.advance(pin.resolveSettingsDeadlineMs);
  f.core.tick();
  await f.core.flush();
  assert.equal(f.core.lookup(accepted.request_key).reason, 'settings_check_failed');
  resolve(settings());
  await microtasks();
  assert.equal(f.adapter.log.starts.length, 0);
});

for (const [name, patch] of [
  ['subscription', {}], ['API key', { apiKeySource: 'ANTHROPIC_API_KEY' }],
  ['bearer', { tokenSource: 'ANTHROPIC_AUTH_TOKEN' }],
  ['OAuth env', { tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' }],
  ['helper', { tokenSource: 'apiKeyHelper' }], ['Bedrock', { apiProvider: 'bedrock' }]
]) test(`S1-b2a initialization account ${name}`, async t => {
  const good = fixture(t);
  assert.equal((await start(good)).state, 'done');
  const f = fixture(t, { account: { ...account(), ...patch } });
  const result = await start(f);
  assert.equal(result.state, name === 'subscription' ? 'done' : 'failed');
  assert.equal(f.adapter.log.closes.length, name === 'subscription' ? 0 : 1);
  if (name !== 'subscription') {
    assert.equal(result.reason, 'gate_rejected_cleaned');
    assert.equal(f.state().incarnations[0].state, 'exited');
  }
  assert.equal(JSON.stringify(f.core.eventsSince(0)).includes('fake@example.test'), false);
});

for (const [field, value] of [
  ['pid', 99], ['claude_code_version', 'wrong'],
  ['current_permission_mode', 'plan'], ['remote_control_auto_enable', true]
]) test(`S1-b2a initialization ${field} mismatch cleans up`, async t => {
  const good = fixture(t);
  assert.equal((await start(good)).state, 'done');
  const f = fixture(t, { initialization: { [field]: value } });
  assert.equal((await start(f)).reason, 'gate_rejected_cleaned');
  assert.equal(f.adapter.log.closes.length, 1);
  assert.equal(f.state().incarnations[0].state, 'exited');
});

test('S1-b2a initialization timeout closes and confirms exit', async t => {
  const good = fixture(t);
  assert.equal((await start(good)).state, 'done');
  const f = fixture(t, { noInitialization: true });
  const accepted = await start(f);
  assert.equal(accepted.stage, 'gating');
  f.advance(pin.initializationDeadlineMs);
  f.core.tick();
  assert.equal(f.core.lookup(accepted.request_key).reason, 'initialization_timeout');
  assert.equal(f.adapter.log.closes.length, 1);
  assert.equal(f.state().incarnations[0].state, 'exited');
});

for (const verdict of ['match', 'mismatch_confirmed', 'query_failed']) {
  test(`S1-b2a cleanup identity ${verdict} guards signal and queries markers`, async t => {
    const f = fixture(t, { noExit: true, initialization: { remote_control_auto_enable: true } });
    const accepted = await start(f);
    const incarnation = f.state().incarnations[0];
    f.probe.checks.set(`${incarnation.pid}:${incarnation.pid_started_at}`, verdict);
    let queries = 0;
    f.probe.listMarkedDescendants = () => { queries++; return { status: 'query_failed' }; };
    assert.equal(f.adapter.log.closes.length, 1);
    assert.equal(f.probe.signals.length, 0);
    f.advance(pin.closeWaitMs);
    f.core.tick();
    assert.equal(f.probe.signals.length, verdict === 'match' ? 1 : 0);
    f.advance(pin.sigtermWaitMs);
    f.core.tick();
    assert.equal(queries, 1);
    assert.equal(f.core.lookup(accepted.request_key).reason, 'gate_rejected_unverified');
    assert.equal(f.state().incarnations[0].state, 'liveness_unknown');
  });
}

for (const mode of ['changed', 'throw']) {
  test(`S1-b2a prompt recheck ${mode} rejects with send zero`, async t => {
    const good = fixture(t);
    await start(good);
    await prompt(good);
    assert.equal(good.adapter.log.received.length, 1);
    const f = fixture(t);
    await start(f);
    f.adapter.options.accountInfo = async () => {
      if (mode === 'throw') throw new Error('private failure');
      return { ...account(), apiProvider: 'bedrock' };
    };
    const delivery = await prompt(f);
    assert.equal(delivery.state, 'rejected');
    assert.equal(delivery.reason, 'auth_recheck_failed');
    assert.equal(f.adapter.log.received.length, 0);
  });
}

test('S1-b2a recheck releases queue and interrupt prevents send', async t => {
  const f = fixture(t);
  await start(f);
  let resolve;
  f.adapter.options.accountInfo = () => new Promise(done => { resolve = done; });
  const delivery = f.prompt();
  await microtasks();
  assert.equal(f.core.activity().pendingCommands, 0);
  f.core.submit(f.req('interrupt'));
  assert.equal(f.adapter.log.interrupts.length, 1);
  resolve(account());
  await f.core.flush();
  assert.equal(f.core.lookup(delivery.request_key).state, 'rejected');
  assert.equal(f.adapter.log.received.length, 0);
});

test('S1-b2a non-subscription system init fails turn and closes', async t => {
  const good = fixture(t);
  await start(good);
  await prompt(good);
  assert.equal(good.adapter.log.closes.length, 0);
  const f = fixture(t, { apiKeySource: 'ANTHROPIC_API_KEY' });
  await start(f);
  const delivery = await prompt(f);
  assert.equal(delivery.outcome, 'errored');
  assert.equal(delivery.reason, 'auth_source_not_subscription');
  assert.equal(f.adapter.log.closes.length, 1);
  assert.equal(f.state().session.state, 'closed');
});

test('S1-b2a rate limit survives reboot; forbidden env refuses spawn', async t => {
  const f = fixture(t);
  await start(f);
  const info = { status: 'allowed_warning', resetsAt: 123, rateLimitType: 'five_hour', overageStatus: 'allowed', overageDisabledReason: null, isUsingOverage: true };
  f.adapter.emit(f.iid, 'rate_limit', { rate_limit_info: info });
  assert.deepEqual(f.state().incarnations[0].rate_limit_info, info);
  f.reboot().recover();
  assert.deepEqual(f.state().incarnations[0].rate_limit_info, info);
  const bad = fixture(t, { injectEnv: { PALANTIR_TOKEN: 'forbidden' } });
  assert.equal((await start(bad)).reason, 'invalid_child_env');
  assert.equal(bad.adapter.log.starts.length, 0);
  assert.equal(bad.state().incarnations[0].state, 'never_started');
});
