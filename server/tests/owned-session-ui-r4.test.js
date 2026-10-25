'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createPreactEnv, flushEffects } = require('./helpers/jsdom-preact');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
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
  function Probe() {
    environment.current = environment.context.useOwnedSessions(options.sessionId === null ? null : 's');
    return null;
  }
  const root = environment.document.getElementById('root');
  environment.remount = async () => {
    environment.render(null, root);
    await flushEffects(30);
    environment.render(environment.h(Probe), root);
    await flushEffects(80);
  };
  environment.render(environment.h(Probe), root);
  await flushEffects(100);
  environment.stream = () => streams.at(-1);
  return environment;
}

test('R4 SSE loss cancels queued refresh and HTTP success cannot unlock commands', async t => {
  const environment = await harness(t);
  assert.equal(environment.current.disabled, false);
  environment.stream().emit('event', { seq: 2, type: 'transition', session_id: 's' });
  environment.stream().emit('error');
  await flushEffects(180);
  assert.equal(environment.current.disabled, true);
  assert.equal(environment.current.host, 'unreachable');
});

test('R4 lookup completing after SSE loss must not replay a POST', async t => {
  const lookup = deferred();
  let posts = 0;
  const environment = await harness(t, { api: async (url, options) => {
    if (options?.method) { posts++; return { acceptance: 'acceptance_unknown' }; }
    if (url.includes('/requests/')) return lookup.promise;
    return url.includes('transcript') ? { host: 'running', events: [] }
      : { host: 'running', seq_high: 1, state: snapshot() };
  } });
  await environment.current.execute('/api/owned-sessions/s/interrupt', { incarnation_id: 'inc' });
  await flushEffects(30);
  const retry = environment.current.retry();
  environment.stream().emit('error');
  lookup.resolve({ host: 'running', result: { found: false } });
  await retry;
  assert.equal(posts, 1);
});

test('R4 unresolved start survives a route unmount and blocks a new start key', async t => {
  let posts = 0;
  const environment = await harness(t, { sessionId: null, api: async (url, options) => {
    if (options?.method) { posts++; return { acceptance: 'acceptance_unknown' }; }
    return { host: 'running', sessions: [], seq_high: 1 };
  } });
  await environment.current.execute('/api/owned-sessions/start', { cwd: '/safe', confirmed_settings: true });
  await flushEffects(30);
  const key = environment.current.pending.body.request_key;
  await environment.remount();
  assert.equal(environment.current.pending?.body.request_key, key);
  await environment.current.execute('/api/owned-sessions/start', { cwd: '/safe', confirmed_settings: true });
  assert.equal(posts, 1);
});

test('R4 interrupt-send joins an existing interrupt delivery by accepted id', async t => {
  let settled = false;
  const posts = [];
  const environment = await harness(t, { api: async (url, options) => {
    if (options?.method) {
      posts.push(url);
      return { acceptance: 'accepted', result: { id: 'existing-interrupt', state: 'written' } };
    }
    if (url.includes('transcript')) return { host: 'running', events: [] };
    const deliveries = [{ id: 'existing-interrupt', incarnation_id: 'inc', request_key: 'original-key',
      kind: 'interrupt', state: settled ? 'completed' : 'written' }];
    if (!settled) deliveries.push({ id: 'running-prompt', incarnation_id: 'inc', kind: 'prompt', state: 'written', outcome: null });
    return { host: 'running', seq_high: 1, state: snapshot({ deliveries }) };
  } });
  await environment.current.submit('interrupt-send', { body: 'next prompt' });
  await flushEffects(30);
  settled = true;
  environment.stream().emit('event', { seq: 2, type: 'transition', session_id: 's' });
  await flushEffects(220);
  assert.equal(posts.filter(url => url.endsWith('/prompt')).length, 1);
});

test('R4 resend rejects uncertain attribution and unknown interrupt in the current incarnation', async t => {
  const environment = await harness(t);
  for (const field of ['attribution_uncertain', 'interrupt_unknown']) {
    const state = snapshot();
    state.incarnations[0][field] = 1;
    state.incarnations.push({ id: 'old', state: 'exited' });
    assert.equal(environment.context.canResendOwnedPrompt(state, { incarnation_id: 'old' }), false, field);
  }
});

test('R4 late transcript cannot reinsert content after a deletion snapshot', async t => {
  const history = deferred();
  let deleted = false;
  const environment = await harness(t, { api: async url => {
    if (url.includes('before_seq=')) return history.promise;
    if (url.includes('transcript')) return { host: 'running', events: [], next_before_seq: 10 };
    return { host: 'running', seq_high: 1, state: snapshot({ session: { id: 's', state: deleted ? 'deleted' : 'active' } }) };
  } });
  const reading = environment.current.history();
  deleted = true;
  environment.stream().emit('event', { seq: 2, type: 'transition', session_id: 's', json: { table: 'owned_sessions', state: 'deleted' } });
  await flushEffects(180);
  history.resolve({ host: 'running', events: [{ seq: 3, json: { secret: 'deleted text' } }], next_before_seq: null });
  await reading;
  await flushEffects(30);
  assert.equal(environment.current.events.length, 0);
});


test('R4 reconnection stays locked until the new generation snapshot arrives', async t => {
  const synchronization = deferred();
  let reconnecting = false;
  const environment = await harness(t, { api: async url => {
    if (url.includes('transcript')) return { host: 'running', events: [] };
    if (reconnecting) return synchronization.promise;
    return { host: 'running', seq_high: 1, state: snapshot() };
  } });
  environment.stream().emit('error');
  reconnecting = true;
  environment.stream().emit('open');
  await flushEffects(30);
  assert.equal(environment.current.disabled, true);
  synchronization.resolve({ host: 'running', seq_high: 2, state: snapshot() });
  await flushEffects(60);
  assert.equal(environment.current.disabled, false);
});

test('R4 storage failure warns and retains the same request in memory across remounts', async t => {
  const environment = await harness(t, { storageFailure: true, api: async (url, options) => {
    if (options?.method) return { acceptance: 'acceptance_unknown' };
    if (url.includes('transcript')) return { host: 'running', events: [] };
    return { host: 'running', seq_high: 1, state: snapshot() };
  } });
  await environment.current.execute('/api/owned-sessions/s/interrupt', { incarnation_id: 'inc' });
  await flushEffects(30);
  const key = environment.current.pending.body.request_key;
  assert.equal(environment.current.storageWarning, 'pendingStorageWarning');
  await environment.remount();
  assert.equal(environment.current.pending.body.request_key, key);
});

test('R4 definitive lookup clears the retained request without another POST', async t => {
  let posts = 0;
  const environment = await harness(t, { api: async (url, options) => {
    if (options?.method) { posts++; return { acceptance: 'acceptance_unknown' }; }
    if (url.includes('/requests/')) return { host: 'running', result: { id: 'delivery', state: 'written' } };
    if (url.includes('transcript')) return { host: 'running', events: [] };
    return { host: 'running', seq_high: 1, state: snapshot() };
  } });
  await environment.current.execute('/api/owned-sessions/s/interrupt', { incarnation_id: 'inc' });
  await flushEffects(30);
  await environment.current.retry();
  await flushEffects(30);
  assert.equal(posts, 1);
  assert.equal(environment.current.pending, null);
  await environment.remount();
  assert.equal(environment.current.pending, null);
});

test('R4 in-flight start intent survives navigation before the response resolves', async t => {
  const response = deferred();
  const environment = await harness(t, { sessionId: null, api: async (url, options) => {
    if (options?.method) return response.promise;
    return { host: 'running', sessions: [], seq_high: 1 };
  } });
  const executing = environment.current.execute('/api/owned-sessions/start', { cwd: '/safe', confirmed_settings: true });
  await flushEffects(20);
  const key = environment.current.pending.body.request_key;
  await environment.remount();
  assert.equal(environment.current.pending.body.request_key, key);
  response.resolve({ acceptance: 'accepted', result: { state: 'done', session_id: 'new-session' } });
  await executing;
  await flushEffects(30);
  assert.equal(environment.current.pending, null);
});
