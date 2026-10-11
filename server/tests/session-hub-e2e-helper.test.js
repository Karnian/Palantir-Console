'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { mockSessionHub } = require('./e2e/helpers/session-hub');

async function fixture() {
  const routes = [], scripts = [], requests = [], native = [];
  const page = {
    addInitScript: async script => scripts.push(script),
    route: async (pattern, handler) => routes.push({ pattern, handler }),
  };
  await mockSessionHub(page, { clock: false });
  const call = async (url, method = 'GET') => {
    const path = new URL(url, 'http://localhost').pathname;
    const route = routes.find(item => item.pattern === '**/api/session-hub/chat/**');
    let result;
    await route.handler({ request: () => ({ url: () => `http://localhost${path}`, method: () => method }),
      fulfill: async value => { result = value; } });
    return result;
  };
  const context = { URL, EventTarget, Event, MessageEvent, AbortController,
    location: new URL('http://localhost/#manager'),
    EventSource: class {
      constructor(url, options) { native.push({ url, options }); }
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      const result = await call(url);
      return new Response(result.body, { status: result.status,
        headers: { 'Content-Type': result.contentType } });
    },
  };
  context.window = context;
  for (const script of scripts) vm.runInNewContext(`(${script.toString()})()`, context);
  return { context, call, requests, native };
}

test('e2e fixture emits the current SSE snapshot and stays open after its finite body', async () => {
  const { context, call, requests, native } = await fixture();
  const source = new context.EventSource('/api/session-hub/chat/stream');
  let opens = 0, errors = 0;
  source.onopen = () => opens++;
  source.onerror = () => errors++;
  const snapshot = await new Promise(resolve => source.addEventListener('snapshot', event =>
    resolve(JSON.parse(event.data))));
  assert.equal(snapshot.thread_id, 'thread-1'); assert.equal(snapshot.state, 'running');
  assert.ok(snapshot.messages.some(message => message.role === 'assistant'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opens, 1); assert.equal(errors, 0);
  assert.equal(source.readyState, context.EventSource.OPEN);
  assert.equal(requests[0].options.credentials, 'same-origin');
  source.close(); assert.equal(source.readyState, context.EventSource.CLOSED);
  assert.equal(requests[0].options.signal.aborted, true);

  await call('/api/session-hub/chat/stop', 'POST');
  const next = new context.EventSource('/api/session-hub/chat/stream');
  const updated = await new Promise(resolve => next.addEventListener('snapshot', event =>
    resolve(JSON.parse(event.data))));
  assert.equal(updated.state, 'idle'); assert.equal(updated.version, snapshot.version + 1);
  next.close();

  new context.EventSource('/api/stream', { withCredentials: true });
  new context.EventSource('https://example.com/api/session-hub/chat/stream');
  assert.equal(native.length, 2); assert.equal(native[0].url, '/api/stream');
  assert.equal(native[0].options.withCredentials, true);
  assert.equal(native[1].url, 'https://example.com/api/session-hub/chat/stream');
  assert.equal(Object.keys(native[1].options).length, 0);
  assert.equal(requests.length, 2);
});

test('closing a fixture stream before its response suppresses late open, snapshot and error events', async () => {
  const { context } = await fixture();
  let release, signal;
  context.fetch = (url, options) => {
    signal = options.signal;
    return new Promise(resolve => { release = resolve; });
  };
  const source = new context.EventSource('/api/session-hub/chat/stream'), events = [];
  for (const name of ['open', 'snapshot', 'error']) source.addEventListener(name, () => events.push(name));
  source.close(); assert.equal(signal.aborted, true);
  release(new Response('event: snapshot\ndata: {"state":"running"}\n\n'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, []); assert.equal(source.readyState, context.EventSource.CLOSED);
});
