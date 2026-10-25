'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const express = require('express');
const { fixture } = require('./helpers/session-host-fixture');
const { request } = require('./helpers/session-hub-fixture.cjs');
const { createOwnedSessionService } = require('../services/ownedSessionService');
const { createOwnedSessionsRouter } = require('../routes/ownedSessions');
function bridge(t, options = {}) {
  const f = fixture(t, options); let online = true; const tasks = new Set();
  const client = { hostBootId: 'boot', connect() { if (!online) throw Error('offline'); }, close() {},
    list: () => f.core.listSessions(), lookup: key => f.core.lookup(key), snapshot: id => f.core.snapshot(id),
    eventsSince: (seq, options) => f.core.eventsSince(seq, options), chunk: (...args) => f.core.chunk(...args) };
  const service = createOwnedSessionService({ createClient: () => client, diagnose: () => ({ held: true }),
    timers: { setTimeout(fn) { tasks.add(fn); return fn; }, clearTimeout(fn) { tasks.delete(fn); } } });
  const app = express(); app.use((req, res, next) => { req.auth = { method: 'cookie' }; next(); });
  app.use('/api/owned-sessions', createOwnedSessionsRouter({ service }));
  t.after(() => service.shutdown());
  return { f, service, app, set online(value) { online = value; }, async tick() {
    const fn = tasks.values().next().value; tasks.delete(fn); fn?.(); for (let i = 0; i < 100; i++) await Promise.resolve();
  } };
}
test('R2 last-known retains status only, never bodies, tool inputs or raw SDK text', async t => {
  const h = bridge(t); h.f.start(); const prompt = h.f.prompt('SECRET-BODY');
  h.f.adapter.toolRequest(h.f.iid, 'tool', 'Bash', { secret: 'SECRET-INPUT' });
  h.f.core.onEvent({ type: 'sdk_message', incarnation_id: h.f.iid, message: { text: 'SECRET-SDK' } });
  await h.service.snapshot(h.f.sid); await h.service.lookup(prompt.request_key);
  h.online = false;
  const stale = await h.service.snapshot(h.f.sid);
  assert.equal(JSON.stringify(stale).includes('SECRET-'), false);
  assert.equal(stale.last_known.state.session.state, 'active');
  assert.equal(stale.last_known.state.deliveries[0].state, 'completed');
  assert.equal(stale.last_known.state.tool_requests[0].state, 'pending');
  assert.equal(Object.hasOwn(stale.last_known.state.deliveries[0], 'body'), false);
  assert.equal(Object.hasOwn(stale.last_known.state.tool_requests[0], 'input'), false);
  assert.equal(JSON.stringify(await h.service.lookup(prompt.request_key)).includes('SECRET-'), false);
});
test('R2 snapshot previews are bounded and UTF-8 safe; full originals remain available as chunks', t => {
  const h = bridge(t); h.f.start();
  const body = '가🙂'.repeat(2000); const prompt = h.f.prompt(body);
  h.f.adapter.toolRequest(h.f.iid, 'tool', 'Bash', { text: body });
  const state = h.f.state(); const delivery = state.deliveries[0], tool = state.tool_requests[0];
  assert.ok(Buffer.byteLength(delivery.body) <= 4096); assert.equal(delivery.body_truncated, true);
  assert.equal(delivery.body_bytes, Buffer.byteLength(JSON.stringify(body)));
  assert.ok(Buffer.byteLength(tool.input) <= 4096); assert.equal(tool.input_truncated, true);
  assert.equal(delivery.body.includes('\ufffd'), false); assert.equal(tool.input.includes('\ufffd'), false);
  assert.equal(h.f.core.chunk(h.f.sid, 'delivery_body', prompt.id, 0).data, JSON.stringify(body));
  assert.equal(h.f.core.chunk(h.f.sid, 'tool_input', tool.id, 0).data, JSON.stringify({ text: body }));
});
test('R8 snapshot retains every terminal row within its byte budget', t => {
  const h = bridge(t); h.f.start();
  const db = new Database(h.f.dbPath);
  const insert = db.prepare("INSERT INTO tool_requests(id,incarnation_id,tool_use_id,tool_name,input,state) VALUES(?,?,?,'Bash','{}','expired')");
  db.transaction(() => { for (let n = 0; n < 500; n++) insert.run('row-' + n, h.f.iid, 'tool-' + n); })(); db.close();
  const snapshot = h.f.core.snapshot(h.f.sid);
  assert.equal(snapshot.state.tool_requests.length, 500); assert.equal(Object.hasOwn(snapshot, 'more'), false);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 8 * 1024 * 1024);
});
test('R2 13MiB SDK event relays placeholder and HTTP chunks reconstruct exact bytes; foreign/deleted refs reveal nothing', async t => {
  const h = bridge(t); h.f.start(); const id = h.f.sid, incarnation = h.f.iid;
  const since = h.f.core.snapshot(id).seq_high;
  const message = { text: '가🙂'.repeat(2 * 1024 * 1024) };
  h.f.core.onEvent({ type: 'sdk_message', incarnation_id: incarnation, message });
  const frames = []; h.service.subscribe(since, (event, value) => frames.push({ event, value })); await h.tick();
  const placeholder = frames.find(frame => frame.value.oversized)?.value;
  assert.ok(placeholder?.ref); assert.equal(placeholder.ref.source, 'event');
  const restored = []; let offset = 0;
  while (true) {
    const response = await request(h.app).get(`/api/owned-sessions/${id}/chunks?source=event&ref=${placeholder.seq}&offset=${offset}`);
    assert.equal(response.status, 200); const chunk = response.body;
    assert.equal(chunk.offset, offset); assert.ok(Buffer.byteLength(chunk.data) <= 1024 * 1024);
    assert.equal(chunk.data.includes('\ufffd'), false); restored.push(Buffer.from(chunk.data));
    offset += Buffer.byteLength(chunk.data); if (chunk.done) break;
  }
  assert.deepEqual(Buffer.concat(restored), Buffer.from(JSON.stringify({ message })));
  const other = h.f.core.submit({ kind: 'start', cwd: '/private/tmp', request_key: h.f.key() }).session_id;
  assert.equal((await request(h.app).get(`/api/owned-sessions/${other}/chunks?source=event&ref=${placeholder.seq}&offset=0`)).status, 404);
  h.f.core.submit(h.f.req('close')); h.f.core.submit(h.f.req('delete'));
  assert.equal((await request(h.app).get(`/api/owned-sessions/${id}/chunks?source=event&ref=${placeholder.seq}&offset=0`)).status, 404);
});

test('R2 createApp builds and mounts default bridge, including authenticated chunk routes', async t => {
  const h = bridge(t); h.f.start(); const delivery = h.f.prompt('mounted-original');
  const appFixture = require('./helpers/session-hub-fixture.cjs').fixture(t);
  const { COOKIE, TOKEN } = require('./helpers/session-hub-fixture.cjs');
  const app = appFixture.app({ sessionHubActive: false, ownedSessionServiceOptions: {
    runtimeDir: h.f.dir, createClient: () => ({ connect() {}, close() {}, hostBootId: 'mounted',
      list: () => h.f.core.listSessions(), chunk: (...args) => h.f.core.chunk(...args) })
  } });
  const url = `/api/owned-sessions/${h.f.sid}/chunks?source=delivery_body&ref=${delivery.id}&offset=0`;
  const result = await request(app).get(url).set('Cookie', COOKIE);
  assert.equal(result.status, 200); assert.equal(result.body.data, JSON.stringify('mounted-original'));
  assert.equal((await request(app).get(url).set('Authorization', `Bearer ${TOKEN}`)).status, 403);
  assert.equal((await request(app).get(url).set('Cookie', COOKIE).set('Sec-Fetch-Site', 'cross-site')).status, 403);
});
test('R2 chunks reject continuation-byte offsets and invalid sources without leaking originals', t => {
  const h = bridge(t); h.f.start(); const delivery = h.f.prompt('가🙂');
  assert.throws(() => h.f.core.chunk(h.f.sid, 'delivery_body', delivery.id, 2), { code: 'invalid_offset' });
  assert.throws(() => h.f.core.chunk(h.f.sid, 'not-a-source', delivery.id, 0), { code: 'invalid_chunk' });
  assert.equal(h.f.core.chunk(h.f.sid, 'delivery_body', delivery.id, 0).data, JSON.stringify('가🙂'));
});

test('R8 HTTP snapshot metadata overflow returns explicit 413 while the host remains readable', async t => {
  const h = bridge(t, { snapshotMaxBytes: 4096 }); h.f.start();
  const db = new Database(h.f.dbPath);
  const insert = db.prepare("INSERT INTO tool_requests(id,incarnation_id,tool_use_id,tool_name,input,state) VALUES(?,?,?,'Bash','{}','expired')");
  db.transaction(() => { for (let n = 0; n < 50; n++) insert.run('row-' + n, h.f.iid, 'tool-' + n); })(); db.close();
  const response = await request(h.app).get('/api/owned-sessions/' + h.f.sid);
  assert.equal(response.status, 413);
  assert.deepEqual(response.body, { error: 'snapshot_too_large', reason: 'snapshot_too_large' });
  assert.equal((await request(h.app).get('/api/owned-sessions')).status, 200);
});
