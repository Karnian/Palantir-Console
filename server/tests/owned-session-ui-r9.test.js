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

test('R9 retry replays an unaccepted interrupt unchanged after the turn becomes idle', async t => {
  let idle = false;
  const posts = [];
  const environment = await harness(t, { api: async (url, options) => {
    if (options?.method) {
      posts.push({ url, body: JSON.parse(options.body) });
      return posts.length === 1 ? { acceptance: 'acceptance_unknown' }
        : { acceptance: 'accepted', result: { state: 'completed' } };
    }
    if (url.includes('/requests/')) return { host: 'running', result: { found: false } };
    if (url.includes('transcript')) return { host: 'running', events: [] };
    return { host: 'running', state: snapshot({ deliveries: idle ? []
      : [{ kind: 'prompt', incarnation_id: 'inc', state: 'written' }] }) };
  } });
  await environment.current.submit('interrupt');
  await flushEffects(20);
  idle = true;
  await environment.current.synchronize();
  await flushEffects(20);
  assert.equal(environment.current.interaction, 'idle');
  assert.equal(environment.current.disabled, true);
  await environment.current.retry();
  await flushEffects(20);
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1], posts[0]);
  assert.equal(environment.current.pending, null);
  assert.equal(environment.current.disabled, false);
});

test('R9 confirmed unaccepted request can be discarded only while connected', async t => {
  let posts = 0;
  const environment = await harness(t, { api: async (url, options) => {
    if (url.endsWith('/abandon')) return { host: 'running', abandoned: true };
    if (options?.method) { posts++; return { acceptance: 'acceptance_unknown' }; }
    if (url.includes('/requests/')) return { host: 'running', result: { found: false } };
    if (url.includes('transcript')) return { host: 'running', events: [] };
    return { host: 'running', state: snapshot() };
  } });
  await environment.current.submit('prompt', { body: 'discard this private text' });
  await flushEffects(20);
  assert.equal(environment.current.disabled, true);
  await environment.current.submit('close');
  assert.equal(posts, 1);
  assert.equal(environment.current.canDiscardPending, false);
  await environment.current.checkPending();
  await flushEffects(20);
  assert.equal(environment.current.canDiscardPending, true);
  environment.stream().emit('error');
  await flushEffects(20);
  assert.equal(environment.current.canDiscardPending, false);
  await environment.current.discardPending();
  assert.ok(environment.current.pending);
  await environment.current.retry();
  assert.equal(posts, 1);
  environment.stream().emit('open');
  await flushEffects(70);
  await environment.current.checkPending();
  await flushEffects(20);
  await environment.current.discardPending();
  await flushEffects(20);
  assert.equal(environment.current.pending, null);
  assert.equal(environment.current.disabled, false);
  assert.equal(environment.context.sessionStorage.getItem('palantir.owned.pending.v1').includes('private text'), false);
  await environment.current.retry();
  assert.equal(posts, 1);
  await environment.current.submit('close');
  assert.equal(posts, 2);
});

test('R9 recovered prompt keeps its old incarnation and body for host rejection', async t => {
  let changed = false;
  const posts = [];
  const environment = await harness(t, { api: async (url, options) => {
    if (options?.method) {
      posts.push(JSON.parse(options.body));
      return posts.length === 1 ? { acceptance: 'acceptance_unknown' }
        : { acceptance: 'rejected', result: { state: 'rejected', reason: 'incarnation_mismatch' } };
    }
    if (url.includes('/requests/')) return { host: 'running', result: { found: false } };
    if (url.includes('transcript')) return { host: 'running', events: [] };
    return { host: 'running', state: changed ? snapshot({ current_incarnation_id: 'replacement',
      incarnations: [{ id: 'replacement', state: 'alive', control_available: true, attribution_uncertain: true }]
    }) : snapshot() };
  } });
  await environment.current.submit('prompt', { body: 'original\nrequest' });
  await flushEffects(20);
  changed = true;
  await environment.current.synchronize();
  await flushEffects(20);
  assert.equal(environment.current.interaction, 'unknown');
  await environment.current.retry();
  await flushEffects(20);
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1], posts[0]);
  assert.equal(posts[1].incarnation_id, 'inc');
  assert.equal(environment.current.pending, null);
});

test('R9 another uncertain POST invalidates an earlier read-only miss before discard', async t => {
  let posts = 0;
  const environment = await harness(t, { api: async (url, options) => {
    if (options?.method) { posts++; return { acceptance: 'acceptance_unknown' }; }
    if (url.includes('/requests/')) return { host: 'running', result: { found: false } };
    if (url.includes('transcript')) return { host: 'running', events: [] };
    return { host: 'running', state: snapshot() };
  } });
  await environment.current.submit('prompt', { body: 'retained request' });
  await flushEffects(20);
  await environment.current.checkPending();
  await flushEffects(20);
  assert.equal(environment.current.canDiscardPending, true);
  await environment.current.retry();
  await flushEffects(20);
  assert.equal(posts, 2);
  assert.equal(environment.current.canDiscardPending, false);
  environment.current.discardPending();
  assert.ok(environment.current.pending);
});
