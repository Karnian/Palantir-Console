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

test('R5 old snapshot rejection after error-open cannot invalidate the new connection', async t => {
  const old = deferred();
  let hold = false;
  const environment = await harness(t, { api: async url => {
    if (url.includes('transcript')) return { host: 'running', events: [] };
    if (hold) { hold = false; return old.promise; }
    return { host: 'running', seq_high: 1, state: snapshot() };
  } });
  hold = true;
  environment.stream().emit('event', { seq: 2, type: 'transition', session_id: 'A' });
  await flushEffects(120);
  environment.stream().emit('error');
  environment.stream().emit('open');
  old.reject(new Error('old generation failure'));
  await flushEffects(100);
  assert.equal(environment.current.disabled, false);
});

test('R5 HTTP-only failure retries synchronization without another SSE open', async t => {
  let fail = false;
  const environment = await harness(t, { api: async url => {
    if (url.includes('transcript')) return { host: 'running', events: [] };
    if (fail) { fail = false; throw new Error('temporary HTTP failure'); }
    return { host: 'running', seq_high: 1, state: snapshot() };
  } });
  fail = true;
  environment.stream().emit('event', { seq: 2, type: 'transition', session_id: 'A' });
  await flushEffects(250);
  assert.equal(environment.current.disabled, false);
});

test('R5 pending A does not block B and is retried only on A with its original key', async t => {
  const posts = [];
  const environment = await harness(t, { api: async (url, options) => {
    if (options?.method) {
      posts.push({ url, body: JSON.parse(options.body) });
      return { acceptance: url.includes('/A/') ? 'acceptance_unknown' : 'accepted', result: { state: 'written' } };
    }
    if (url.includes('/requests/')) return { host: 'running', result: { found: false } };
    if (url.includes('transcript')) return { host: 'running', events: [] };
    return { host: 'running', seq_high: 1, state: snapshot() };
  } });
  await environment.current.submit('prompt', { body: 'A prompt' });
  await flushEffects(20);
  const key = posts[0].body.request_key;
  await environment.remount('B');
  assert.equal(environment.current.disabled, false);
  assert.equal(environment.current.pending, null);
  assert.equal(environment.current.otherPending.session_id, 'A');
  await environment.current.submit('interrupt');
  await environment.remount('A');
  await environment.current.retry();
  assert.equal(posts.filter(post => post.url.includes('/B/')).length, 1);
  const attempts = posts.filter(post => post.url.includes('/A/'));
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].body.request_key, key);
});

for (const changedIncarnation of [false, true]) {
  test('R5 restored interrupt follow-up is ' + (changedIncarnation ? 'held on incarnation change' : 'consumed exactly once'), async t => {
    let settled = false;
    const posts = [];
    const environment = await harness(t, { refreshMemory: true, api: async (url, options) => {
      if (options?.method) {
        posts.push(url);
        return url.endsWith('/interrupt') ? { acceptance: 'acceptance_unknown' }
          : { acceptance: 'accepted', result: { state: 'written' } };
      }
      if (url.includes('/requests/')) return { host: 'running', result: { id: 'interruption', state: 'completed' } };
      if (url.includes('transcript')) return { host: 'running', events: [] };
      const state = snapshot();
      if (!settled) state.deliveries.push({ kind: 'prompt', incarnation_id: 'inc', state: 'written', outcome: null });
      if (settled) state.deliveries.push({ id: 'interruption', kind: 'interrupt', incarnation_id: 'inc', state: 'completed' });
      if (settled && changedIncarnation) {
        state.current_incarnation_id = 'replacement';
        state.incarnations[0].id = 'replacement';
      }
      return { host: 'running', seq_high: 1, state };
    } });
    await environment.current.submit('interrupt-send', { body: 'follow-up' });
    await environment.remount('B');
    settled = true;
    await environment.remount('A');
    await environment.current.retry();
    await flushEffects(100);
    assert.equal(posts.filter(url => url.endsWith('/prompt')).length, changedIncarnation ? 0 : 1);
    if (changedIncarnation) assert.ok(environment.current.followUpNotice);
    await environment.remount('A');
    await flushEffects(50);
    assert.equal(posts.filter(url => url.endsWith('/prompt')).length, changedIncarnation ? 0 : 1);
    if (changedIncarnation) {
      await environment.current.sendHeldFollowUp();
      await flushEffects(30);
      assert.equal(posts.filter(url => url.endsWith('/prompt')).length, 1);
    }
  });
}


test('R5 stop-response loss restores resume intent after a fresh storage load', async t => {
  let settled = false;
  let stopKey;
  const posts = [];
  const environment = await harness(t, { refreshMemory: true, api: async (url, options) => {
    if (options?.method) {
      posts.push(url);
      if (url.endsWith('/stop')) {
        stopKey = JSON.parse(options.body).request_key;
        return { acceptance: 'acceptance_unknown' };
      }
      return { acceptance: 'accepted', result: { state: 'done' } };
    }
    if (url.includes('/requests/')) return { host: 'running', result: { state: 'done', request_key: stopKey } };
    if (url.includes('transcript')) return { host: 'running', events: [] };
    const state = snapshot();
    if (settled) {
      state.incarnations[0].state = 'exited';
      state.controls.push({ kind: 'stop', state: 'done', incarnation_id: 'inc', request_key: stopKey });
    }
    return { host: 'running', seq_high: 1, state };
  } });
  await environment.current.submit('restart');
  await environment.remount('B');
  settled = true;
  await environment.remount('A');
  await environment.current.retry();
  await flushEffects(100);
  assert.equal(posts.filter(url => url.endsWith('/resume')).length, 1);
  await environment.remount('A');
  assert.equal(posts.filter(url => url.endsWith('/resume')).length, 1);
});
