'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { Duplex } = require('node:stream');
const { fixture } = require('./helpers/session-host-fixture');
const { createOwnedSessionService } = require('../services/ownedSessionService');
const { createOwnedSessionsRouter } = require('../routes/ownedSessions');
const { request } = require('./helpers/session-hub-fixture.cjs');
function bridge(t) {
  const f = fixture(t); let online = true;
  const tasks = new Set();
  const client = { connect() { if (!online) throw Error('offline'); }, hostBootId: 'boot', close() {},
    lookup: key => f.core.lookup(key), snapshot: id => f.core.snapshot(id), list: () => f.core.listSessions(),
    eventsSince: (seq, options) => f.core.eventsSince(seq, options),
    submit(req) { const receipt = f.core.submitWithReceipt(req); return receipt.result; } };
  const service = createOwnedSessionService({ createClient: () => client, diagnose: () => ({ held: true }),
    timers: { setTimeout(fn) { tasks.add(fn); return fn; }, clearTimeout(fn) { tasks.delete(fn); } } });
  t.after(() => service.shutdown());
  return { f, client, service, get scheduledCount() { return tasks.size; }, set online(value) { online = value; },
    async tick() { const fn = tasks.values().next().value; tasks.delete(fn); fn?.(); for (let i = 0; i < 100; i++) await Promise.resolve(); } };
}
test('R1 stale incarnation is never retargeted after stop/resume; explicit new incarnation succeeds', async t => {
  const h = bridge(t); h.f.start(); const old = h.f.iid;
  h.f.core.submit(h.f.req('stop'));
  const resumed = h.f.core.submit(h.f.req('resume')); h.f.iid = resumed.incarnation_id;
  const stale = await h.service.submit({ kind: 'prompt', request_key: h.f.key(), session_id: h.f.sid, incarnation_id: old, body: 'old' });
  assert.equal(stale.result.state, 'rejected'); assert.equal(h.f.adapter.log.received.length, 0);
  const current = await h.service.submit({ kind: 'prompt', request_key: h.f.key(), session_id: h.f.sid,
    incarnation_id: h.f.iid, body: 'new' });
  assert.equal(current.result.state, 'completed'); assert.equal(h.f.adapter.log.received.length, 1);
});
test('R1 snapshot explicitly identifies current incarnation and keeps creation order', t => {
  const h = bridge(t); h.f.start(); const old = h.f.iid;
  h.f.core.submit(h.f.req('stop')); const resumed = h.f.core.submit(h.f.req('resume'));
  const snap = h.f.core.snapshot(h.f.sid);
  assert.equal(snap.state.current_incarnation_id, resumed.incarnation_id);
  assert.deepEqual(snap.state.incarnations.map(row => row.id), [old, resumed.incarnation_id]);
});
for (const observed of ['submit', 'snapshot', 'list', 'poll']) {
  test('R1 deleted session cannot expose cached conversation through ' + observed, async t => {
    const h = bridge(t); h.f.start();
    const prompt = h.f.req('prompt', { body: 'SECRET-CACHED-BODY' }); h.f.core.submit(prompt);
    h.f.adapter.toolRequest(h.f.iid, 'tool', 'Bash', { secret: 'SECRET-CACHED-INPUT' });
    await h.service.snapshot(h.f.sid); await h.service.lookup(prompt.request_key);
    h.f.core.submit(h.f.req('close'));
    if (observed === 'submit') await h.service.submit(h.f.req('delete'));
    else {
      h.f.core.submit(h.f.req('delete'));
      if (observed === 'snapshot') await h.service.snapshot(h.f.sid);
      if (observed === 'list') await h.service.list();
      if (observed === 'poll') { h.service.subscribe(0, () => {}); await h.tick(); }
    }
    h.online = false;
    assert.equal(JSON.stringify(await h.service.snapshot(h.f.sid)).includes('SECRET-CACHED'), false);
    assert.equal(JSON.stringify(await h.service.lookup(prompt.request_key)).includes('SECRET-CACHED'), false);
  });
}
test('R1 replay uses byte-limited pages and preserves an oversized event in the DB', t => {
  const h = bridge(t); h.f.start(); let seq = h.f.core.snapshot(h.f.sid).seq_high;
  for (let i = 0; i < 4; i++) h.f.core.onEvent({ type: 'sdk_message', incarnation_id: h.f.iid, message: { text: 'x'.repeat(1000) } });
  let page = h.f.core.eventsSince(seq, { maxBytes: 1600 });
  assert.equal(page.events.length, 1); assert.equal(page.more, true);
  const seen = [];
  do { page = h.f.core.eventsSince(seq, { maxBytes: 1600 }); seen.push(...page.events); seq = page.events.at(-1).seq; } while (page.more);
  assert.equal(seen.length, 4); assert.equal(new Set(seen.map(row => row.seq)).size, 4);
  h.f.core.onEvent({ type: 'sdk_message', incarnation_id: h.f.iid, message: { text: 'x'.repeat(13 * 1024 * 1024) } });
  page = h.f.core.eventsSince(seq);
  assert.equal(page.events[0].oversized, true); assert.equal(page.events[0].seq, seq + 1);
  assert.ok(page.events[0].bytes > 12 * 1024 * 1024);
  const Database = require('better-sqlite3'); const db = new Database(h.f.dbPath);
  assert.ok(db.prepare('SELECT length(json) n FROM events WHERE seq=?').get(seq + 1).n > 12 * 1024 * 1024); db.close();
});
function stream(t, buffered = 0, source) {
  let send, removed = false;
  const app = express(); app.use((req, res, next) => { req.auth = { method: 'cookie' }; next(); });
  app.use('/owned', createOwnedSessionsRouter({ service: { subscribe(seq, callback) { send = callback; const off = source?.subscribe(seq, callback);
    return () => { removed = true; off?.(); }; } } }));
  const socket = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
  const req = new http.IncomingMessage(socket); req.method = 'GET'; req.url = '/owned/stream?since=0'; req.headers = { host: 'localhost' };
  const res = new http.ServerResponse(req); const frames = []; let destroyed = false;
  Object.defineProperty(res, 'writableLength', { get: () => buffered });
  res.flushHeaders = () => {}; res.write = value => { frames.push(value); return true; };
  res.destroy = () => { destroyed = true; res.emit('close'); };
  app.handle(req, res); t.after(() => res.emit('close'));
  return { send: (...args) => send(...args), frames, req, res, get removed() { return removed; }, get destroyed() { return destroyed; } };
}
test('R1 fast SSE reader receives a 3MiB event; existing slow-reader backlog disconnects', t => {
  const fast = stream(t); fast.send('event', { text: 'x'.repeat(3 * 1024 * 1024) });
  assert.equal(fast.destroyed, false); assert.equal(fast.frames.length, 1);
  const slow = stream(t, 3 * 1024 * 1024); slow.send('event', { text: 'small' });
  assert.equal(slow.destroyed, true); assert.equal(slow.removed, true);
});
test('R1 routes require a well-formed incarnation for all delivery kinds and forward it unchanged', async t => {
  const app = express(); const calls = [];
  app.use((req, res, next) => { req.auth = { method: 'cookie' }; next(); });
  app.use('/owned', createOwnedSessionsRouter({ service: { submit(value) { calls.push(value); return {}; } } }));
  const id = '12345678-1234-1234-1234-123456789abc';
  for (const [route, body] of [['prompt', { body: 'hello' }], ['tool-decision', { tool_use_id: 't', behavior: 'allow' }],
    ['question-answer', { tool_use_id: 't', answer: 'yes' }], ['interrupt', {}]]) {
    const send = extra => request(app).post('/owned/s/' + route).set('Origin', 'http://localhost').send({ request_key: 'key', ...body, ...extra });
    assert.equal((await send({})).status, 400);
    assert.equal((await send({ incarnation_id: '../bad' })).status, 400);
    assert.equal((await send({ incarnation_id: id })).status, 200);
    assert.equal(calls.at(-1).incarnation_id, id);
  }
});
test('R1 request close unsubscribes SSE without app shutdown', t => {
  const h = bridge(t); const s = stream(t, 0, h.service);
  assert.equal(h.scheduledCount, 1);
  s.req.emit('close'); assert.equal(s.removed, true); assert.equal(h.scheduledCount, 0);
});

test('R1 service advances replay pages using last delivered seq and bounded client requests', async t => {
  const h = bridge(t); const calls = [], frames = [];
  h.client.eventsSince = (seq, options) => {
    calls.push({ seq, options });
    return { events: [{ seq: seq + 1, type: 'sdk_message', json: { message: 'page' } }], seq_high: 3, more: seq + 1 < 3 };
  };
  const off = h.service.subscribe(0, (event, data) => { if (event === 'event') frames.push(data.seq); });
  await h.tick(); await h.tick(); await h.tick(); off();
  assert.deepEqual(frames, [1, 2, 3]); assert.deepEqual(calls.map(row => row.seq), [0, 1, 2]);
  assert.ok(calls.every(row => row.options.maxBytes <= 4 * 1024 * 1024));
});
test('R1 same-key retry after resume returns old incarnation result without any new effect', async t => {
  const h = bridge(t); h.f.start();
  const original = h.f.req('prompt', { body: 'original' });
  const first = await h.service.submit(original);
  h.f.core.submit(h.f.req('stop')); h.f.core.submit(h.f.req('resume'));
  const replay = await h.service.submit(original);
  assert.deepEqual(replay, first); assert.equal(h.f.adapter.log.received.length, 1);
});
test('R1 bearer denial changes only authentication and invokes no service', async () => {
  const { createAuthMiddleware } = require('../middleware/auth');
  const app = express(); let calls = 0;
  app.use(createAuthMiddleware({ token: 'same-token' }));
  app.use('/owned', createOwnedSessionsRouter({ service: { submit() { calls++; return {}; } } }));
  const body = { request_key: 'same-key', cwd: '/same', confirmed_settings: true };
  assert.equal((await request(app).post('/owned/start').set('Cookie', 'palantir_token=same-token')
    .set('Origin', 'http://localhost').send(body)).status, 200);
  calls = 0;
  assert.equal((await request(app).post('/owned/start').set('Authorization', 'Bearer same-token')
    .set('Origin', 'http://localhost').send(body)).status, 403);
  assert.equal(calls, 0);
});
