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

for (const abandoned of [true, false]) {
  test('R10 discard awaits host abandon result: ' + abandoned, async t => {
    const response = deferred();
    let abandonCalls = 0, originalKey;
    const environment = await harness(t, { api: async (url, options) => {
      if (url.endsWith('/abandon')) {
        abandonCalls++;
        assert.equal(options.method, 'POST');
        assert.ok(url.includes(originalKey));
        return response.promise;
      }
      if (options?.method) {
        originalKey = JSON.parse(options.body).request_key;
        return { acceptance: 'acceptance_unknown' };
      }
      if (url.includes('/requests/')) return { host: 'running', result: { found: false } };
      if (url.includes('transcript')) return { host: 'running', events: [] };
      return { host: 'running', state: snapshot() };
    } });
    await environment.current.submit('prompt', { body: 'delayed request' });
    await flushEffects(20);
    await environment.current.checkPending();
    await flushEffects(20);
    const discarding = environment.current.discardPending();
    assert.equal(abandonCalls, 1);
    assert.ok(environment.current.pending);
    response.resolve({ host: 'running', abandoned, ...(!abandoned ? { existing: { state: 'completed' } } : {}) });
    await discarding;
    await flushEffects(20);
    assert.equal(environment.current.pending, null);
    assert.match(environment.current.notice, abandoned ? /버렸/ : /이미 접수된 요청/);
  });
}

test('R10 lost abandon response retains the original pending request for reconciliation', async t => {
  let abandons = 0;
  const environment = await harness(t, { api: async (url, options) => {
    if (url.endsWith('/abandon')) { abandons++; throw new Error('response lost'); }
    if (options?.method) return { acceptance: 'acceptance_unknown' };
    if (url.includes('/requests/')) return { host: 'running', result: { found: false } };
    if (url.includes('transcript')) return { host: 'running', events: [] };
    return { host: 'running', state: snapshot() };
  } });
  await environment.current.submit('prompt', { body: 'retain until durable answer' });
  await flushEffects(20);
  await environment.current.checkPending();
  await flushEffects(20);
  const key = environment.current.pending.body.request_key;
  await environment.current.discardPending();
  await flushEffects(20);
  assert.equal(abandons, 1);
  assert.equal(environment.current.pending.body.request_key, key);
  assert.equal(environment.current.disabled, true);
  assert.match(environment.current.notice, /버리기 결과 불명/);
  assert.ok(environment.context.sessionStorage.getItem('palantir.owned.pending.v1').includes(key));
});
