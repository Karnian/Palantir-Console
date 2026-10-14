'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, BODY } = require('./helpers/answer-query-fixture.cjs');
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
    assert.equal(denied.status, 403, token); assert.equal(denied.headers['cache-control'], 'no-store');
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
  const fx = setup(t, 'hang'); const app = appFor(fx);
  const task = app.answerQueryService.query(fx.query());
  error(await get(app, fx.url(fx.query('alpha', 1))), 'answer_busy', 429);
  const closing = app.shutdown(); assert.equal(app.shutdown(), closing); await closing;
  assert.equal((await task).status, 'unavailable');
  for (const call of fx.calls()) assert.throws(() => process.kill(-call.pid, 0), error => error.code === 'ESRCH');
});
