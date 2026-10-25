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

test('R6 interrupt completion never submits a prompt automatically', async t => {
  let settled = false;
  const posts = [];
  const environment = await harness(t, { api: async (url, options) => {
    if (options?.method) {
      posts.push(url);
      settled = true;
      return { acceptance: 'accepted', result: { id: 'interrupt', state: 'completed' } };
    }
    if (url.includes('transcript')) return { host: 'running', events: [] };
    const state = snapshot();
    if (settled) state.deliveries.push({ id: 'interrupt', incarnation_id: 'inc', kind: 'interrupt', state: 'completed' });
    else state.deliveries.push({ incarnation_id: 'inc', kind: 'prompt', state: 'written', outcome: null });
    return { host: 'running', seq_high: 1, state };
  } });
  await environment.current.submit('interrupt-send', { body: 'keep this draft' });
  await flushEffects(100);
  assert.equal(posts.filter(url => url.endsWith('/interrupt')).length, 1);
  assert.equal(posts.filter(url => url.endsWith('/prompt')).length, 0);
});

test('R6 stop completion never resumes automatically', async t => {
  let stopped = false, stopKey;
  const posts = [];
  const environment = await harness(t, { api: async (url, options) => {
    if (options?.method) {
      posts.push(url);
      stopped = true;
      stopKey = JSON.parse(options.body).request_key;
      return { acceptance: 'accepted', result: { state: 'done' } };
    }
    if (url.includes('transcript')) return { host: 'running', events: [] };
    const state = snapshot();
    if (stopped) {
      state.incarnations[0].state = 'exited';
      state.controls.push({ kind: 'stop', incarnation_id: 'inc', request_key: stopKey, state: 'done' });
    }
    return { host: 'running', seq_high: 1, state };
  } });
  await environment.current.submit('restart');
  await flushEffects(100);
  assert.equal(posts.filter(url => url.endsWith('/stop')).length, 1);
  assert.equal(posts.filter(url => url.endsWith('/resume')).length, 0);
  assert.equal(environment.current.resumeReady, true);
});

test('R6 deleting a session looks up once and scrubs its preserved request regardless of result', async t => {
  let lookups = 0;
  const environment = await harness(t, { api: async (url, options) => {
    if (options?.method) return { acceptance: 'acceptance_unknown' };
    if (url.includes('/requests/')) { lookups++; throw new Error('lookup unavailable'); }
    if (url.includes('transcript')) return { host: 'running', events: [] };
    return { host: 'running', seq_high: 1, state: snapshot() };
  } });
  await environment.current.submit('prompt', { body: 'deleted private body' });
  await flushEffects(20);
  environment.stream().emit('event', {
    seq: 2, type: 'transition', session_id: 'A', json: { table: 'owned_sessions', state: 'deleted' }
  });
  await flushEffects(60);
  assert.equal(lookups, 1);
  assert.equal(environment.current.pending, null);
  assert.equal(environment.context.sessionStorage.getItem('palantir.owned.pending.v1').includes('deleted private body'), false);
});

test('R6 snapshot 413 exposes the cause and stops automatic requests until a human retries', async t => {
  let oversized = false, failedReads = 0;
  const environment = await harness(t, { api: async url => {
    if (url.includes('transcript')) return { host: 'running', events: [] };
    if (oversized) { failedReads++; throw Object.assign(new Error('snapshot_too_large'), { status: 413 }); }
    return { host: 'running', seq_high: 1, state: snapshot() };
  } });
  oversized = true;
  environment.stream().emit('event', { seq: 2, type: 'transition', session_id: 'A' });
  await flushEffects(220);
  assert.equal(failedReads, 1);
  assert.match(environment.current.notice, /snapshot_too_large/);
  assert.equal(environment.current.disabled, true);
  await environment.current.synchronize();
  assert.equal(failedReads, 2);
  await flushEffects(70);
  assert.equal(failedReads, 2);
});

test('R6 legacy composite data is removed without generating any successor request', async t => {
  const environment = await harness(t);
  const key = 'palantir.owned.pending.v1';
  environment.context.sessionStorage.setItem(key, JSON.stringify({ version: 2, requests: {}, followUps: {
    A: { kind: 'prompt', status: 'waiting', body: { body: 'obsolete successor private text' } }
  } }));
  environment.context.loadOwnedPending('A');
  const stored = JSON.parse(environment.context.sessionStorage.getItem(key));
  assert.equal(stored.version, 3);
  assert.deepEqual(Object.keys(stored).sort(), ['requests', 'version']);
  assert.deepEqual(stored.requests, {});
  assert.equal(JSON.stringify(stored).includes('obsolete successor private text'), false);
});

test('R6 deletion while viewing B clears A and its link without locking B', async t => {
  let lookups = 0;
  const environment = await harness(t, { api: async (url, options) => {
    if (options?.method) return { acceptance: 'acceptance_unknown' };
    if (url.includes('/requests/')) { lookups++; return { host: 'unreachable' }; }
    if (url.includes('transcript')) return { host: 'running', events: [] };
    return { host: 'running', seq_high: 1, state: snapshot() };
  } });
  await environment.current.submit('prompt', { body: 'A deleted source text' });
  await environment.remount('B');
  assert.equal(environment.current.otherPending.session_id, 'A');
  environment.stream().emit('event', {
    seq: 2, session_id: 'A', type: 'transition', json: { table: 'owned_sessions', state: 'deleting' }
  });
  await flushEffects(50);
  assert.equal(lookups, 1);
  assert.equal(environment.current.otherPending, null);
  assert.equal(environment.current.disabled, false);
  assert.equal(environment.context.sessionStorage.getItem('palantir.owned.pending.v1').includes('A deleted source text'), false);
});

test('R6 idle alone cannot authorize a prompt while the interrupt is still unconfirmed', async t => {
  const environment = await harness(t);
  const current = snapshot();
  current.deliveries.push({ kind: 'interrupt', incarnation_id: 'inc', state: 'written' });
  assert.equal(environment.context.canSubmitOwnedPrompt(current, true), false);
  current.deliveries[0].state = 'completed';
  assert.equal(environment.context.canSubmitOwnedPrompt(current, true), true);
});

test('R6 rapid interrupt clicks reserve only one request and never persist the draft as an intent', async t => {
  const response = deferred();
  let posts = 0;
  const environment = await harness(t, { api: async (url, options) => {
    if (options?.method) { posts++; return response.promise; }
    if (url.includes('transcript')) return { host: 'running', events: [] };
    return { host: 'running', seq_high: 1, state: snapshot() };
  } });
  const first = environment.current.submit('interrupt-send', { body: 'first private draft' });
  const second = environment.current.submit('interrupt-send', { body: 'second private draft' });
  assert.equal(posts, 1);
  assert.equal(second, undefined);
  const stored = environment.context.sessionStorage.getItem('palantir.owned.pending.v1');
  assert.equal(stored.includes('private draft'), false);
  response.resolve({ acceptance: 'accepted', result: { id: 'interrupt', state: 'completed' } });
  await first;
});
