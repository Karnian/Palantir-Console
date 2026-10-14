'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const childProcess = require('node:child_process');
const { fixture, managerToken, request, TOKEN, PM, COOKIE } = require('./helpers/session-hub-fixture.cjs');
const { sessionHubActive, managedSettingsPresent } = require('../services/sessionHubActivation');
const { resolveClaudeBinary } = require('../services/streamJsonEngine');
const { createAuthMiddleware, managerCapabilityRequestAllowed } = require('../middleware/auth');
const { createConversationsRouter } = require('../routes/conversations');
const express = require('express');
const BASE = '/api/session-hub';
const LIVE = 'live-hub-fixture';
const auth = (app, token, url = `${BASE}/sessions`) =>
  request(app).get(url).set('Authorization', `Bearer ${token}`);
const errorBody = code => ({ error: code, reason: code });

test('createApp broker auth matrix accepts only live hub and human cookie; retired tokens fail', async t => {
  const fx = fixture(t);
  let current = LIVE;
  const app = fx.app({ sessionHubTokenProvider: { current: () => current } });
  const top = managerToken(app, 'top', 'top');
  const operator = managerToken(app, 'operator', 'operator:fixture');
  const worker = app.services.workerProposalTokenService.mint('run_fixture', { projectId: 'fixture' });
  assert.ok(top); assert.ok(operator); assert.ok(worker);
  for (const url of [`${BASE}/sessions`, `${BASE}/search?q=검토`,
    `${BASE}/sessions/${encodeURIComponent(fx.alpha.sessions[0].key)}`]) {
    assert.equal((await auth(app, LIVE, url)).status, 200);
    assert.equal((await request(app).get(url).set('Cookie', COOKIE)).status, 200);
    for (const token of [top, operator, worker, TOKEN, PM, 'retired', 'bad']) {
      const response = await auth(app, token, url);
      assert.equal(response.status, 403, token);
      assert.deepEqual(response.body, errorBody('forbidden'));
    }
    const mixed = await request(app).get(url).set('Cookie', COOKIE).set('Authorization', 'Bearer bad');
    assert.equal(mixed.status, 403); assert.deepEqual(mixed.body, errorBody('forbidden'));
    assert.equal((await request(app).get(url)).status, 403);
  }
  current = null;
  assert.equal((await auth(app, LIVE)).status, 403);
});

test('hub token gate precedes health, login/logout, parser and all manager/worker route handling', async t => {
  const fx = fixture(t);
  const app = fx.app({ sessionHubTokenProvider: { current: () => LIVE } });
  const verify = app.services.managerCapabilityTokenService.verify;
  let managerVerifications = 0;
  app.services.managerCapabilityTokenService.verify = function (...args) {
    managerVerifications++; return verify.apply(this, args);
  };
  for (const url of ['/api/health', '/api/auth/login', '/api/auth/logout', '/api/runs', '/api/tasks',
    '/api/conversations/top/events', '/api/observe/snapshots', '/api/memory', '/api/agent-context',
    `${BASE}/chat/state`, `${BASE}/chat/message`, '/api/worker/questions']) {
    for (const method of ['get', 'post']) {
      const response = await request(app)[method](url).set('Authorization', `Bearer ${LIVE}`)
        .set('Content-Type', 'application/json').send('{broken');
      assert.equal(response.status, 403, `${method} ${url}`);
      assert.deepEqual(response.body, errorBody('forbidden'));
    }
  }
  for (const method of ['post', 'put', 'patch', 'delete', 'head', 'options']) {
    assert.equal((await request(app)[method](`${BASE}/sessions`).set('Authorization', `Bearer ${LIVE}`)).status, 403);
  }
  assert.equal(managerVerifications, 0);
  assert.equal((await request(app).get('/api/health')).status, 200);
  assert.equal((await request(app).post('/api/auth/login').send({ token: TOKEN })).status, 204);
  assert.equal((await request(app).post('/api/auth/logout')).status, 204);
  // Health still ignores an unrelated bearer; authenticated API paths keep explicit bearer failure.
  assert.equal((await auth(app, 'bad', '/api/health')).status, 200);
  const wrong = await request(app).get('/api/tasks').set('Cookie', COOKIE).set('Authorization', 'Bearer bad');
  assert.equal(wrong.status, 403);
  const noAuth = fx.app({ authToken: null, sessionHubActive: false,
    sessionHubTokenProvider: { current: () => null } });
  assert.equal((await auth(noAuth, 'bad', '/api/tasks')).status, 200);
  assert.equal((await request(noAuth).get('/api/health')).status, 200);
  assert.equal((await request(noAuth).post('/api/auth/login').send({ token: TOKEN })).status, 404);
});

test('off activation combinations return 404 before auth/body with identical store/FS/spawn doubles', async t => {
  const fx = fixture(t);
  const previous = process.env.PALANTIR_SESSION_HUB;
  process.env.PALANTIR_SESSION_HUB = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.PALANTIR_SESSION_HUB;
    else process.env.PALANTIR_SESSION_HUB = previous;
  });
  let storeCalls = 0;
  let spawns = 0;
  const sameEngine = { type: 'off-fixture', hasProcess: () => false, isAlive: () => false,
    listSessions: () => [], kill: () => true,
    spawnAgent: () => { spawns++; throw new Error('unexpected engine spawn'); } };
  const noRead = () => { storeCalls++; throw new Error('unexpected read'); };
  const sameStore = { readAllSnapshots: noRead, readSnapshotHashed: noRead,
    listSnapshots: noRead, readSnapshot: noRead };
  process.env.PALANTIR_SESSION_HUB = '0';
  const flagOff = fx.app({ sessionHubActive: undefined, observeSnapshotStore: sameStore, executionEngine: sameEngine });
  process.env.PALANTIR_SESSION_HUB = '1';
  const apps = [
    flagOff,
    fx.app({ sessionHubActive: undefined, observeSnapshotDir: null, observeSnapshotStore: sameStore,
      executionEngine: sameEngine }),
    fx.app({ sessionHubActive: undefined, authToken: null, observeSnapshotStore: sameStore,
      executionEngine: sameEngine }),
  ];
  let fsCalls = 0;
  const names = ['realpathSync', 'lstatSync', 'statSync', 'readdirSync', 'openSync', 'readSync', 'readFileSync'];
  const originals = Object.fromEntries(names.map(name => [name, fs[name]]));
  const spawn = childProcess.spawn;
  for (const name of names) fs[name] = function (...args) { fsCalls++; return originals[name].apply(fs, args); };
  childProcess.spawn = function () { spawns++; throw new Error('unexpected spawn'); };
  try {
    for (const app of apps) {
      for (const url of [`${BASE}/sessions`, `${BASE}/search`, `${BASE}/sessions/any`,
        `${BASE}/chat/start`, `${BASE}/chat/message`, `${BASE}/answers/a/claude:a:u1?rev=${'0'.repeat(16)}`, `${BASE}/unknown`]) {
        for (const method of ['get', 'post']) {
          const response = await request(app)[method](url).set('Authorization', 'Bearer bad')
            .set('Content-Type', 'application/json').send('{broken');
          assert.equal(response.status, 404);
          assert.deepEqual(response.body, errorBody('session_hub_off'));
          assert.equal(response.headers['cache-control'], 'no-store');
        }
      }
    }
    assert.equal(storeCalls, 0); assert.equal(fsCalls, 0); assert.equal(spawns, 0);
  } finally {
    Object.assign(fs, originals); childProcess.spawn = spawn;
  }
});

test('off activation never calls userInfo or binary resolution when user lookup would throw', t => {
  let lookups = 0;
  t.mock.method(os, 'userInfo', () => { lookups++; throw new Error('user lookup unavailable'); });
  const resolveBinary = () => { throw new Error('off must not resolve binaries'); };
  for (const override of [{ env: {} }, { observeState: { on: false } }, { authToken: null }]) {
    assert.equal(sessionHubActive({ env: { PALANTIR_SESSION_HUB: '1' }, observeState: { on: true },
      authToken: TOKEN, resolveBinary, ...override }), false);
  }
  assert.equal(lookups, 0);
});

test('on activation fails closed without throwing when managed user lookup is unavailable', t => {
  let lookups = 0;
  t.mock.method(os, 'userInfo', () => { lookups++; throw new Error('user lookup unavailable'); });
  assert.equal(sessionHubActive({ env: { PALANTIR_SESSION_HUB: '1' }, observeState: { on: true },
    authToken: TOKEN, resolveBinary: () => ({ executable: true }) }), false);
  assert.equal(lookups, 1);
});

test('boot activation requires executable claude and rejects managed directories and both MDM paths', t => {
  const fx = fixture(t);
  const base = { env: { PALANTIR_SESSION_HUB: '1' }, observeState: fx.state, authToken: TOKEN,
    resolveBinary: () => ({ path: '/fixture', executable: true }), managedPaths: [] };
  assert.equal(sessionHubActive(base), true);
  for (const override of [{ env: {} }, { observeState: { on: false } }, { authToken: null },
    { resolveBinary: () => ({ path: '/fixture', executable: false }) }]) {
    assert.equal(sessionHubActive({ ...base, ...override }), false);
  }
  const directory = path.join(fx.root, 'managed'); fs.mkdirSync(directory);
  assert.equal(managedSettingsPresent([directory]), false);
  fs.mkdirSync(path.join(directory, 'nested'));
  fs.writeFileSync(path.join(directory, 'nested', 'managed-settings.json'), '{}');
  assert.equal(sessionHubActive({ ...base, managedPaths: [directory] }), false);
  const probed = [];
  const fakeFs = { lstatSync(filename) {
    probed.push(filename);
    if (filename.endsWith('com.anthropic.claudecode.plist')) return { isDirectory: () => false };
    throw Object.assign(new Error(), { code: 'ENOENT' });
  } };
  assert.equal(sessionHubActive({ ...base, managedPaths: undefined, filesystem: fakeFs, user: 'fixture' }), false);
  assert.ok(probed.includes('/Library/Managed Preferences/com.anthropic.claudecode.plist'));
  fakeFs.lstatSync = filename => {
    probed.push(filename);
    if (filename.includes('/fixture/')) return { isDirectory: () => false };
    throw Object.assign(new Error(), { code: 'ENOENT' });
  };
  assert.equal(sessionHubActive({ ...base, managedPaths: undefined, filesystem: fakeFs, user: 'fixture' }), false);
  assert.ok(probed.includes('/Library/Managed Preferences/fixture/com.anthropic.claudecode.plist'));
  fakeFs.lstatSync = filename => {
    if (filename === '/etc/claude-code/') return { isDirectory: () => false };
    throw Object.assign(new Error(), { code: 'ENOENT' });
  };
  assert.equal(sessionHubActive({ ...base, managedPaths: undefined, filesystem: fakeFs }), false);
  assert.equal(managedSettingsPresent(['/denied'], {
    lstatSync: () => { throw Object.assign(new Error(), { code: 'EACCES' }); },
  }), true);
  const binary = path.join(fx.root, 'claude'); fs.writeFileSync(binary, 'fixture');
  fs.chmodSync(binary, 0o600);
  assert.deepEqual(resolveClaudeBinary({ env: { CLAUDE_BIN: binary }, homeDir: fx.root }),
    { path: binary, executable: false });
  fs.chmodSync(binary, 0o700);
  assert.deepEqual(resolveClaudeBinary({ env: { CLAUDE_BIN: binary }, homeDir: fx.root }),
    { path: binary, executable: true });
  const relative = path.relative(process.cwd(), binary);
  assert.deepEqual(resolveClaudeBinary({ env: { CLAUDE_BIN: relative }, homeDir: fx.root }),
    { path: binary, executable: true });
  assert.deepEqual(resolveClaudeBinary({ env: { PATH: fx.root }, homeDir: fx.root }),
    { path: binary, executable: true });
});

test('activation is computed once and forwarded consistently without changing agent-context', async t => {
  const fx = fixture(t);
  const previous = process.env.PALANTIR_SESSION_HUB;
  process.env.PALANTIR_SESSION_HUB = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.PALANTIR_SESSION_HUB;
    else process.env.PALANTIR_SESSION_HUB = previous;
  });
  let resolutions = 0;
  const on = fx.app({ sessionHubActive: undefined, sessionHubManagedPaths: [],
    sessionHubResolveClaudeBinary: () => { resolutions++; return { path: 'fixture', executable: true }; } });
  const off = fx.app({ sessionHubActive: false });
  assert.equal(on.sessionHubActive, true); assert.equal(off.sessionHubActive, false);
  process.env.PALANTIR_SESSION_HUB = '0';
  assert.equal((await request(on).get('/api/health')).body.sessionHubActive, true);
  assert.equal((await request(off).get('/api/health')).body.sessionHubActive, false);
  assert.equal(resolutions, 1);
  for (const [layer, conversationId] of [['top', 'top'], ['operator', 'operator:fixture']]) {
    const a = await auth(on, managerToken(on, layer, conversationId), '/api/agent-context');
    const b = await auth(off, managerToken(off, layer, conversationId), '/api/agent-context');
    assert.equal(a.status, 200); assert.equal(b.status, 200); assert.equal(a.text, b.text);
  }
});

test('hub rate limit is 30/minute per live token, cookies do not consume it and rotation resets it', async t => {
  const fx = fixture(t);
  let token = LIVE;
  let time = 1000;
  const app = fx.app({ sessionHubTokenProvider: { current: () => token }, sessionHubClock: () => time });
  for (let index = 0; index < 30; index++) assert.equal((await auth(app, token)).status, 200);
  const denied = await auth(app, token);
  assert.equal(denied.status, 429); assert.deepEqual(denied.body, errorBody('session_hub_rate_limited'));
  assert.equal((await request(app).get(`${BASE}/sessions`).set('Cookie', COOKIE)).status, 200);
  time += 60000; assert.equal((await auth(app, token)).status, 200);
  token = 'rotated'; assert.equal((await auth(app, token)).status, 200);
  assert.equal((await auth(app, LIVE)).status, 403);
});

test('Top events are permanently blocked for Operator, literal/encoded; other readers unchanged on/off', async t => {
  const fx = fixture(t);
  for (const active of [false, true]) {
    const app = fx.app({ sessionHubActive: active });
    const top = managerToken(app, 'top', 'top');
    const operator = managerToken(app, 'operator', 'operator:fixture');
    managerToken(app, 'operator', 'operator:other');
    const seed = (conversationId, text) => {
      const runId = app.managerRegistry.getActiveRunId(conversationId);
      assert.ok(runId);
      const id = app.services.runService.addRunEvent(runId, 'fixture:conversation', JSON.stringify({ text }));
      return { after: id - 1, body: { events: [app.services.runService.getRunEventById(runId, id)] } };
    };
    const topEvent = seed('top', 'Top 대화 이벤트');
    const ownEvent = seed('operator:fixture', 'Operator 자기 대화 이벤트');
    const otherEvent = seed('operator:other', 'Top이 읽는 다른 Operator 이벤트');
    const expectEvents = (response, expected) => {
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, expected.body);
    };
    for (const id of ['top', '%74op', '%74%6f%70']) {
      const url = `/api/conversations/${id}/events?after=${topEvent.after}`;
      assert.equal((await auth(app, operator, url)).status, 403);
      expectEvents(await auth(app, top, url), topEvent);
      expectEvents(await request(app).get(url).set('Cookie', COOKIE), topEvent);
    }
    const own = `/api/conversations/operator%3Afixture/events?after=${ownEvent.after}`;
    expectEvents(await auth(app, operator, own), ownEvent);
    expectEvents(await auth(app, top, own), ownEvent);
    expectEvents(await request(app).get(own).set('Cookie', COOKIE), ownEvent);
    const other = `/api/conversations/operator%3Aother/events?after=${otherEvent.after}`;
    expectEvents(await auth(app, top, other), otherEvent);
    expectEvents(await request(app).get(other).set('Cookie', COOKIE), otherEvent);
  }
  assert.equal(managerCapabilityRequestAllowed({ method: 'GET', originalUrl: '/api/conversations/%74op/events' },
    { layer: 'pm' }), false);
});

test('route resolver aliases to Top receive a second scope check before events are read', async () => {
  let reads = 0;
  const app = express();
  app.use(createAuthMiddleware({ token: TOKEN,
    managerCapabilityTokenService: { verify: () => ({ runId: 'r', layer: 'pm', conversationId: 'operator:f' }) },
    isManagerCapabilityActive: () => true }));
  app.use('/api/conversations', createConversationsRouter({ runService: {}, conversationService: {
    parseConversationId: () => ({ kind: 'pm' }),
    resolveConversation: () => ({ kind: 'top', conversationId: 'top' }),
    getEvents: () => { reads++; return []; },
  } }));
  const response = await auth(app, 'operator', '/api/conversations/alias/events');
  assert.equal(response.status, 403); assert.equal(reads, 0);
});

test('history token route is exact, generation-bound, byte capped and has its own 30/minute bucket', async t => {
  const { serviceFixture } = require('./helpers/session-hub-service-fixture.cjs');
  const fx = fixture(t);
  const processFixture = serviceFixture(t);
  let time = 100000;
  const app = fx.app({ sessionHubServiceOptions: { ...processFixture.options, store: undefined },
    sessionHubClock: () => time });
  const hub = app.sessionHubService;
  await hub.start();
  const oldThread = hub.state().thread_id;
  await hub.message({ thread_id: oldThread, request_id: 'first', text: 'needle old-thread' });
  processFixture.children[0].stdout.write('{"type":"result"}\n');
  const retired = hub.current();
  await hub.newThread(); await hub.start();
  const token = hub.current();
  const active = hub.state().thread_id;
  await hub.message({ thread_id: active, request_id: 'second', text: 'needle active-thread' });
  processFixture.children[1].stdout.write('{"type":"result"}\n');
  const search = '/api/session-hub/history/search?q=needle';
  const bearer = call => call.set('Authorization', `Bearer ${token}`);
  const result = await bearer(request(app).get(search));
  assert.equal(result.status, 200); assert.equal(result.body.thread_id, active);
  assert.equal(result.body.results[0].snippet, 'needle active-thread');
  assert.ok(Buffer.byteLength(result.text) <= 65536);
  assert.equal((await request(app).get(search).set('Authorization', `Bearer ${retired}`)).status, 403);
  for (let i = 0; i < 30; i++) assert.equal((await bearer(request(app).get('/api/session-hub/sessions'))).status, 200);
  assert.equal((await bearer(request(app).get('/api/session-hub/sessions'))).status, 429);
  for (let i = 1; i < 30; i++) assert.equal((await bearer(request(app).get(search))).status, 200);
  assert.equal((await bearer(request(app).get(search))).status, 429);
  time += 60000;
  assert.equal((await bearer(request(app).get(search))).status, 200);
  for (const url of ['/api/session-hub/history/search/', '/api/session-hub/History/search',
    '/api/session-hub/history/search/extra', '/api/session-hub/history/%73earch', `${search}&thread_id=${oldThread}`]) {
    const response = await bearer(request(app).get(url));
    assert.equal(response.status, url.includes('thread_id=') ? 400 : 403);
  }
  for (const method of ['post', 'delete', 'put']) {
    assert.equal((await bearer(request(app)[method](search))).status, 403);
  }
});

async function within(promise, label, timeoutMs = 5000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new assert.AssertionError({
        message: `Timed out after ${timeoutMs}ms waiting for ${label}`,
      })), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
async function waitForEntry(entered, response) {
  return within(Promise.race([entered, response.then(result => {
    assert.fail(`HTTP response before query entry: status=${result.status ?? 'unknown'} body=${JSON.stringify(result.body ?? result.message)}`);
  })]), 'query entry or early HTTP response');
}

// Host-only createApp integration uses supertest; no real assistant is spawned.
const supertest = require('supertest');
const snapshotStore = require('../services/observeSnapshotStore');
const answerResult = (text = '작업자가 보고한 답변') => ({ status: 'final', text, truncated: false,
  redacted: false, shared_turn: false, reason: null, answer_at: '2026-10-14T00:00:00Z',
  observed_at: '2026-10-14T00:01:00Z' });
async function answersFixture(t, options = {}) {
  const fx = fixture(t);
  // Four distinct sessions with real snapshot cards and instructions.
  const session = fx.alpha.sessions[0], instruction = fx.alpha.instructions[0];
  fx.alpha.sessions = Array.from({ length: 4 }, (_, i) => ({ ...session,
    key: `alpha:claude:a${i}`, session_id: `a${i}`, instruction_count: 1, instruction_total: 1 }));
  fx.alpha.instructions = fx.alpha.sessions.map((row, i) => ({ ...instruction,
    session_key: row.key, id: `claude:a${i}:u1`, text: `answer target ${i}`, seq: 1 }));
  fx.write(fx.alpha);
  const processFx = require('./helpers/session-hub-service-fixture.cjs').serviceFixture(t);
  await processFx.service.stop(); // Finish the helper owner's namespace setup before createApp reuses its fake I/O.
  const calls = [];
  let implementation = input => {
    const current = snapshotStore.readSnapshotHashed(fx.state, input.machineId);
    assert.equal(current.ok, true);
    if (current.sha256 !== input.rev) throw Object.assign(new Error('snapshot_changed'), { code: 'snapshot_changed', status: 409 });
    if (!current.snapshot.instructions.some(row => row.id === input.instructionId && row.session_key === input.sessionKey)) {
      throw Object.assign(new Error('not_found'), { code: 'not_found', status: 404 });
    }
    return answerResult();
  };
  const answerService = { query(input) { calls.push(input); return implementation(input); }, async shutdown() {} };
  const app = fx.app({ ...options,
    sessionHubServiceOptions: { ...processFx.options, store: undefined, ...options.sessionHubServiceOptions },
    answerQueryService: answerService });
  const hub = app.sessionHubService;
  await hub.start();
  let number = 0;
  const newTurn = async () => {
    if (hub.state().turnInProgress) processFx.children.at(-1).stdout.write('{"type":"result"}\n');
    await hub.message({ thread_id: hub.state().thread_id, request_id: `answer-${++number}`, text: '답변 조회' });
  };
  await newTurn();
  const get = url => supertest(app).get(url).set('Authorization', `Bearer ${hub.current()}`);
  const url = (i, rev, instructionId = `claude:a${i}:u1`) =>
    `${BASE}/answers/${fx.alpha.sessions[i].key}/${instructionId}?rev=${rev}`;
  const list = () => get(`${BASE}/sessions?machine=alpha`);
  return { ...fx, app, hub, calls, get, url, list, newTurn, processFx, answerService,
    query(fn) { implementation = fn; } };
}

test('get_answer auth matrix, exact paths, private machine binding and exact untrusted envelope', async t => {
  const fx = await answersFixture(t), listed = await fx.list(), rev = listed.body.meta.rev;
  assert.equal(listed.status, 200);
  const url = fx.url(0, rev), token = fx.hub.current();
  const result = await fx.get(url);
  assert.equal(result.status, 200); assert.equal(result.headers['cache-control'], 'no-store');
  assert.deepEqual(result.body, { answer: { trust: 'untrusted_worker_report', source: {
    machine: fx.alpha.machine.label, key: fx.alpha.sessions[0].key, instruction_id: 'claude:a0:u1' },
  ...answerResult(), budget_clipped: false }, meta: { rev } });
  assert.ok(Buffer.byteLength(result.text) <= 65536);
  assert.deepEqual(fx.calls[0], { machineId: 'alpha', sessionKey: fx.alpha.sessions[0].key,
    instructionId: 'claude:a0:u1', rev: snapshotStore.readSnapshotHashed(fx.state, 'alpha').sha256 });
  const top = managerToken(fx.app, 'top', 'top'), operator = managerToken(fx.app, 'operator', 'operator:fixture');
  const worker = fx.app.services.workerProposalTokenService.mint('run_answer', { projectId: 'fixture' });
  for (const bearer of [TOKEN, PM, top, operator, worker, 'retired']) {
    const response = await supertest(fx.app).get(url).set('Authorization', `Bearer ${bearer}`);
    assert.equal(response.status, 403); assert.deepEqual(response.body, errorBody('forbidden'));
  }
  assert.equal((await supertest(fx.app).get(url).set('Cookie', COOKIE)).status, 403);
  for (const bad of [url.replace('?rev=', '/extra?rev='), url.replace('/answers/', '/answers-extra/')]) {
    assert.equal((await fx.get(bad)).status, 403);
  }
  assert.equal((await supertest(fx.app).head(url).set('Authorization', `Bearer ${token}`)).status, 403);
  assert.equal(fx.calls.length, 1);
  await fx.hub.stop();
  assert.equal((await supertest(fx.app).get(url).set('Authorization', `Bearer ${token}`)).status, 403);
});

test('cookie lists do not bind; invalid scope/rev/raw queries do not consume answer budget', async t => {
  const fx = await answersFixture(t);
  const cookieList = await supertest(fx.app).get(`${BASE}/sessions?machine=alpha`).set('Cookie', COOKIE);
  let rev = cookieList.body.meta.rev;
  assert.equal((await fx.get(fx.url(0, rev))).body.error, 'answer_out_of_scope');
  const listed = await fx.list(); rev = listed.body.meta.rev;
  for (const [url, status, error] of [
    [fx.url(0, '0'.repeat(16)), 409, 'snapshot_changed'],
    [`${BASE}/answers/unlisted/claude:a0:u1?rev=${rev}`, 403, 'answer_out_of_scope'],
    [fx.url(0, rev) + '&rev=' + rev, 400, 'invalid_query'],
    [fx.url(0, rev) + '&machine=alpha', 400, 'invalid_query'],
    [fx.url(0, rev).replace('?rev=', '?%72ev='), 400, 'invalid_query'],
    [fx.url(0, rev).replace('?rev=', '?rev=%30'), 400, 'invalid_query'],
    [fx.url(0, rev, 'bad'), 400, 'invalid_query'],
    [fx.url(0, rev) + '&x=' + 'a'.repeat(300), 400, 'invalid_query'],
  ]) {
    const response = await fx.get(url); assert.equal(response.status, status);
    assert.deepEqual(response.body, errorBody(error));
  }
  assert.equal(fx.calls.length, 0);
  for (let i = 0; i < 5; i++) assert.equal((await fx.get(fx.url(0, rev))).status, 200);
  const sixth = await fx.get(fx.url(0, rev));
  assert.equal(sixth.status, 429); assert.equal(sixth.body.error, 'answer_budget_exceeded');
  assert.equal(fx.calls.length, 5);
});

test('three-session limit is independent of five calls; complete freezes new keys and clips bytes without charging overflow', async t => {
  const fx = await answersFixture(t), rev = (await fx.list()).body.meta.rev;
  for (let i = 0; i < 3; i++) assert.equal((await fx.get(fx.url(i, rev))).status, 200);
  const fourth = await fx.get(fx.url(3, rev));
  assert.equal(fourth.status, 429); assert.equal(fourth.body.error, 'answer_budget_exceeded');
  assert.equal(fx.calls.length, 3);
  await fx.newTurn();
  const detail = await fx.get(`${BASE}/sessions/${fx.alpha.sessions[0].key}`);
  assert.equal(detail.status, 200);
  fx.query(() => answerResult('한'.repeat(8000))); // 24,000 UTF-8 bytes
  const first = await fx.get(fx.url(0, detail.body.meta.rev)); assert.equal(first.status, 200);
  await fx.list();
  assert.equal((await fx.get(fx.url(1, rev))).body.error, 'answer_out_of_scope');
  fx.query(() => answerResult('x'.repeat(577)));
  const overflow = await fx.get(fx.url(0, rev));
  assert.equal(overflow.status, 200); assert.equal(overflow.body.answer.budget_clipped, true);
  assert.equal(overflow.body.answer.text, null); assert.equal(overflow.body.answer.status, 'final');
  fx.query(() => answerResult('x'.repeat(576)));
  assert.equal((await fx.get(fx.url(0, rev))).body.answer.budget_clipped, false);
});

for (const failure of ['snapshot_changed', 'answer_busy', 'snapshot_unavailable', 'not_found', 'timeout']) test(
  `reserved ${failure} consumes attempts, synchronous throws and promises both count`, async t => {
    const fx = await answersFixture(t), rev = (await fx.list()).body.meta.rev;
    const statuses = { snapshot_changed: 409, answer_busy: 429, snapshot_unavailable: 503, not_found: 404 };
    let attempts = 0;
    fx.query(() => {
      attempts++;
      if (failure === 'timeout') return { ...answerResult(null), status: 'unavailable',
        reason: 'timeout', answer_at: null };
      const error = Object.assign(new Error(failure), { code: failure, status: statuses[failure] });
      if (attempts % 2) throw error;
      return Promise.reject(error);
    });
    for (let i = 0; i < 5; i++) assert.equal((await fx.get(fx.url(0, rev))).status, statuses[failure] || 200);
    const response = await fx.get(fx.url(0, rev));
    assert.equal(response.status, 429); assert.equal(response.body.error, 'answer_budget_exceeded');
    assert.equal(attempts, 5);
  });

test('global rev changes preserve the bound machine hash, target changes reject until detail refresh even after freezing', async t => {
  const fx = await answersFixture(t), old = (await fx.list()).body.meta.rev;
  fx.beta.instructions[0].text += ' other machine updated'; fx.write(fx.beta);
  const newer = (await fx.list()).body.meta.rev; assert.notEqual(old, newer);
  assert.equal((await fx.get(fx.url(0, old))).status, 200);
  assert.equal((await fx.get(fx.url(0, newer))).status, 200);
  fx.alpha.instructions[0].text += ' target updated'; fx.write(fx.alpha);
  assert.equal((await fx.get(fx.url(0, old))).body.error, 'snapshot_changed');
  const detail = await fx.get(`${BASE}/sessions/${fx.alpha.sessions[0].key}`);
  const recovered = await fx.get(fx.url(0, detail.body.meta.rev));
  assert.equal(recovered.status, 200); assert.equal(recovered.body.meta.rev, detail.body.meta.rev);
  assert.equal(fx.calls.length, 4);
});

test('late answer success is discarded with 409 after its turn ends and cannot freeze the new turn', async t => {
  const fx = await answersFixture(t), rev = (await fx.list()).body.meta.rev;
  let resolve, started;
  const entered = new Promise(done => { started = done; });
  fx.query(() => { started(); return new Promise(done => { resolve = done; }); });
  const client = fx.get(fx.url(0, rev));
  const pending = client.then(value => value);
  try {
    await waitForEntry(entered, pending);
    await fx.newTurn(); resolve(answerResult());
    const late = await within(pending, 'late answer response'); assert.equal(late.status, 409); assert.equal(late.body.error, 'turn_not_active');
    fx.query(() => answerResult());
    assert.equal((await fx.get(fx.url(0, rev))).body.error, 'answer_out_of_scope');
    const search = await fx.get(`${BASE}/search?q=answer`); assert.equal(search.status, 200);
    assert.equal((await fx.get(fx.url(1, search.body.meta.rev))).status, 200);
    fx.processFx.children.at(-1).stdout.write('{"type":"result"}\n');
    assert.equal((await fx.get(fx.url(0, rev))).body.error, 'turn_not_active');
  } finally {
    resolve?.(answerResult());
    client.abort();
    await closeHostServer(client.app);
    await within(pending.catch(() => {}), 'answer request cleanup');
  }
});

test('broker bucket is shared by answers and lists, and minute resets never reset turn budget', async t => {
  let time = 1000;
  const fx = await answersFixture(t, { sessionHubClock: () => time }), rev = (await fx.list()).body.meta.rev;
  for (let i = 0; i < 28; i++) assert.equal((await fx.list()).status, 200);
  assert.equal((await fx.get(fx.url(0, rev))).status, 200); // 30th broker request
  assert.equal((await fx.get(fx.url(0, rev))).body.error, 'session_hub_rate_limited');
  time += 60000;
  for (let i = 0; i < 4; i++) assert.equal((await fx.get(fx.url(0, rev))).status, 200);
  assert.equal((await fx.get(fx.url(0, rev))).body.error, 'answer_budget_exceeded');
  assert.equal((await fx.list()).status, 200);
});

for (const mode of ['session-env', 'hub-env', 'override']) test(`answers off ${mode} precedes authentication and exhausted buckets, seals startup`, async t => {
  const saved = { global: process.env.PALANTIR_SESSION_ANSWERS, hub: process.env.PALANTIR_SESSION_HUB_ANSWERS };
  t.after(() => {
    for (const [name, value] of [['PALANTIR_SESSION_ANSWERS', saved.global], ['PALANTIR_SESSION_HUB_ANSWERS', saved.hub]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  process.env.PALANTIR_SESSION_ANSWERS = mode === 'session-env' ? '0' : '1';
  process.env.PALANTIR_SESSION_HUB_ANSWERS = mode === 'hub-env' ? '0' : '1';
  const fx = await answersFixture(t, mode === 'override' ? { sessionHubAnswers: false } : {});
  // Re-enabling env after boot cannot change route, argv or prompt.
  process.env.PALANTIR_SESSION_ANSWERS = '1'; process.env.PALANTIR_SESSION_HUB_ANSWERS = '1';
  const argv = fx.processFx.calls.at(-1).argv;
  assert.equal(argv[argv.indexOf('--allowedTools') + 1].includes('get_answer'), false);
  assert.equal(argv[argv.indexOf('--append-system-prompt') + 1].includes('get_answer'), false);
  assert.equal(fx.hub.state().promptVersion, 'c1-pa-pr-m-2');
  for (let i = 0; i < 31; i++) await fx.list();
  const currentToken = fx.hub.current(), current = fx.hub.current;
  let tokenChecks = 0, managerChecks = 0;
  fx.hub.current = () => { tokenChecks++; return current(); };
  const verify = fx.app.services.managerCapabilityTokenService.verify;
  fx.app.services.managerCapabilityTokenService.verify = (...args) => { managerChecks++; return verify(...args); };
  for (const token of [currentToken, 'retired', TOKEN, PM]) {
    const response = await supertest(fx.app).get(fx.url(0, '0'.repeat(16))).set('Authorization', `Bearer ${token}`);
    assert.equal(response.status, 404); assert.deepEqual(response.body, errorBody('answers_off'));
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal((await supertest(fx.app).get(fx.url(0, '0'.repeat(16))).set('Cookie', COOKIE)).body.error, 'answers_off');
  assert.equal(fx.calls.length, 0); assert.equal(tokenChecks, 0); assert.equal(managerChecks, 0);
});

test('app seals answers on after env mutation and service options cannot override the sealed value', async t => {
  const previous = process.env.PALANTIR_SESSION_HUB_ANSWERS;
  process.env.PALANTIR_SESSION_HUB_ANSWERS = '1';
  t.after(() => { if (previous === undefined) delete process.env.PALANTIR_SESSION_HUB_ANSWERS;
    else process.env.PALANTIR_SESSION_HUB_ANSWERS = previous; });
  const fx = await answersFixture(t, { sessionHubAnswers: true, sessionHubServiceOptions: { answers: false } });
  process.env.PALANTIR_SESSION_HUB_ANSWERS = '0';
  const rev = (await fx.list()).body.meta.rev;
  assert.equal((await fx.get(fx.url(0, rev))).status, 200);
  const argv = fx.processFx.calls.at(-1).argv;
  assert.ok(argv[argv.indexOf('--allowedTools') + 1].includes('get_answer'));
  assert.equal(fx.hub.state().promptVersion, 'c1-pa-pr-m-2a');
});

async function closeHostServer(server) {
  if (!server?.listening) return;
  const closed = new Promise((resolve, reject) => server.close(error => {
    if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
    else resolve();
  }));
  server.closeAllConnections();
  await within(closed, 'HTTP server cleanup');
}

async function abortHostGet(app, url, token, entered) {
  let server, client;
  const serverClosed = new Promise(resolve => {
    server = require('node:http').createServer((req, res) => {
      res.once('close', () => { if (!res.writableEnded) resolve(); });
      app(req, res);
    });
  });
  try {
    client = supertest(server).get(url).set('Authorization', `Bearer ${token}`);
    const response = client.then(value => value, error => error);
    await waitForEntry(entered, response);
    client.abort();
    assert.equal((await within(response, 'client abort')).code, 'ABORTED');
    await within(serverClosed, 'server disconnect'); // Wait for the actual TCP disconnect before settling the lookup.
  } finally {
    client?.abort();
    await closeHostServer(server);
  }
}

for (const outcome of ['success', 'exception']) test(`real client abort discards late answer ${outcome} without completion`, async t => {
  const fx = await answersFixture(t);
  const detail = await fx.get(`${BASE}/sessions/${fx.alpha.sessions[0].key}`), rev = detail.body.meta.rev;
  let resolve, reject, started;
  const entered = new Promise(done => { started = done; });
  fx.query(() => { started(); return new Promise((a, b) => { resolve = a; reject = b; }); });
  let completes = 0;
  const complete = fx.hub.completeAnswer;
  fx.hub.completeAnswer = (...args) => { completes++; return complete(...args); };
  try {
    await abortHostGet(fx.app, fx.url(0, rev), fx.hub.current(), entered);
    if (outcome === 'success') resolve(answerResult('한'.repeat(8000)));
    else reject(Object.assign(new Error('snapshot_unavailable'), { code: 'snapshot_unavailable', status: 503 }));
    await new Promise(done => setImmediate(done));
    assert.equal(completes, 0);
    // A newly returned key remains usable, so the abandoned result did not freeze the scope.
    await fx.list();
    fx.query(() => answerResult('x'.repeat(24576)));
    const first = await fx.get(fx.url(1, rev));
    assert.equal(first.status, 200); assert.equal(first.body.answer.budget_clipped, false);
    for (let i = 0; i < 3; i++) assert.equal((await fx.get(fx.url(0, rev))).status, 200);
    assert.equal((await fx.get(fx.url(0, rev))).body.error, 'answer_budget_exceeded');
    assert.equal(fx.calls.length, 5);
  } finally {
    resolve?.(answerResult());
    await new Promise(done => setImmediate(done));
  }
});

for (const method of ['list', 'search', 'detail']) test(`real aborted ${method} never grants an answer scope key`, async t => {
  const fx = await answersFixture(t);
  const { createSessionHubBroker } = require('../services/sessionHubBroker');
  const { createSessionHubRouter, createSessionHubTokenGate, sessionHubErrorHandler } = require('../routes/sessionHub');
  const broker = createSessionHubBroker({ state: fx.state }), delayed = { ...broker };
  let release, started;
  const gate = new Promise(done => { release = done; }), entered = new Promise(done => { started = done; });
  delayed[method] = async (...args) => { started(); await gate; return broker[method](...args); };
  const app = express();
  app.use(createSessionHubTokenGate(fx.hub));
  app.use(BASE, createSessionHubRouter({ state: fx.state, broker: delayed, hub: fx.hub, provider: fx.hub,
    answers: true, answerService: fx.answerService }));
  app.use(sessionHubErrorHandler);
  const url = method === 'list' ? `${BASE}/sessions` : method === 'search' ? `${BASE}/search?q=answer`
    : `${BASE}/sessions/${fx.alpha.sessions[0].key}`;
  try {
    await abortHostGet(app, url, fx.hub.current(), entered);
    release(); await new Promise(done => setImmediate(done)); await new Promise(done => setImmediate(done));
    const rev = (await broker.list({})).meta.rev;
    assert.equal((await fx.get(fx.url(0, rev))).body.error, 'answer_out_of_scope');
    assert.equal(fx.calls.length, 0);
    assert.equal((await fx.list()).status, 200);
    assert.equal((await fx.get(fx.url(0, rev))).status, 200);
  } finally {
    release();
    await new Promise(done => setImmediate(done));
  }
});
