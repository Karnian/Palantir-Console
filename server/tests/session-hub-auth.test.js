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
        `${BASE}/chat/start`, `${BASE}/chat/message`, `${BASE}/unknown`]) {
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
