'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const Database = require('better-sqlite3');
const { Duplex } = require('node:stream');
const { fixture, request, COOKIE, TOKEN } = require('./helpers/session-hub-fixture.cjs');
const { serviceFixture, tick, until } = require('./helpers/session-hub-service-fixture.cjs');
let requestNumber = 0;
const send = (hub, text) => hub.message({ thread_id: hub.state().thread_id,
  request_id: `test-${++requestNumber}`, text });

const BASE = '/api/session-hub/chat';

function integrated(t, overrides = {}) {
  const fx = fixture(t);
  const process = serviceFixture(t, overrides);
  const app = fx.app({ sessionHubServiceOptions: { ...process.options, store: undefined },
    masterMemoryXprojectScanEnabled: false });
  return { ...fx, createApp: fx.app, process, app, hub: app.sessionHubService };
}
function stream(app, url, headers = {}) {
  const socket = new Duplex({ read() {}, write(chunk, encoding, callback) { callback(); } });
  const req = new http.IncomingMessage(socket);
  req.method = 'GET'; req.url = url; req.headers = { host: 'localhost', cookie: COOKIE, ...headers };
  const res = new http.ServerResponse(req);
  const frames = [];
  res.flushHeaders = () => {};
  res.write = value => { frames.push(String(value)); return true; };
  res.end = value => { if (value) frames.push(String(value)); return res; };
  app.handle(req, res);
  return { frames, req, res, close: () => { req.emit('close'); res.emit('close'); } };
}

test('POST origin matrix requires exact scheme/host/port and rejects Referer-only or bearer', async t => {
  const { app, process } = integrated(t);
  for (const action of ['start', 'message', 'stop', 'threads']) {
    for (const headers of [{}, { Referer: 'http://localhost/' }, { Origin: 'null' },
      { Origin: 'https://localhost' }, { Origin: 'http://other' }, { Origin: 'http://localhost:80' },
      { Origin: 'http://localhost:3000' }, { Origin: 'http://localhost/' }]) {
      let call = request(app).post(`${BASE}/${action}`).set('Cookie', COOKIE);
      for (const [key, value] of Object.entries(headers)) call = call.set(key, value);
      assert.equal((await call.send({ text: 'hi' })).status, 403);
    }
    assert.equal(process.calls.length, 0);
    const bearer = await request(app).post(`${BASE}/${action}`).set('Authorization', `Bearer ${TOKEN}`)
      .set('Origin', 'http://localhost').send({ text: 'hello' });
    assert.equal(bearer.status, 403);
  }
  assert.equal((await request(app).post(`${BASE}/start`).set('Cookie', COOKIE)
    .set('Origin', 'http://localhost')).status, 200);
  assert.equal(process.calls.length, 1);
  assert.equal((await request(app).post(`${BASE}/message`).set('Cookie', COOKIE)
    .set('Origin', 'http://localhost').send({ thread_id: app.sessionHubService.state().thread_id,
      request_id: 'hello', text: 'hello' })).status, 200);
  assert.equal((await request(app).post(`${BASE}/message`).set('Cookie', COOKIE)
    .set('Origin', 'http://localhost').send({ thread_id: app.sessionHubService.state().thread_id,
      request_id: 'busy', text: 'busy' })).status, 409);
  for (const action of ['stop', 'threads']) {
    assert.equal((await request(app).post(`${BASE}/${action}`).set('Cookie', COOKIE)
      .set('Origin', 'http://localhost')).status, 200);
  }
});

test('GET and SSE require cookie, accept absent/same-origin/none Fetch-Site, reject cross-site', t => {
  const { app } = integrated(t);
  return (async () => {
    for (const site of [undefined, 'same-origin', 'none', 'cross-site', 'same-site']) {
      let call = request(app).get(`${BASE}/state`).set('Cookie', COOKIE);
      if (site) call = call.set('Sec-Fetch-Site', site);
      const expected = !site || site === 'same-origin' || site === 'none' ? 200 : 403;
      assert.equal((await call).status, expected);
      const sse = stream(app, `${BASE}/stream`, site ? { 'sec-fetch-site': site } : {});
      assert.equal(sse.res.statusCode, expected);
      if (expected === 200) assert.equal(sse.frames.length, 1);
      sse.close();
    }
    assert.equal((await request(app).get(`${BASE}/state`)).status, 403);
    assert.equal((await request(app).get(`${BASE}/state`).set('Authorization', `Bearer ${TOKEN}`)).status, 403);
  })();
});

test('private SSE snapshots current messages once and subsequent changes, disconnect removes subscription', async t => {
  const { app, hub, process } = integrated(t);
  const epoch = hub.state().epoch;
  await hub.start();
  await send(hub, 'private');
  const sse = stream(app, `${BASE}/stream`);
  assert.equal(sse.frames.length, 1);
  assert.ok(sse.frames[0].includes('private'));
  assert.equal(JSON.parse(sse.frames[0].split('data: ')[1]).epoch, epoch);
  const fetched = await request(app).get(`${BASE}/state`).set('Cookie', COOKIE);
  assert.equal(fetched.body.epoch, epoch);
  process.children[0].stdout.write(`${JSON.stringify({ type: 'assistant', message: {
    content: [{ type: 'text', text: 'answer' }],
  } })}\n`);
  assert.equal(sse.frames.length, 2);
  assert.ok(sse.frames[1].includes('answer'));
  assert.equal(JSON.parse(sse.frames[1].split('data: ')[1]).epoch, epoch);
  assert.deepEqual(app.services.eventBus.replayFrom(0), []);
  sse.close();
  process.children[0].stdout.write('{"type":"result"}\n');
  assert.equal(sse.frames.length, 2);
});

test('off constructs no service, every chat endpoint fails before auth/body and FS/spawn', async t => {
  const fx = fixture(t);
  let calls = 0;
  const app = fx.app({ sessionHubActive: false, sessionHubServiceOptions: {
    spawn() { calls++; throw new Error('must not spawn'); },
    fs: new Proxy({}, { get() { calls++; throw new Error('must not access FS'); } }),
  } });
  assert.equal(app.sessionHubService, null);
  for (const action of ['start', 'message', 'stop', 'clear', 'state', 'stream']) {
    for (const method of ['get', 'post']) {
      const response = await request(app)[method](`${BASE}/${action}`)
        .set('Authorization', 'Bearer bad').send('{malformed');
      assert.equal(response.status, 404);
      assert.equal(response.body.error, 'session_hub_off');
    }
  }
  assert.equal(calls, 0);
});

test('hub history persists after restart while public runs, events, conversations and router stay isolated',
  async t => {
    const { app, hub, process, ...fx } = integrated(t);
    const folder = fs.readdirSync(fx.root).find(name => name.startsWith('app-'));
    const db = new Database(path.join(fx.root, folder, 'db'), { readonly: true });
    t.after(() => db.close());
    const count = table => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
    const runs = count('runs'); const events = count('run_events');
    let emitted = 0;
    const original = app.services.eventBus.emit;
    app.services.eventBus.emit = (...args) => { emitted++; return original(...args); };
    await hub.start();
    process.children[0].stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init',
      session_id: 'integration-owned', memory_paths: { auto: `${hub.diagnostics().transcriptDir}/memory/` },
    })}\n`);
    await send(hub, 'isolation-marker');
    process.children[0].stdout.write('{"type":"assistant","message":{"content":'
      + '[{"type":"text","text":"private answer"}]}}\n{"type":"result"}\n');
    assert.equal(count('runs'), runs); assert.equal(count('run_events'), events); assert.equal(emitted, 0);
    const publicStream = stream(app, '/api/events', { 'last-event-id': '1' });
    assert.equal(publicStream.frames.some(frame => frame.includes('isolation-marker')), false);
    publicStream.close();
    assert.deepEqual(app.services.eventBus.replayFrom(0), []);
    const conv = await request(app).get('/api/conversations/hub/events').set('Cookie', COOKIE);
    assert.equal(conv.status, 400);
    const routed = await request(app).post('/api/router/resolve').set('Cookie', COOKIE)
      .send({ text: '@hub isolation-marker', currentConversationId: 'hub' });
    assert.equal(routed.status, 200); assert.notEqual(routed.body.target, 'hub');
    await app.shutdown();
    const restarted = fx.createApp({ sessionHubServiceOptions: { ...process.options, store: undefined },
      dbPath: path.join(fx.root, folder, 'db'), masterMemoryXprojectScanEnabled: false });
    assert.ok(restarted.sessionHubService.state().messages.some(row => row.content === 'isolation-marker'));
    assert.notEqual(restarted.sessionHubService.state().epoch, hub.state().epoch);
    assert.equal(restarted.sessionHubService.state().version, 0);
  });

test('app.shutdown closes hub synchronously and awaits preparation cleanup', async t => {
  let release;
  let entered;
  const held = new Promise(resolve => { release = resolve; });
  const arrived = new Promise(resolve => { entered = resolve; });
  const { app, hub, process } = integrated(t, { fs: { ...fsp,
    async open(filename, ...args) {
      const handle = await fsp.open(filename, ...args);
      return { stat: () => handle.stat(), close: () => handle.close(), truncate: n => handle.truncate(n),
        async writeFile(data) {
          if (path.basename(filename) === 'mcp.json') { entered(); await held; }
          return handle.writeFile(data);
        } };
    },
  } });
  const starting = hub.start();
  await arrived;
  const shutdown = app.shutdown();
  assert.equal(hub.state().state, 'closed');
  assert.equal(hub.current(), null);
  assert.equal(app.shutdown(), shutdown);
  await assert.rejects(hub.start(), err => err.code === 'session_hub_closed');
  let finished = false;
  shutdown.then(() => { finished = true; });
  await tick(); assert.equal(finished, false);
  release(); await starting; await shutdown;
  assert.equal(process.calls.length, 0);
  assert.equal(fs.existsSync(path.join(process.root, 'mcp.json')), false);
});

test('explicit listening Host port grants POST only at the identical origin', async t => {
  const { app } = integrated(t);
  for (const origin of ['http://localhost', 'http://localhost:3001', 'https://localhost:3000']) {
    const response = await request(app).post(`${BASE}/start`).set('Cookie', COOKIE)
      .set('Host', 'localhost:3000').set('Origin', origin);
    assert.equal(response.status, 403);
  }
  const response = await request(app).post(`${BASE}/start`).set('Cookie', COOKIE)
    .set('Host', 'localhost:3000').set('Origin', 'http://localhost:3000');
  assert.equal(response.status, 200);
});

test('app.shutdown awaits group ESRCH before deleting MCP config', async t => {
  let alive = true;
  let signaled = false;
  const { app, hub, process } = integrated(t, { reapMs: 1000, kill(pid, signal) {
    if (signal === 'SIGTERM') signaled = true;
    if (signal === 0 && !alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  } });
  await hub.start();
  const shutdown = app.shutdown();
  assert.equal(hub.state().state, 'closed');
  let finished = false;
  shutdown.then(() => { finished = true; });
  await tick();
  assert.equal(signaled, true); assert.equal(finished, false);
  assert.equal(fs.existsSync(path.join(process.root, 'mcp.json')), true);
  alive = false;
  await shutdown;
  assert.equal(fs.existsSync(path.join(process.root, 'mcp.json')), false);
});

test('hub reap_failed does not finish app.shutdown until other cleanup settles', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const { app, hub } = integrated(t, { kill() {}, termMs: 2, reapMs: 10 });
  app.services.managerMessageQueueService.awaitDrain = () => held;
  await hub.start();
  const shutdown = app.shutdown();
  let finished = false;
  let failure;
  shutdown.then(() => { finished = true; }, err => { finished = true; failure = err; });
  try {
    await until(() => hub.state().error === 'reap_failed');
    await tick();
    assert.equal(finished, false);
    release();
    await assert.rejects(shutdown, err => err.code === 'reap_failed');
    assert.equal(failure.code, 'reap_failed');
    assert.equal(app.services._rawDb.open, false);
  } finally {
    release(); await shutdown.catch(() => {});
    // This test deliberately expects shutdown rejection; the fixture's finalizer may safely reuse it.
    app.shutdown = () => shutdown.catch(() => {});
  }
});

function pausedStream(t) {
  const express = require('express');
  const { createSessionHubChatRouter } = require('../routes/sessionHubChat');
  let publish;
  let paused = true;
  let unblock;
  let unsubscribed = false;
  const chunks = [];
  const socket = new Duplex({ read() {}, write(chunk, encoding, callback) {
    chunks.push(chunk.toString());
    if (paused) unblock = callback;
    else callback();
  } });
  const req = new http.IncomingMessage(socket);
  req.method = 'GET'; req.url = '/stream'; req.headers = { host: 'localhost' }; req.auth = { method: 'cookie' };
  const res = new http.ServerResponse(req);
  res.assignSocket(socket);
  // Node's HTTP connection handler forwards socket drain to ServerResponse; no listen is needed here.
  socket.on('drain', () => res.emit('drain'));
  const app = express();
  app.use(createSessionHubChatRouter({ service: { state: () => ({ messages: [] }), subscribe(fn) {
    publish = fn; return () => { unsubscribed = true; };
  } } }));
  app.handle(req, res);
  t.after(() => { res.destroy(); socket.destroy(); });
  return { res, socket, chunks, publish: value => publish(value), unsubscribed: () => unsubscribed,
    resume() { paused = false; unblock?.(); } };
}

test('SSE paused real ServerResponse bounds 31 updates and drains only the latest snapshot', async t => {
  const sse = pausedStream(t);
  for (let sequence = 1; sequence <= 31; sequence++) {
    sse.publish({ sequence, messages: [{ text: 'x'.repeat(1000000) }] });
  }
  assert.ok(sse.res.writableLength <= 2 * 1024 * 1024);
  sse.resume();
  await until(() => sse.chunks.join('').includes('"sequence":31'));
  assert.equal(sse.chunks.join('').includes('"sequence":15'), false);
  assert.equal(sse.unsubscribed(), false);
});

test('SSE closes on an oversized pending snapshot and unsubscribes', async t => {
  const sse = pausedStream(t);
  sse.publish({ text: 'x'.repeat(3 * 1024 * 1024) });
  await tick();
  assert.equal(sse.res.destroyed, true);
  assert.equal(sse.unsubscribed(), true);
});

test('SSE closes and unsubscribes after 30 seconds without drain', async t => {
  const timers = [];
  const original = global.setTimeout;
  t.mock.method(global, 'setTimeout', (fn, delay, ...args) => {
    if (delay === 30000) { timers.push(fn); return { unref() {} }; }
    return original(fn, delay, ...args);
  });
  const sse = pausedStream(t);
  sse.publish({ text: 'x'.repeat(1000000) });
  assert.equal(timers.length, 1);
  timers[0]();
  await tick();
  assert.equal(sse.res.destroyed, true);
  assert.equal(sse.unsubscribed(), true);
});

test('live service token reaches broker only and close immediately retires it', async t => {
  const { app, hub } = integrated(t);
  await hub.start();
  const token = hub.current();
  const broker = () => request(app).get('/api/session-hub/sessions').set('Authorization', `Bearer ${token}`);
  assert.equal((await broker()).status, 200);
  assert.equal((await request(app).get(`${BASE}/state`).set('Authorization', `Bearer ${token}`)).status, 403);
  const closing = hub.stop();
  assert.equal(hub.current(), null);
  assert.equal((await broker()).status, 403);
  await closing;
});

test('MCP EOF revokes broker access immediately while final stdout remains accepted during grace', async t => {
  const { fakeNet } = require('./helpers/session-hub-service-fixture.cjs');
  const { EventEmitter } = require('node:events');
  const net = fakeNet();
  let server;
  const create = net.createServer;
  net.createServer = handler => { server = create(handler); return server; };
  const { app, hub, process } = integrated(t, { net, execFile(command, argv, opts, callback) {
    callback(null, String(hub.diagnostics().pgid));
  } });
  await hub.start();
  process.event({ type: 'system', subtype: 'init', session_id: 'owned',
    memory_paths: { auto: `${hub.diagnostics().transcriptDir}/memory/` } });
  const socket = new EventEmitter();
  socket.setTimeout = () => {};
  socket.write = () => {};
  socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
  server.connect(socket); socket.emit('data', '{"pid":42}\n');
  await tick();
  const token = hub.current();
  const broker = () => request(app).get('/api/session-hub/sessions').set('Authorization', `Bearer ${token}`);
  assert.equal((await broker()).status, 200);
  await send(hub, 'final');
  socket.emit('end');
  assert.equal(hub.current(), null);
  assert.equal(hub.state().state, 'running');
  assert.equal((await broker()).status, 403);
  process.event({ type: 'assistant', message: { content: [{ type: 'text', text: 'preserved final answer' }] } });
  process.event({ type: 'result' });
  process.children[0].emit('exit', 0);
  await hub.close();
  assert.equal(hub.state().error, null);
  assert.equal(hub.state().messages.some(row => row.content === 'preserved final answer'), true);
});

test('SSE without a cookie is refused and malformed POST cannot bypass the Origin check', async t => {
  const { app, process } = integrated(t);
  const denied = stream(app, `${BASE}/stream`, { cookie: undefined });
  assert.equal(denied.res.statusCode, 403); denied.close();
  const missing = await request(app).post(`${BASE}/start`).set('Cookie', COOKIE).send('{bad');
  assert.equal(missing.status, 403);
  const authorized = await request(app).post(`${BASE}/start`).set('Cookie', COOKIE)
    .set('Origin', 'http://localhost').send('{bad');
  assert.equal(authorized.status, 400); assert.equal(process.calls.length, 0);
});

test('thread APIs are cookie-only, paginate full rows, require DELETE Origin and remove clear', async t => {
  const { app, hub, process } = integrated(t);
  const headers = call => call.set('Cookie', COOKIE).set('Origin', 'http://localhost');
  await hub.start();
  const old = hub.state().thread_id;
  await send(hub, 'old-thread message');
  process.children[0].stdout.write('{"type":"result"}\n');
  assert.equal((await headers(request(app).post(`${BASE}/clear`))).status, 404);
  const next = await headers(request(app).post(`${BASE}/threads`));
  assert.equal(next.status, 200); assert.notEqual(next.body.thread_id, old);
  const list = await request(app).get(`${BASE}/threads`).set('Cookie', COOKIE);
  assert.equal(list.body.threads.length, 2);
  assert.equal(list.body.threads.find(row => row.id === old).message_count, 2);
  const page = await request(app).get(`${BASE}/threads/${old}/messages?limit=1`).set('Cookie', COOKIE);
  assert.equal(page.status, 200); assert.equal(page.body.messages.length, 1);
  const row = page.body.messages[0];
  const full = await request(app).get(`${BASE}/threads/${old}/messages/${row.id}`).set('Cookie', COOKIE);
  assert.equal(full.body.seq, row.seq); assert.equal(full.body.thread_id, old);
  const before = await request(app).get(`${BASE}/threads/${old}/messages?before=${row.seq}`)
    .set('Cookie', COOKIE);
  assert.equal(before.body.messages[0].content, 'old-thread message');
  assert.equal((await request(app).delete(`${BASE}/threads/${old}`).set('Cookie', COOKIE)).status, 403);
  assert.equal((await headers(request(app).delete(`${BASE}/threads/${next.body.thread_id}`))).status, 409);
  assert.equal((await headers(request(app).delete(`${BASE}/threads/${old}`))).status, 200);
  assert.equal((await request(app).get(`${BASE}/threads/${old}/messages`).set('Cookie', COOKIE)).status, 404);
});

test('shutdown after completed stop caches private state before closing the application DB', async t => {
  const { app, hub, process } = integrated(t);
  await hub.start(); await send(hub, 'preserve after stop');
  process.children[0].stdout.write('{"type":"result"}\n');
  await hub.stop();
  await app.shutdown();
  assert.equal(hub.state().state, 'closed');
  assert.ok(hub.state().messages.some(row => row.content === 'preserve after stop'));
  await hub.shutdown();
});
