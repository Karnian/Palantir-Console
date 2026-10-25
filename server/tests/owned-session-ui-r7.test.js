'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createPreactEnv, flushEffects } = require('./helpers/jsdom-preact');

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function snapshot(extra = {}) {
  return { session: { id: 's', cwd: '/safe', state: 'active' }, current_incarnation_id: 'inc',
    incarnations: [{ id: 'inc', state: 'alive', control_available: true }],
    deliveries: [], controls: [], tool_requests: [], ...extra };
}
async function harness(t, options = {}) {
  const environment = createPreactEnv();
  t.after(environment.cleanup);
  const streams = [];
  environment.context.EventSource = class {
    constructor() {
      this.listeners = {};
      streams.push(this);
      setTimeout(() => this.emit('open'), 0);
    }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    emit(name, data) { this.listeners[name]?.({ data: JSON.stringify(data) }); }
    close() {}
  };
  if (options.storageFailure) {
    Object.defineProperty(environment.context, 'sessionStorage', { get() { throw new Error('storage disabled'); } });
  }
  environment.context.apiFetch = options.api || (async url => url.includes('transcript')
    ? { host: 'running', events: [], next_before_seq: null }
    : { host: 'running', seq_high: 1, state: snapshot(), sessions: [] });
  for (const name of ['format', 'state', 'client', 'pending', 'useOwnedSessions']) {
    if (fs.existsSync(path.join(__dirname, '../public/app/components/owned', name + '.js'))) {
      environment.loadComponent('owned/' + name);
    }
  }
  let routeId = options.sessionId ?? 'A';
  function Probe() {
    environment.current = environment.context.useOwnedSessions(routeId, { retryMs: 20 });
    return null;
  }
  const root = environment.document.getElementById('root');
  environment.remount = async (id = routeId) => {
    routeId = id;
    environment.render(null, root);
    await flushEffects(30);
    if (options.refreshMemory) environment.loadComponent('owned/pending');
    environment.render(environment.h(Probe), root);
    await flushEffects(80);
  };
  environment.render(environment.h(Probe), root);
  await flushEffects(100);
  environment.stream = () => streams.at(-1);
  return environment;
}

test('R7 idle cannot submit either interrupt entry point', async t => {
  let posts = 0;
  const environment = await harness(t, { api: async (url, options) => {
    if (options?.method) { posts++; return { acceptance: 'accepted' }; }
    if (url.includes('transcript')) return { host: 'running', events: [] };
    return { host: 'running', state: snapshot(), sessions: [] };
  } });
  await environment.current.submit('interrupt');
  await environment.current.submit('interrupt-send', { body: 'draft' });
  assert.equal(posts, 0);
});

test('R7 receipt for a finished target turn cannot lock the next prompt', async t => {
  const environment = await harness(t);
  const current = snapshot();
  current.deliveries.push(
    { kind: 'prompt', incarnation_id: 'inc', turn_gen: 1, state: 'completed', outcome: 'completed', result_json: '{}' },
    { kind: 'interrupt', incarnation_id: 'inc', turn_gen: 1, state: 'provider_observed' }
  );
  assert.equal(environment.context.canSubmitOwnedPrompt(current, true), true);
  current.deliveries[0].result_json = null;
  assert.equal(environment.context.canSubmitOwnedPrompt(current, true), false);
  current.deliveries = [{ kind: 'interrupt', incarnation_id: 'inc', turn_gen: 0, state: 'provider_observed' }];
  assert.equal(environment.context.canSubmitOwnedPrompt(current, true), true);
});

for (const deletion of ['absent', 'deleting', 'deleted', '404']) {
  test('R7 reconnect scrubs a missing pending target: ' + deletion, async t => {
  let missing = false, lookups = 0, targetReads = 0;
  const environment = await harness(t, { api: async (url, options) => {
    if (options?.method) return { acceptance: 'acceptance_unknown' };
    if (url.includes('/requests/')) { lookups++; return { host: 'running', result: { session_deleted: true } }; }
    if (url.includes('transcript')) return { host: 'running', events: [] };
    if (url === '/api/owned-sessions') return { host: 'running', sessions: missing ? [] : [{ id: 'A', state: 'active' }] };
    if (missing && url === '/api/owned-sessions/A') {
      targetReads++;
      if (deletion === '404') throw Object.assign(new Error('not_found'), { status: 404 });
      return { host: 'running', state: snapshot({
        session: deletion === 'absent' ? null : { id: 'A', state: deletion }
      }) };
    }
    return { host: 'running', state: snapshot() };
  } });
  await environment.current.submit('prompt', { body: 'missed deletion private body' });
  await environment.remount('B');
  assert.equal(environment.current.otherPending.session_id, 'A');
  environment.stream().emit('error');
  missing = true;
  environment.stream().emit('open');
  await flushEffects(100);
  assert.equal(targetReads, 1);
  assert.equal(lookups, 1);
  assert.equal(environment.current.otherPending, null);
  assert.equal(environment.context.sessionStorage.getItem('palantir.owned.pending.v1').includes('private body'), false);
});
}

test('R7 deletion immediately scrubs snapshot originals even when refresh fails', async t => {
  let fail = false;
  const environment = await harness(t, { api: async url => {
    if (fail) throw Object.assign(new Error('snapshot_too_large'), { status: 413 });
    if (url.includes('transcript')) return { host: 'running', events: [{ seq: 1, json: { text: 'private transcript' } }] };
    return { host: 'running', state: snapshot({
      deliveries: [{ kind: 'prompt', body: 'private prompt' }],
      tool_requests: [{ input: 'private tool input' }]
    }) };
  } });
  fail = true;
  environment.stream().emit('event', {
    seq: 2, type: 'transition', session_id: 'A', json: { table: 'owned_sessions', state: 'deleted' }
  });
  await flushEffects(150);
  assert.equal(environment.current.snapshot.session.state, 'deleted');
  assert.equal(JSON.stringify(environment.current.snapshot).includes('private'), false);
  assert.equal(environment.current.events.length, 0);
});

const { fixture } = require('./helpers/session-host-fixture');

test('R7 host accepts the next prompt after an interrupt races an already finished turn', t => {
  const f = fixture(t, { manual: true });
  f.start();
  const prompt = f.prompt();
  f.adapter.emit(f.iid, 'result', { user_message_uuids: [prompt.message_uuid], is_error: false });
  f.adapter.emit(f.iid, 'lifecycle', { command_uuid: prompt.message_uuid, state: 'completed' });
  assert.equal(f.core.idle(f.sid), true);
  const interrupt = f.core.submit(f.req('interrupt'));
  assert.equal(interrupt.state, 'provider_observed');
  assert.equal(f.d(interrupt.id).turn_gen, f.d(prompt.id).turn_gen);
  assert.ok(f.d(prompt.id).result_json);
  const next = f.prompt('explicit next prompt');
  assert.notEqual(next.state, 'rejected');
  assert.equal(f.adapter.log.received.length, 2);
});

test('R7 interrupt selector allows only a running turn or pending interaction', async t => {
  const environment = await harness(t);
  const current = snapshot();
  const canInterrupt = environment.context.canInterruptOwnedSession;
  assert.equal(canInterrupt(current, true), false);
  current.deliveries.push({ kind: 'prompt', incarnation_id: 'inc', state: 'written' });
  assert.equal(canInterrupt(current, true), true);
  assert.equal(canInterrupt(current, false), false);
  current.deliveries = [];
  for (const tool of ['Read', 'AskUserQuestion']) {
    current.tool_requests = [{ incarnation_id: 'inc', state: 'pending', tool_name: tool }];
    assert.equal(canInterrupt(current, true), true);
  }
  current.incarnations[0].interrupt_unknown = true;
  assert.equal(canInterrupt(current, true), false);
});
