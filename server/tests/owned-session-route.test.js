'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Duplex } = require('node:stream');
const { fixture, request, COOKIE, TOKEN } = require('./helpers/session-hub-fixture.cjs');
const key = 'rk_1800000000000_123456789abcdef0';
const base = '/api/owned-sessions';

test('handoff route requires cookie, exact origin and incarnation with single-field controls', async t => {
  const h = setup(t);
  const body = { request_key: key, incarnation_id: '12345678-1234-1234-1234-123456789abc' };
  assert.equal((await mutate(h.app, 'post', '/sid/handoff', body)).status, 200);
  assert.equal((await request(h.app).post(base + '/sid/handoff').set('Cookie', COOKIE)
    .set('Origin', 'http://elsewhere').send(body)).status, 403);
  assert.equal((await request(h.app).post(base + '/sid/handoff').set('Authorization', `Bearer ${TOKEN}`)
    .set('Origin', 'http://localhost').send(body)).status, 403);
  assert.equal((await mutate(h.app, 'post', '/sid/handoff', { ...body, incarnation_id: 'bad' })).status, 400);
  assert.equal(h.calls.length, 1);
});
function setup(t) {
  const fx = fixture(t);
  const calls = [], subscribers = new Set();
  let shutdowns = 0;
  const service = {
    list: async () => ({ host: 'not_running' }), snapshot: async id => ({ state: { id }, seq_high: 0 }),
    lookup: async request_key => ({ result: { request_key, found: false } }),
    settingsPreview: async cwd => ({ ok: true, source_paths: [cwd] }),
    submit: async value => { calls.push(value); return { acceptance: 'accepted', result: { state: 'done' } }; },
    subscribe(since, send) { const sub = { since, send }; subscribers.add(sub); return () => subscribers.delete(sub); },
    shutdown() { shutdowns++; for (const sub of subscribers) sub.send('shutdown', { seq: sub.since }); }
  };
  const app = fx.app({ ownedSessionService: service });
  return { app, service, calls, subscribers, get shutdowns() { return shutdowns; } };
}
function mutate(app, verb = 'post', suffix = '/start', body = { request_key: key, cwd: '/safe', confirmed_settings: true }) {
  return request(app)[verb](base + suffix).set('Cookie', COOKIE).set('Origin', 'http://localhost').send(body);
}
test('owned routes cookie positive control and single-field auth/origin denials', async t => {
  const h = setup(t);
  assert.equal((await mutate(h.app)).status, 200);
  for (const origin of [undefined, 'http://elsewhere', 'https://localhost', 'http://localhost:80', 'http://localhost/']) {
    let call = request(h.app).post(base + '/start').set('Cookie', COOKIE);
    if (origin) call = call.set('Origin', origin);
    assert.equal((await call.send({ request_key: key, cwd: '/safe', confirmed_settings: true })).status, 403);
  }
  assert.equal((await request(h.app).post(base + '/start').set('Authorization', `Bearer ${TOKEN}`)
    .set('Origin', 'http://localhost').send({ confirmed_settings: true })).status, 403);
  assert.equal(h.calls.length, 1);
  assert.equal((await mutate(h.app, 'delete', '/id', { request_key: key })).status, 200);
  assert.equal((await request(h.app).delete(base + '/id').set('Cookie', COOKIE).send({ request_key: key })).status, 403);
});
test('GET exact Fetch-Site checks and browser cookie only', async t => {
  const h = setup(t);
  for (const suffix of ['/', '/id', '/requests/' + key]) {
    assert.equal((await request(h.app).get(base + suffix).set('Cookie', COOKIE)).status, 200);
    assert.equal((await request(h.app).get(base + suffix).set('Cookie', COOKIE).set('Sec-Fetch-Site', 'cross-site')).status, 403);
    assert.equal((await request(h.app).get(base + suffix).set('Authorization', `Bearer ${TOKEN}`)).status, 403);
  }
});
test('start confirmation is mandatory; handoff requires incarnation; body parsing bounded after auth', async t => {
  const h = setup(t);
  assert.equal((await mutate(h.app, 'post', '/start', { request_key: key, cwd: '/safe' })).status, 400);
  assert.equal(h.calls.length, 0);
  assert.equal((await mutate(h.app)).status, 200);
  assert.equal((await mutate(h.app, 'post', '/id/handoff', { request_key: key })).status, 400);
  assert.equal((await mutate(h.app, 'post', '/id/prompt', { request_key: key, body: 'x'.repeat(600000) })).status, 400);
  assert.equal((await request(h.app).post(base + '/start').set('Cookie', COOKIE).send('{')).status, 403);
});
test('all mutation routes map only defined fields and preserve browser request key', async t => {
  const h = setup(t);
  const cases = [
    ['prompt', { body: 'hello' }, { body: 'hello' }],
    ['tool-decision', { tool_use_id: 'tool', behavior: 'deny', message: 'no' },
      { target_tool_use_id: 'tool', body: { behavior: 'deny', message: 'no' } }],
    ['question-answer', { tool_use_id: 'q', answer: { choice: 'yes' } }, { target_tool_use_id: 'q', body: { answer: { choice: 'yes' } } }],
    ...['interrupt', 'stop', 'resume', 'close', 'handoff'].map(route => [route, {}, {}])
  ];
  for (const [route, input, mapped] of cases) {
    const target = ['prompt', 'tool-decision', 'question-answer', 'interrupt', 'handoff'].includes(route) ?
      { incarnation_id: '12345678-1234-1234-1234-123456789abc' } : {};
    const response = await mutate(h.app, 'post', '/sid/' + route, { request_key: key, ...target, ...input, env: 'PRIVATE', capability: 'PRIVATE' });
    assert.equal(response.status, 200);
    assert.deepEqual(h.calls.at(-1), { kind: route.replaceAll('-', '_'), request_key: key, session_id: 'sid', ...target, ...mapped });
    assert.equal(response.text.includes('PRIVATE'), false);
    assert.equal(response.text.includes('PALANTIR_TOKEN'), false);
  }
  assert.equal((await mutate(h.app, 'post', '/settings-preview', { cwd: '/safe' })).status, 200);
  assert.equal((await mutate(h.app, 'post', '/sid/tool-decision', { request_key: key, tool_use_id: 't' })).status, 400);
});
test('route maps unavailable host to 503 and conflict to 409 with fixed errors', async t => {
  const h = setup(t);
  h.service.submit = async () => { throw Object.assign(Error('PRIVATE socket capability PALANTIR_TOKEN'), { code: 'host_unreachable', status: 503 }); };
  const result = await mutate(h.app);
  assert.equal(result.status, 503); assert.deepEqual(result.body, { error: 'host_unreachable', reason: 'host_unreachable' });
  h.service.submit = async () => ({ acceptance: 'rejected', code: 'fingerprint_conflict' });
  assert.equal((await mutate(h.app)).status, 409);
});
test('dedicated SSE relays frames, disconnect unsubscribes, app shutdown closes bridge only once', async t => {
  const h = setup(t);
  const socket = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
  const req = new http.IncomingMessage(socket);
  req.method = 'GET'; req.url = base + '/stream?since=7'; req.headers = { host: 'localhost', cookie: COOKIE };
  const res = new http.ServerResponse(req);
  const frames = [];
  res.flushHeaders = () => {};
  res.write = value => { frames.push(String(value)); return true; };
  res.end = () => { frames.push('END'); return res; };
  h.app.handle(req, res);
  assert.equal(h.subscribers.size, 1);
  const sub = [...h.subscribers][0]; assert.equal(sub.since, 7);
  sub.send('resync', { seq: 7 }); assert.match(frames[0], /event: resync/);
  await h.app.shutdown(); await h.app.shutdown();
  assert.equal(h.shutdowns, 1); assert.equal(h.subscribers.size, 0); assert.equal(frames.at(-1), 'END');
});

test('abandon route requires cookie and exact origin, forwards only the path key, and returns 503 offline', async t => {
  const h = setup(t);
  const calls = [];
  h.service.abandon = async requestKey => { calls.push(requestKey); return { host: 'running', abandoned: true }; };
  const suffix = '/requests/' + key + '/abandon';
  const response = await mutate(h.app, 'post', suffix, { body: 'ignored', request_key: 'ignored' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { host: 'running', abandoned: true });
  assert.deepEqual(calls, [key]);
  assert.equal((await request(h.app).post(base + suffix).set('Cookie', COOKIE).send({})).status, 403);
  assert.equal((await request(h.app).post(base + suffix).set('Authorization', `Bearer ${TOKEN}`)
    .set('Origin', 'http://localhost').send({})).status, 403);
  assert.equal((await request(h.app).post(base + suffix).set('Cookie', COOKIE)
    .set('Origin', 'http://elsewhere').send({})).status, 403);
  assert.equal(calls.length, 1);
  h.service.abandon = async () => { throw Object.assign(new Error('host_unreachable'), { status: 503, code: 'host_unreachable' }); };
  assert.equal((await mutate(h.app, 'post', suffix, {})).status, 503);
});
