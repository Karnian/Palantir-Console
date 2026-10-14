'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, until, BODY } = require('./helpers/answer-query-fixture.cjs');
const { request, managerToken, COOKIE, TOKEN, PM } = require('./helpers/session-hub-fixture.cjs');
const get = (app, url) => request(app).get(url).set('Cookie', COOKIE);
function appFor(fx, extra = {}) {
  return fx.app({ answerQueryServiceOptions: fx.options, snapshotRefreshServiceOptions: {
    env: { ...fx.env, PALANTIR_SNAPSHOT_TARGETS: '[]' } }, ...extra });
}
function error(response, code, status) {
  assert.equal(response.status, status); assert.deepEqual(response.body, { error: code, reason: code });
  assert.equal(response.headers['cache-control'], 'no-store');
}

test('cookie-only matrix, explicit method rejection, same-site auth, and no-store on success/errors', async t => {
  const fx = setup(t); const app = appFor(fx, { sessionHubTokenProvider: { current: () => 'hub-live' } });
  const response = await get(app, fx.url()); assert.equal(response.status, 200);
  assert.equal(response.body.text, BODY); assert.equal(response.headers['cache-control'], 'no-store');
  const top = managerToken(app, 'top', 'top'); const operator = managerToken(app, 'operator', 'operator:answers');
  const worker = app.services.workerProposalTokenService.mint('answer-run', { projectId: 'answer-fixture' });
  for (const token of [TOKEN, PM, 'hub-live', top, operator, worker, 'bad']) {
    const denied = await request(app).get(fx.url()).set('Authorization', `Bearer ${token}`);
    const reason = [TOKEN, PM].includes(token) ? 'cookie auth required'
      : token === 'hub-live' ? 'forbidden' : 'authentication_failed';
    error(denied, reason, 403);
  }
  const mixed = await get(app, fx.url()).set('Authorization', 'Bearer bad');
  assert.equal(mixed.status, 403); assert.equal(mixed.headers['cache-control'], 'no-store');
  const crossSite = await get(app, fx.url()).set('Sec-Fetch-Site', 'cross-site');
  assert.equal(crossSite.status, 403); assert.equal(crossSite.headers['cache-control'], 'no-store');
  const wrongOrigin = await get(app, fx.url()).set('Origin', 'http://foreign.example');
  assert.equal(wrongOrigin.status, 403);
  for (const method of ['head', 'post', 'put', 'patch', 'delete', 'options']) {
    const result = await request(app)[method](fx.url()).set('Cookie', COOKIE).set('Origin', 'http://localhost');
    assert.equal(result.status, 405, method); assert.equal(result.headers.allow, 'GET');
    assert.equal(result.headers['cache-control'], 'no-store');
  }
  const malformedPost = await request(app).post(fx.url()).set('Cookie', COOKIE)
    .set('Origin', 'http://localhost').send('{broken');
  assert.equal(malformedPost.status, 405);
  assert.equal(fx.spawns(), 1);
});

test('all query parameters must occur once as strings; missing, arrays, unknown and unsafe values rejected', async t => {
  const fx = setup(t); const app = appFor(fx); const good = new URLSearchParams(fx.url().split('?')[1]);
  const invalid = ['/api/observe/answers', fx.url() + '&extra=1', fx.url() + '&machine=alpha',
    fx.url() + '&key=x', fx.url() + '&instruction=claude:s:ux', fx.url() + '&rev=' + 'b'.repeat(64),
    fx.url() + '&machine[]=alpha', fx.url() + '&key[x]=a'];
  for (const key of ['machine', 'key', 'instruction', 'rev']) {
    const missing = new URLSearchParams(good); missing.delete(key); invalid.push('/api/observe/answers?' + missing);
    for (const value of ['', '../bad', key === 'rev' ? 'A'.repeat(64) : 'bad space']) {
      const query = new URLSearchParams(good); query.set(key, value); invalid.push('/api/observe/answers?' + query);
    }
  }
  for (const url of invalid) error(await get(app, url), 'invalid_query', 400);
  assert.equal(fx.spawns(), 0);
});

test('not-found session/instruction and mixed session id, stale rev, unavailable snapshot', async t => {
  const fx = setup(t); const app = appFor(fx); const input = fx.query();
  for (const patch of [{ machineId: 'absent' }, { sessionKey: 'absent' }, { instructionId: 'claude:missing:u1' },
    { sessionKey: fx.alpha.sessions.find(row => row.key !== input.sessionKey).key }]) {
    error(await get(app, fx.url({ ...input, ...patch })), 'not_found', 404);
  }
  error(await get(app, fx.url({ ...input, rev: '0'.repeat(64) })), 'snapshot_changed', 409);
  fs.writeFileSync(path.join(fx.dir, 'alpha.json'), '{}');
  error(await get(app, fx.url(input)), 'snapshot_unavailable', 503); assert.equal(fx.spawns(), 0);
});

test('legacy snapshot without file_fp stays valid on board/detail and query does not spawn', async t => {
  const fx = setup(t); fx.alpha.sessions.forEach(row => { delete row.file_fp; }); fx.write(fx.alpha);
  const app = appFor(fx); const input = fx.query();
  const response = await get(app, fx.url(input)); assert.equal(response.status, 200);
  assert.equal(response.body.status, 'target_changed'); assert.equal(response.body.reason, 'file_missing');
  assert.equal(fx.spawns(), 0);
  const list = await get(app, '/api/observe/snapshots'); assert.equal(list.status, 200); assert.equal(list.body.answers, true);
  assert.equal((await get(app, '/api/observe/snapshots/alpha?sha256=' + input.rev)).status, 200);
  assert.equal((await get(app, '/api/session-hub/sessions')).status, 200);
});

test('switch is sealed at boot, defaults on, env off and option overrides, disabled service never constructed', async t => {
  const fx = setup(t);
  const previous = process.env.PALANTIR_SESSION_ANSWERS;
  t.after(() => { if (previous === undefined) delete process.env.PALANTIR_SESSION_ANSWERS; else process.env.PALANTIR_SESSION_ANSWERS = previous; });
  delete process.env.PALANTIR_SESSION_ANSWERS; const defaultOn = appFor(fx);
  process.env.PALANTIR_SESSION_ANSWERS = '0'; const envOff = appFor(fx);
  const forcedOn = appFor(fx, { sessionAnswers: true });
  process.env.PALANTIR_SESSION_ANSWERS = '1'; const forcedOff = appFor(fx, { sessionAnswers: false,
    answerQueryServiceOptions: { get env() { throw new Error('off must not construct service'); } } });
  for (const [app, on] of [[defaultOn, true], [envOff, false], [forcedOn, true], [forcedOff, false]]) {
    assert.equal((await get(app, '/api/observe/snapshots')).body.answers, on);
    assert.equal(app.answerQueryService !== null, on);
    const answer = await get(app, fx.url());
    if (on) { assert.equal(answer.status, 200); assert.equal(answer.body.text, BODY); }
    else error(answer, 'answers_off', 404);
  }
});

test('execution failures are HTTP 200 unavailable, answers never enter app DB or observe/staging', async t => {
  const fx = setup(t, 'diag'); const app = appFor(fx);
  const result = await get(app, fx.url()); assert.equal(result.status, 200);
  assert.equal(result.body.status, 'unavailable'); assert.equal(result.body.reason, 'exec_failed');
  // Real final response then scan every persisted app/snapshot file, including SQLite and staging.
  const final = appFor(fx, { answerQueryServiceOptions: { ...fx.options, env: { ...fx.env, FAKE_ANSWER_MODE: 'ok' } } });
  assert.equal((await get(final, fx.url())).body.text, BODY);
  for (const name of fs.readdirSync(fx.root, { recursive: true })) {
    const filename = path.join(fx.root, name);
    if (fs.statSync(filename).isFile()) assert.equal(fs.readFileSync(filename).includes(BODY), false, filename);
  }
});

test('route maps service busy error to 429; app shutdown awaits active query group removal', async t => {
  let releaseReap = false, sawGone = false;
  const fx = setup(t, 'hang', { timeoutMs: 60000, reapOptions: { termMs: 20, reapMs: 3000, pollMs: 5,
    kill(pgid, signal) {
      try { return process.kill(pgid, signal); }
      catch (error) {
        if (error.code === 'ESRCH' && signal === 0 && !releaseReap) { sawGone = true; return; }
        throw error;
      }
    } } }); const app = appFor(fx);
  let settled = false;
  const task = app.answerQueryService.query(fx.query()).finally(() => { settled = true; });
  await until(() => fx.calls().length >= 1);
  const calls = fx.calls(); assert.ok(calls.length >= 1, 'the hang fixture must be running before shutdown');
  assert.equal(settled, false);
  error(await get(app, fx.url(fx.query('alpha', 1))), 'answer_busy', 429);
  const begun = Date.now();
  const closing = app.shutdown(); assert.equal(app.shutdown(), closing);
  let shutdownSettled = false; closing.then(() => { shutdownSettled = true; });
  try {
    await until(() => sawGone);
    assert.equal(settled, false, 'answer must await the held reap confirmation');
    assert.equal(shutdownSettled, false, 'shutdown must await the held answer task');
  } finally { releaseReap = true; }
  await closing;
  assert.equal(settled, true, 'shutdown must await answer settlement');
  for (const call of calls) assert.throws(() => process.kill(-call.pid, 0), error => error.code === 'ESRCH');
  assert.ok(Date.now() - begun < 5000, 'shutdown must finish before the 30 second CLI timeout');
  const result = await task; assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'exec_failed');
});

test('all observe paths reject any Authorization header without cookie fallback', async t => {
  const fx = setup(t); const app = appFor(fx);
  for (const url of ['/api/observe/snapshots', '/api/observe/snapshots/alpha', fx.url(), '/api/observe/unknown']) {
    for (const authorization of ['bearer bad', `BEARER ${TOKEN}`, 'Basic xxx', '']) {
      error(await get(app, url).set('Authorization', authorization), 'cookie auth required', 403);
      error(await get(app, url).set('Authorization', authorization).send('{broken'), 'cookie auth required', 403);
    }
  }
  assert.equal((await get(app, '/api/observe/snapshots')).status, 200);
  assert.equal((await get(app, fx.url())).status, 200);
  assert.equal(fx.spawns(), 1);
});

test('Authorization is rejected before global auth even without a cookie, and observe off keeps priority', async t => {
  const fx = setup(t); const app = appFor(fx);
  const off = appFor(fx, { observeSnapshotDir: null, sessionHubTokenProvider: { current: () => 'hub-live' } });
  const headers = ['bearer x', `BEARER ${TOKEN}`, 'Basic x', `Bearer ${TOKEN}`, ''];
  for (const url of ['/api/observe/snapshots', fx.url()]) {
    for (const authorization of headers) {
      error(await request(app).get(url).set('Authorization', authorization), 'cookie auth required', 403);
      for (const method of ['get', 'post']) {
        const call = request(off)[method](url).set('Authorization', authorization).send('{broken');
        error(await call, 'observe_off', 404);
      }
    }
    error(await request(off).get(url).set('Authorization', 'Bearer hub-live'), 'observe_off', 404);
  }
  assert.equal((await get(app, '/api/observe/snapshots')).status, 200);
  assert.equal((await get(app, fx.url())).status, 200); assert.equal(fx.spawns(), 1);
});

test('raw answer query rejects truncation padding, empty fragments, duplicate names and decoding failures', async t => {
  const fx = setup(t); const app = appFor(fx);
  const good = fx.url(), query = good.slice(good.indexOf('?') + 1), base = '/api/observe/answers?';
  const invalid = [
    good + '&'.repeat(1000) + 'extra=1',
    good + '&machine=alpha',
    good + '&',
    base + query.replace(/key=[^&]+/, ''),
    base + query.replace(/rev=[^&]+/, 'rev=' + '0'.repeat(2100)),
    base + query.replace(/machine=[^&]+/, 'machine=' + 'é'.repeat(1030)),
    base + query.replace(/machine=[^&]+/, 'machine=%ZZ'),
    base + query.replace(/machine=[^&]+/, 'machine=%E0%A4%A'),
    base + query.replace(/machine=[^&]+/, 'machine=alpha=extra'),
    base + query.replace(/machine=[^&]+/, 'machine'),
    base + query.replace(/key=[^&]+/, 'machine=alpha'),
    base + query.replace('machine=', '%6Dachine=')
  ];
  for (const url of invalid) error(await get(app, url), 'invalid_query', 400);
  assert.equal(fx.spawns(), 0);
  assert.equal((await get(app, good)).status, 200, 'valid percent-encoded values must still work');
  assert.equal(fx.spawns(), 1);
});

test('URL-encoded 128-character machine and matching key fit the 2048-byte query limit', async t => {
  const fx = setup(t);
  const machineId = 'm' + ':'.repeat(127), sessionKey = machineId;
  const app = appFor(fx, { answerQueryServiceOptions: { ...fx.options, env: { ...fx.env,
    PALANTIR_SNAPSHOT_TARGETS: JSON.stringify([{ name: 'long', kind: 'local', machineId }]) } } });
  const snapshot = structuredClone(fx.alpha); snapshot.machine.id = machineId;
  snapshot.sessions = [snapshot.sessions[0]]; snapshot.sessions[0].key = sessionKey;
  snapshot.instructions = [snapshot.instructions.find(row => row.session_key === fx.alpha.sessions[0].key)];
  snapshot.instructions[0].session_key = sessionKey; fx.write(snapshot);
  const input = fx.query(machineId), url = fx.url(input);
  const bytes = Buffer.byteLength(url.slice(url.indexOf('?') + 1));
  assert.ok(bytes > 512 && bytes <= 2048);
  // Receiver rejects the fixture's machine id; request parsing and snapshot selection succeed.
  const response = await get(app, url); assert.equal(response.status, 200);
  assert.equal(response.body.status, 'unavailable'); assert.equal(response.body.reason, 'exec_failed');
  assert.equal(fx.spawns(), 1);
});
