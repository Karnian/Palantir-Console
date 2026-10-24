'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { fixture: baseFixture } = require('./helpers/session-host-fixture');
const { SimulatedCrash } = require('../sessionHost/faults');
const pin = require('../sessionHost/pin');
const fixture = (t, options = {}) => baseFixture(t, { async: true, ...options });
const account = () => ({ email: 'fake@example.test', organization: 'fake', subscriptionType: 'Claude Max', apiProvider: 'firstParty' });
const settings = () => ({ effective: {}, sources: [], provenance: {} });
async function start(f) {
  const accepted = f.start();
  await f.settle();
  return f.core.lookup(accepted.request_key);
}
async function send(f) {
  const delivery = f.prompt();
  await f.settle();
  return f.d(delivery.id);
}
async function microtasks() {
  for (let turn = 0; turn < 32; turn++) await Promise.resolve();
}
function initialization(f, overrides = {}) {
  return { account: account(), pid: f.adapter.children.get(f.iid).pid,
    claude_code_version: pin.cliVersion, current_permission_mode: 'default',
    remote_control_auto_enable: false, ...overrides };
}

for (const field of ['effective', 'sources', 'provenance']) {
  test(`S1-b2a async missing settings ${field} fails closed with passing control`, async t => {
    const good = fixture(t);
    assert.equal((await start(good)).state, 'done');
    const f = fixture(t, { checkSettings: async () => { const value = settings(); delete value[field]; return value; } });
    assert.equal((await start(f)).reason, 'settings_check_failed');
    assert.equal(f.adapter.log.starts.length, 0);
  });
}
for (const value of [null, [], { x: 1 }]) {
  test(`S1-b2a async invalid settings env ${JSON.stringify(value)} refuses spawn`, async t => {
    const good = fixture(t, { checkSettings: async () => ({ ...settings(), effective: { env: { x: '1' } } }) });
    assert.equal((await start(good)).state, 'done');
    const f = fixture(t, { checkSettings: async () => ({ ...settings(), effective: { env: value } }) });
    assert.equal((await start(f)).reason, 'settings_check_failed');
    assert.equal(f.adapter.log.starts.length, 0);
  });
}
for (const name of pin.forbiddenAuthEnv) {
  test(`S1-b2a async settings ${name} refuses spawn and stores paths only in events`, async t => {
    const good = fixture(t);
    assert.equal((await start(good)).state, 'done');
    const f = fixture(t, { checkSettings: async () => ({ ...settings(),
      effective: { env: { [name]: 'SECRET-SETTING-VALUE' } },
      provenance: { env: { [name]: { path: '/private/source/settings.json', value: 'SECRET-SETTING-VALUE' } } }
    }) });
    const result = await start(f);
    assert.equal(result.state, 'failed');
    assert.equal(result.reason, 'settings_rejected');
    assert.equal(f.adapter.log.starts.length, 0);
    assert.equal(JSON.stringify(result).includes('/private/source'), false);
    assert.equal(JSON.stringify(f.state()).includes('/private/source'), false);
    const events = JSON.stringify(f.core.eventsSince(0));
    assert.equal(events.includes('/private/source/settings.json'), true);
    assert.equal(events.includes('SECRET-SETTING-VALUE'), false);
  });
}

test('S1-b2a absent checkSettings is not an empty settings fallback', async t => {
  const good = fixture(t);
  assert.equal((await start(good)).state, 'done');
  const f = fixture(t);
  delete f.adapter.checkSettings;
  assert.equal((await start(f)).reason, 'settings_check_failed');
  assert.equal(f.state().incarnations[0].state, 'never_started');
  assert.equal(f.adapter.log.starts.length, 0);
});

test('S1-b2a resume rechecks settings before second spawn and keeps stable reservation', async t => {
  const f = fixture(t);
  await start(f);
  assert.equal(f.core.submit(f.req('stop')).state, 'done');
  f.adapter.options.settings = false;
  const request = f.req('resume');
  const accepted = f.core.submit(request);
  assert.equal(accepted.stage, 'settings_checking');
  assert.equal(f.core.submit(request).incarnation_id, accepted.incarnation_id);
  await f.settle();
  assert.equal(f.core.lookup(request.request_key).reason, 'settings_rejected');
  assert.equal(f.adapter.log.starts.length, 1);
  assert.equal(f.state().incarnations[1].state, 'never_started');
  f.adapter.options.settings = true;
  const retry = f.core.submit(f.req('resume'));
  await f.settle();
  assert.equal(f.core.lookup(retry.request_key).state, 'done');
  assert.equal(f.adapter.log.starts.length, 2);
});

test('S1-b2a initialization_failed ignores freeform code and follows cleanup', async t => {
  const good = fixture(t);
  assert.equal((await start(good)).state, 'done');
  const f = fixture(t, { noInitialization: true });
  const accepted = await start(f);
  f.adapter.emit(f.iid, 'initialization_failed', { code: '/private/SECRET' });
  assert.equal(f.core.lookup(accepted.request_key).reason, 'initialization_failed');
  assert.equal(f.adapter.log.closes.length, 1);
  assert.equal(f.state().incarnations[0].state, 'exited');
  assert.equal(JSON.stringify(f.core.eventsSince(0)).includes('/private/SECRET'), false);
});

test('S1-b2a delayed initialization passes before deadline and fails at deadline without tick', async t => {
  const good = fixture(t, { noInitialization: true });
  const acceptedGood = await start(good);
  assert.equal(good.core.idle(good.sid), false);
  good.advance(pin.initializationDeadlineMs - 1);
  good.adapter.emit(good.iid, 'initialization', { initialization: initialization(good) });
  assert.equal(good.core.lookup(acceptedGood.request_key).state, 'done');
  const f = fixture(t, { noInitialization: true });
  const accepted = await start(f);
  f.advance(pin.initializationDeadlineMs);
  f.adapter.emit(f.iid, 'initialization', { initialization: initialization(f) });
  assert.equal(f.core.lookup(accepted.request_key).reason, 'initialization_timeout');
  assert.equal(f.adapter.log.closes.length, 1);
});

for (const mode of ['exit_on_close', 'exit_after_close', 'exit_on_signal', 'remaining_descendant', 'query_failed']) {
  test(`S1-b2a async cleanup ${mode} records exact close signal marker sequence`, async t => {
    const f = fixture(t, { noInitialization: true, noExit: mode !== 'exit_on_close' });
    const accepted = await start(f);
    const order = [];
    const close = f.adapter.close;
    f.adapter.close = id => { order.push('close'); return close(id); };
    const verify = f.probe.verifyThenSignal.bind(f.probe);
    f.probe.verifyThenSignal = (...args) => {
      order.push('verifyThenSignal');
      const result = verify(...args);
      if (mode === 'exit_on_signal') f.adapter.exit(f.iid);
      return result;
    };
    const descendants = f.probe.listMarkedDescendants;
    f.probe.listMarkedDescendants = id => { order.push('markers'); return descendants(id); };
    if (mode === 'remaining_descendant') f.probe.descendants.set(f.iid, { status: 'ok', pids: [{ pid: 2000, startedAt: 'child' }] });
    if (mode === 'query_failed') f.probe.descendants.set(f.iid, { status: 'query_failed' });
    f.adapter.emit(f.iid, 'initialization', { initialization: initialization(f, { remote_control_auto_enable: true }) });
    if (mode !== 'exit_on_close') {
      assert.deepEqual(order, ['close']);
      f.advance(pin.closeWaitMs - 1); f.core.tick();
      assert.deepEqual(order, ['close']);
      if (mode === 'exit_after_close') f.adapter.exit(f.iid);
      else {
        f.advance(1); f.core.tick();
        if (mode !== 'exit_on_signal') {
          assert.deepEqual(order, ['close', 'verifyThenSignal']);
          f.adapter.exit(f.iid);
        }
      }
    }
    assert.deepEqual(order, mode.startsWith('exit_') && mode !== 'exit_on_signal' ? ['close', 'markers'] : ['close', 'verifyThenSignal', 'markers']);
    const verified = mode.startsWith('exit_');
    assert.equal(f.core.lookup(accepted.request_key).reason, verified ? 'gate_rejected_cleaned' : 'gate_rejected_unverified');
    assert.equal(f.state().incarnations[0].state, verified ? 'exited' : 'liveness_unknown');
    assert.equal(f.core.eventsSince(0).events.filter(event => event.type === 'gate_rejected').length, 1);
  });
}

for (const stage of ['settings_checking', 'gating']) {
  for (const verdict of stage === 'gating' ? ['match', 'mismatch_confirmed', 'query_failed'] : ['never_started']) {
    test(`S1-b2a async crash ${stage} recovery ${verdict} preserves reservation and refuses prompt`, async t => {
      const good = fixture(t);
      assert.equal((await start(good)).state, 'done');
      const f = fixture(t, { noInitialization: stage === 'gating' });
      const request = { request_key: f.key(), kind: 'start', cwd: '/work' };
      f.faults.arm(`after_${stage}`);
      await assert.rejects(async () => { f.core.submit(request); await f.settle(); }, SimulatedCrash);
      const accepted = f.core.lookup(request.request_key);
      f.sid = accepted.session_id;
      f.iid = accepted.incarnation_id;
      if (stage === 'gating') {
        const incarnation = f.state().incarnations[0];
        f.probe.checks.set(`${incarnation.pid}:${incarnation.pid_started_at}`, verdict);
      } else {
        f.probe.findMarked = () => { throw new Error('must not probe a known pre-spawn reservation'); };
      }
      const count = f.adapter.log.starts.length;
      f.reboot().recover();
      const result = f.core.submit(request);
      assert.equal(result.session_id, accepted.session_id);
      assert.equal(result.incarnation_id, accepted.incarnation_id);
      assert.equal(result.state, ['never_started', 'mismatch_confirmed'].includes(verdict) ? 'failed' : 'blocked');
      assert.equal(result.reason, verdict === 'never_started' ? 'not_started' : verdict === 'mismatch_confirmed' ? 'exited_before_confirm' : 'control_lost');
      const state = verdict === 'never_started' ? 'never_started' : verdict === 'match' ? 'orphaned' : verdict === 'mismatch_confirmed' ? 'exited' : 'liveness_unknown';
      assert.equal(f.state().incarnations[0].state, state);
      assert.equal(f.prompt().state, 'rejected');
      assert.equal(f.adapter.log.received.length, 0);
      assert.equal(f.adapter.log.starts.length, count);
      assert.equal(f.adapter.log.closes.length, 0);
      assert.equal(f.probe.signals.length, 0);
    });
  }
}

for (const event of ['exit', 'close', 'session_change']) {
  test(`S1-b2a async recheck followed by ${event} cannot send`, async t => {
    const good = fixture(t);
    await start(good); await send(good);
    assert.equal(good.adapter.log.received.length, 1);
    const f = fixture(t);
    await start(f);
    let resolve;
    f.adapter.options.accountInfo = () => new Promise(done => { resolve = done; });
    const delivery = f.prompt();
    await microtasks();
    if (event === 'exit') f.adapter.exit(f.iid);
    else if (event === 'close') f.core.submit(f.req('close'));
    else {
      const database = new Database(f.dbPath);
      database.prepare("UPDATE owned_sessions SET state='closed' WHERE id=?").run(f.sid);
      database.close();
    }
    resolve(account());
    await f.settle();
    assert.ok(['expired', 'rejected'].includes(f.d(delivery.id).state));
    assert.equal(f.adapter.log.received.length, 0);
  });
}

for (const [field, value] of [['email', 'changed@example.test'], ['organization', 'changed'], ['subscriptionType', 'Claude Pro'], ['apiProvider', 'bedrock'], ['tokenSource', undefined], ['apiKeySource', undefined]]) {
  test(`S1-b2a async recheck changed ${field} refuses delivery`, async t => {
    const good = fixture(t);
    await start(good); await send(good);
    assert.equal(good.adapter.log.received.length, 1);
    const f = fixture(t);
    await start(f);
    f.adapter.options.accountInfo = async () => ({ ...account(), [field]: value });
    assert.equal((await send(f)).reason, 'auth_recheck_failed');
    assert.equal(f.adapter.log.received.length, 0);
    assert.equal(f.core.idle(f.sid), true);
  });
}

test('S1-b2a async queued prompts each consume a fresh recheck token only when dequeued', async t => {
  const f = fixture(t, { manual: true });
  await start(f);
  let checks = 0;
  f.adapter.options.accountInfo = async () => { checks++; return account(); };
  const first = f.prompt('first');
  const second = f.prompt('second');
  await f.settle();
  assert.equal(checks, 1);
  assert.equal(f.adapter.log.received.length, 1);
  assert.equal(f.d(second.id).state, 'queued');
  f.adapter.options.accountInfo = async () => { checks++; throw new Error('recheck fails'); };
  f.adapter.emit(f.iid, 'lifecycle', { command_uuid: first.message_uuid, state: 'completed' });
  await f.settle();
  assert.equal(checks, 2);
  assert.equal(f.d(second.id).reason, 'auth_recheck_failed');
  assert.equal(f.adapter.log.received.length, 1);
});

test('S1-b2a async account snapshot is detached and contains only decision fields', async t => {
  const shared = account();
  const f = fixture(t, { account: shared });
  await start(f);
  assert.deepEqual(JSON.parse(f.state().incarnations[0].account_snapshot), {
    subscriptionType: 'Claude Max', apiProvider: 'firstParty'
  });
  shared.email = 'mutated@example.test';
  assert.equal((await send(f)).reason, 'auth_recheck_failed');
  assert.equal(f.adapter.log.received.length, 0);
  const database = new Database(f.dbPath);
  const stored = database.prepare("SELECT json FROM events UNION ALL SELECT account_snapshot AS json FROM incarnations").all();
  database.close();
  assert.equal(JSON.stringify(stored).includes('fake@example.test'), false);
  assert.equal(JSON.stringify(stored).includes('mutated@example.test'), false);
});

for (const async of [false, true]) {
  test(`S1-b2a async=${async} exit during spawn cannot turn initialization into done`, async t => {
    const good = baseFixture(t, { async });
    assert.equal((await start(good)).state, 'done');
    const f = baseFixture(t, { async });
    const spawn = f.adapter.start;
    f.adapter.start = request => {
      const identity = spawn(request);
      f.adapter.exit(request.incarnation_id);
      return identity;
    };
    const result = await start(f);
    assert.equal(result.state, 'failed');
    assert.equal(result.reason, 'initialization_failed');
    assert.equal(f.state().incarnations[0].state, 'exited');
    assert.equal(f.prompt().state, 'rejected');
    assert.equal(f.adapter.log.received.length, 0);
  });
  test(`S1-b2a async=${async} settings and account synchronous throw fail closed`, async t => {
    const good = baseFixture(t, { async });
    assert.equal((await start(good)).state, 'done');
    await send(good);
    assert.equal(good.adapter.log.received.length, 1);
    const f = baseFixture(t, { async });
    f.adapter.checkSettings = () => { throw new Error('PRIVATE'); };
    assert.equal((await start(f)).reason, 'settings_check_failed');
    assert.equal(f.adapter.log.starts.length, 0);
    const g = baseFixture(t, { async });
    await start(g);
    g.adapter.accountInfo = () => { throw new Error('PRIVATE'); };
    assert.equal((await send(g)).reason, 'auth_recheck_failed');
    assert.equal(g.adapter.log.received.length, 0);
  });
}

test('S1-b2a non-native thenables use checked settings once and recheck each delivery', async t => {
  const f = fixture(t);
  let checks = 0;
  f.adapter.checkSettings = cwd => {
    assert.equal(cwd, '/private/work');
    checks++;
    return { then(resolve) { queueMicrotask(() => resolve(settings())); } };
  };
  assert.equal((await start(f)).state, 'done');
  assert.equal(checks, 1);
  let rechecks = 0;
  f.adapter.accountInfo = id => ({ then(resolve) {
    assert.equal(id, f.iid); rechecks++; queueMicrotask(() => resolve(account()));
  } });
  await send(f); await send(f);
  assert.equal(rechecks, 2);
  assert.equal(f.adapter.log.received.length, 2);
});

test('S1-b2a timeout with no exit signals once and ignores late passing initialization', async t => {
  const good = fixture(t, { noInitialization: true });
  const valid = await start(good);
  good.adapter.emit(good.iid, 'initialization', { initialization: initialization(good) });
  assert.equal(good.core.lookup(valid.request_key).state, 'done');
  const f = fixture(t, { noInitialization: true, noExit: true });
  const request = await start(f);
  f.advance(pin.initializationDeadlineMs); f.core.tick();
  assert.equal(f.adapter.log.closes.length, 1);
  f.adapter.emit(f.iid, 'initialization', { initialization: initialization(f) });
  assert.equal(f.core.lookup(request.request_key).state, 'accepted');
  assert.equal(f.core.idle(f.sid), false);
  f.advance(pin.closeWaitMs); f.core.tick();
  assert.equal(f.probe.signals.length, 1);
  f.advance(pin.sigtermWaitMs); f.core.tick();
  assert.equal(f.core.lookup(request.request_key).reason, 'gate_rejected_unverified');
  f.core.tick();
  assert.equal(f.adapter.log.closes.length, 1);
  assert.equal(f.probe.signals.length, 1);
});

for (const apiKeySource of ['ANTHROPIC_API_KEY', '', null, undefined]) {
  test(`S1-b2a async system init source ${String(apiKeySource)} faults even without lifecycle`, async t => {
    const good = fixture(t, { omitLifecycle: true });
    await start(good); await send(good);
    assert.equal(good.adapter.log.closes.length, 0);
    const f = fixture(t, { apiKeySource, omitLifecycle: true });
    await start(f);
    const delivery = await send(f);
    assert.equal(delivery.outcome, 'errored');
    assert.equal(delivery.reason, 'auth_source_not_subscription');
    assert.equal(f.state().controls.find(control => control.kind === 'close').reason, 'auth_source_not_subscription');
    assert.equal(f.adapter.log.closes.length, 1);
    assert.equal(f.state().session.state, 'closed');
    f.prompt();
    assert.equal(f.adapter.log.received.length, 1);
  });
}

for (const invalid of [null, undefined, [], { ...account(), subscriptionType: 'unknown' }, { ...account(), extra: true }]) {
  test(`S1-b2a async unknown account ${JSON.stringify(invalid)} fails initialization`, async t => {
    const good = fixture(t);
    assert.equal((await start(good)).state, 'done');
    const f = fixture(t, { account: invalid });
    const result = await start(f);
    assert.equal(result.state, 'failed');
    assert.equal(result.reason, 'gate_rejected_cleaned');
    assert.equal(f.adapter.log.closes.length, 1);
    assert.equal(f.adapter.log.received.length, 0);
  });
}

test('S1-b2a async latest rate limit replaces prior value per incarnation', async t => {
  const f = fixture(t);
  await start(f);
  const first = { status: 'allowed', isUsingOverage: false };
  const second = { status: 'rejected', resetsAt: 999, rateLimitType: 'seven_day', overageStatus: 'disabled', overageDisabledReason: 'limit', isUsingOverage: true };
  f.adapter.emit(f.iid, 'rate_limit', { rate_limit_info: first });
  f.adapter.emit(f.iid, 'rate_limit', { rate_limit_info: second });
  assert.deepEqual(f.state().incarnations[0].rate_limit_info, second);
  assert.equal(f.core.eventsSince(0).events.filter(event => event.type === 'rate_limit').length, 2);
  f.core.submit(f.req('stop'));
  const resumed = f.core.submit(f.req('resume'));
  await f.settle();
  assert.equal(f.core.lookup(resumed.request_key).state, 'done');
  assert.deepEqual(f.state().incarnations[0].rate_limit_info, second);
  assert.equal(f.state().incarnations[1].rate_limit_info, null);
});
