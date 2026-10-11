'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, request, COOKIE, TOKEN } = require('./helpers/session-hub-fixture.cjs');
const { serviceFixture } = require('./helpers/session-hub-service-fixture.cjs');
const BASE = '/api/session-hub/memory';
function appFixture(t, extra = {}) {
  const fx = fixture(t);
  const process = serviceFixture(t);
  const app = fx.app({ sessionHubServiceOptions: { ...process.options, store: undefined }, ...extra });
  const hub = app.sessionHubService;
  const bearer = call => call.set('Authorization', `Bearer ${hub.current()}`);
  const human = call => call.set('Cookie', COOKIE).set('Origin', 'http://localhost');
  const send = (id, text) => hub.message({ thread_id: hub.state().thread_id, request_id: id, text });
  const finish = () => process.children.at(-1).stdout.write('{"type":"result"}\n');
  return { app, hub, process, bearer, human, send, finish };
}
const input = { operation: 'add', content: '한국어로 답하는 것을 선호', kind: 'preference', reason: '사용자가 요청' };
const decision = p => ({ decision: 'approved', revision: p.revision, content_hash: p.content_hash });

test('hub creates pending only; source is current server-bound turn; tool_note and dedicated SSE carry proposal',
  async t => {
    const { app, hub, bearer, send, finish } = appFixture(t);
    await hub.start();
    const states = [];
    hub.subscribe(state => states.push(state));
    assert.equal((await bearer(request(app).post(`${BASE}/proposals`).send(input))).status, 409);
    const sent = await send('one', '이 대화에서 직접 말한 선호');
    const response = await bearer(request(app).post(`${BASE}/proposals`).send({ ...input,
      source_thread_id: 'model-spoof', source_message_id: 'model-spoof', status: 'approved' }));
    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'pending');
    assert.equal(response.body.source_thread_id, sent.user.thread_id);
    assert.equal(response.body.source_message_id, sent.user.id);
    assert.equal(app.assistantMemory.active().length, 0);
    assert.ok(states.some(state => state.memory.pending_count === 1 && state.memory.revision === 0));
    const note = hub.state().messages.find(row => row.memory_proposal_id === response.body.id);
    assert.equal(note.role, 'tool_note');
    assert.equal(note.turn_id, sent.user.turn_id);
    assert.equal(app.assistantMemory.injection().text.includes(input.content), false);
    finish();
    assert.equal((await bearer(request(app).post(`${BASE}/proposals`).send(input))).status, 409);
    assert.equal(hub.state().memory.pending_count, 1);
  });

test('memory POST gate exact method/path; separate 5/minute token bucket, JSON 4KB and token rotation', async t => {
  let time = 10000;
  const { app, hub, bearer, send, finish } = appFixture(t, { sessionHubClock: () => time });
  await hub.start(); await send('first', 'remember this');
  const post = url => bearer(request(app).post(url).send(input));
  for (const path of [BASE, `${BASE}/proposals/`, `${BASE}/Proposals`, `${BASE}/%70roposals`,
    `${BASE}/proposals/extra`, `${BASE}/proposals/id/decision`, `${BASE}/id/archive`, '/api/memory']) {
    assert.equal((await post(path)).status, 403, path);
  }
  for (const method of ['get', 'patch', 'put', 'delete', 'head']) {
    assert.equal((await bearer(request(app)[method](`${BASE}/proposals`))).status, 403, method);
  }
  for (let i = 0; i < 5; i++) assert.equal((await post(`${BASE}/proposals`)).status, 200);
  assert.equal((await post(`${BASE}/proposals`)).status, 429);
  for (let i = 0; i < 30; i++) {
    assert.equal((await bearer(request(app).get('/api/session-hub/sessions'))).status, 200);
  }
  assert.equal((await bearer(request(app).get('/api/session-hub/history/search?q=remember'))).status, 200);
  time += 60000;
  assert.equal((await bearer(request(app).post(`${BASE}/proposals`)
    .send({ ...input, padding: 'a'.repeat(4096) }))).status, 400);
  assert.equal((await bearer(request(app).post(`${BASE}/proposals`).send('{broken'))).status, 400);
  assert.equal((await post(`${BASE}/proposals`)).status, 200);
  const oldToken = hub.current();
  finish(); await hub.newThread(); await hub.start(); await send('second', 'new source');
  assert.equal((await post(`${BASE}/proposals`)).status, 200);
  assert.equal((await request(app).post(`${BASE}/proposals`)
    .set('Authorization', `Bearer ${oldToken}`).send(input)).status, 403);
});

test('all human memory paths require cookie and exact Origin, reject bearer/hub; direct edits and archive work',
  async t => {
    const { app, hub, human, bearer, send } = appFixture(t);
    await hub.start(); await send('one', 'source');
    const p = (await bearer(request(app).post(`${BASE}/proposals`).send(input))).body;
    const created = await human(request(app).post(BASE).send({ content: '직접 추가', kind: 'fact' }));
    assert.equal(created.status, 200);
    const row = created.body;
    const mutations = [
      ['post', BASE, { content: 'new fact', kind: 'fact' }],
      ['post', `${BASE}/proposals/${p.id}/decision`, decision(p)],
      ['patch', `${BASE}/${row.id}`, { revision: row.revision, content: 'edit' }],
      ['post', `${BASE}/${row.id}/archive`, { revision: row.revision }],
      ['delete', `${BASE}/${row.id}`, {}],
    ];
    for (const [method, path, body] of mutations) {
      for (const origin of [undefined, 'https://localhost', 'http://evil', 'http://localhost/']) {
        const call = request(app)[method](path).set('Cookie', COOKIE).send(body);
        if (origin !== undefined) call.set('Origin', origin);
        assert.equal((await call).status, 403);
      }
      assert.equal((await request(app)[method](path).set('Authorization', `Bearer ${TOKEN}`)
        .set('Origin', 'http://localhost').send(body)).status, 403);
      assert.equal((await bearer(request(app)[method](path).send(body))).status, 403);
    }
    assert.equal((await request(app).get(BASE).set('Authorization', `Bearer ${TOKEN}`)).status, 403);
    assert.equal((await bearer(request(app).get(BASE))).status, 403);
    const listing = await human(request(app).get(BASE));
    assert.equal(listing.status, 200);
    assert.equal(listing.body.proposals[0].source_content, 'source');
    assert.equal(listing.body.memories[0].status, 'active');
    const updated = await human(request(app).patch(`${BASE}/${row.id}`)
      .send({ revision: row.revision, content: '수정', kind: 'preference' }));
    assert.equal(updated.status, 200);
    assert.equal(updated.body.revision, 2);
    assert.equal((await human(request(app).post(`${BASE}/${row.id}/archive`).send({ revision: 1 }))).status, 409);
    assert.equal((await human(request(app).post(`${BASE}/${row.id}/archive`).send({ revision: 2 }))).status, 200);
    assert.equal((await human(request(app).get(BASE))).body.memories[0].status, 'archived');
    assert.equal((await human(request(app).post(`${BASE}/proposals`).send(input))).status, 403);
  });

test('approval updates dedicated state immediately, rotates next turn, includes memory, preserves proposal history',
  async t => {
    const { app, hub, process, human, bearer, send, finish } = appFixture(t);
    await hub.start();
    let firstPayload = '';
    process.children[0].stdin.on('data', chunk => { firstPayload += chunk; });
    await send('first', '내 선호를 기억해줘');
    const p = (await bearer(request(app).post(`${BASE}/proposals`).send(input))).body;
    assert.equal(firstPayload.includes(input.content), false);
    const states = [];
    hub.subscribe(value => states.push(value));
    const approved = await human(request(app).post(`${BASE}/proposals/${p.id}/decision`).send(decision(p)));
    assert.equal(approved.status, 200);
    assert.equal(hub.state().memory.pending_count, 0);
    assert.equal(hub.state().memory.revision, 1);
    assert.ok(states.some(value => value.memory.revision === 1));
    assert.equal(process.children.length, 1);
    finish();
    await send('second', '계속해');
    assert.equal(process.children.length, 2);
    const payload = process.children[1].stdin.read().toString();
    assert.ok(payload.includes(input.content));
    assert.ok(payload.indexOf('기억 자료') < payload.indexOf('최근 대화 자료'));
    assert.ok(hub.state().messages.some(row => row.content === '맥락을 새로 정리함'));
    assert.ok(hub.state().messages.some(row => row.memory_proposal_id === p.id));
    const replay = await human(request(app).post(`${BASE}/proposals/${p.id}/decision`).send(decision(p)));
    assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true);
    assert.equal(hub.state().memory.revision, 1);
    const conflict = await human(request(app).post(`${BASE}/proposals/${p.id}/decision`)
      .send({ ...decision(p), decision: 'rejected' }));
    assert.equal(conflict.status, 409);
  });

test('an authenticated proposal with delayed JSON cannot bind to a replacement token generation or turn', async t => {
  const http = require('node:http');
  const { Duplex } = require('node:stream');
  const { app, hub, send, finish } = appFixture(t);
  await hub.start(); await send('old', 'old turn');
  const oldToken = hub.current();
  const socket = new Duplex({ read() {}, write(chunk, encoding, callback) { callback(); } });
  const req = new http.IncomingMessage(socket);
  const body = JSON.stringify(input);
  req.method = 'POST'; req.url = `${BASE}/proposals`;
  req.headers = { host: 'localhost', authorization: `Bearer ${oldToken}`,
    'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) };
  const res = new http.ServerResponse(req);
  const completed = new Promise(resolve => {
    res.end = () => { resolve(res.statusCode); return res; };
  });
  app.handle(req, res);
  finish(); await hub.newThread(); await hub.start(); await send('new', 'new turn');
  req.push(body); req.push(null);
  assert.equal(await completed, 403);
  assert.equal(app.assistantMemory.state().pending_count, 0);
});
