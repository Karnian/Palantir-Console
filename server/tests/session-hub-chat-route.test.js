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
const { serviceFixture, tick } = require('./helpers/session-hub-service-fixture.cjs');
const BASE = '/api/session-hub/chat';

function integrated(t, overrides = {}) {
  const fx = fixture(t);
  const process = serviceFixture(t, overrides);
  const app = fx.app({ sessionHubServiceOptions: process.options, masterMemoryXprojectScanEnabled: false });
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
  for (const action of ['start', 'message', 'stop', 'clear']) {
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
    .set('Origin', 'http://localhost').send({ text: 'hello' })).status, 200);
  assert.equal((await request(app).post(`${BASE}/message`).set('Cookie', COOKIE)
    .set('Origin', 'http://localhost').send({ text: 'busy' })).status, 409);
  for (const action of ['stop', 'clear']) {
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
  await hub.start();
  hub.message('private');
  const sse = stream(app, `${BASE}/stream`);
  assert.equal(sse.frames.length, 1);
  assert.ok(sse.frames[0].includes('private'));
  process.children[0].stdout.write(`${JSON.stringify({ type: 'assistant', message: {
    content: [{ type: 'text', text: 'answer' }],
  } })}\n`);
  assert.equal(sse.frames.length, 2);
  assert.ok(sse.frames[1].includes('answer'));
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

test('one hub turn is absent from DB, all public bus channels/replay, conversations and router; restart is empty',
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
    hub.message('isolation-marker');
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
    const restarted = fx.createApp({ sessionHubServiceOptions: process.options,
      dbPath: path.join(fx.root, folder, 'db'), masterMemoryXprojectScanEnabled: false });
    assert.deepEqual(restarted.sessionHubService.state().messages, []);
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
