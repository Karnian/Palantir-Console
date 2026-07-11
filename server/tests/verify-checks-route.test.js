// G2 — verify_checks HTTP routes: actor-split (§6 command human-only), provenance,
// task assignment with cross-project guard.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');

const { createApp } = require('../app');

function setup(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-vc-route-'));
  const app = createApp({
    storageRoot: tmp, fsRoot: tmp, dbPath: path.join(tmp, 'test.db'),
    authResolverOpts: { hasKeychain: () => false }, authToken: 'secret-token',
  });
  t.after(() => { try { if (app.shutdown) app.shutdown(); else app.closeDb(); } catch { /* */ } fs.rmSync(tmp, { recursive: true, force: true }); });
  const db = app.services._rawDb;
  db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'P1')").run();
  db.prepare("INSERT INTO projects (id, name) VALUES ('p2', 'P2')").run();
  db.prepare("INSERT INTO tasks (id, project_id, title) VALUES ('t1', 'p1', 'T1')").run();
  return app;
}

const COOKIE = ['Cookie', 'palantir_token=secret-token'];
const BEARER = ['Authorization', 'Bearer secret-token'];

test('command check: cookie creates it; bearer is 403 (§6 human-only)', async (t) => {
  const app = setup(t);
  await request(app).post('/api/verify-checks').set(...BEARER)
    .send({ kind: 'command', project_id: 'p1', name: 'cmd', spec_json: { command: 'npm test' } })
    .expect(403);
  const ok = await request(app).post('/api/verify-checks').set(...COOKIE)
    .send({ kind: 'command', project_id: 'p1', name: 'cmd', spec_json: { command: 'npm test' } })
    .expect(201);
  assert.equal(ok.body.check.created_by, 'human');
  assert.equal(ok.body.check.kind, 'command');
});

test('artifact check: bearer (Operator) can create it, provenance operator', async (t) => {
  const app = setup(t);
  const r = await request(app).post('/api/verify-checks').set(...BEARER)
    .send({ kind: 'artifact', name: 'art', spec_json: { report: { min_chars: 5 } }, created_by: 'human' /* ignored */ })
    .expect(201);
  assert.equal(r.body.check.created_by, 'operator', 'bearer → operator provenance, request body ignored');
});

test('assign: command check requires cookie + project match', async (t) => {
  const app = setup(t);
  const cmd = (await request(app).post('/api/verify-checks').set(...COOKIE)
    .send({ kind: 'command', project_id: 'p1', name: 'cmd', spec_json: { command: 'x' } }).expect(201)).body.check;
  // bearer cannot assign a command check
  await request(app).post('/api/verify-checks/assign').set(...BEARER)
    .send({ task_id: 't1', check_id: cmd.id }).expect(403);
  // cookie assigns it (p1 check → p1 task, matches)
  const ok = await request(app).post('/api/verify-checks/assign').set(...COOKIE)
    .send({ task_id: 't1', check_id: cmd.id }).expect(200);
  assert.equal(ok.body.task.verify_check_id, cmd.id);
  // cross-project command check is rejected
  const cmd2 = (await request(app).post('/api/verify-checks').set(...COOKIE)
    .send({ kind: 'command', project_id: 'p2', name: 'cmd2', spec_json: { command: 'x' } }).expect(201)).body.check;
  await request(app).post('/api/verify-checks/assign').set(...COOKIE)
    .send({ task_id: 't1', check_id: cmd2.id }).expect(400);
  // clear assignment
  const cleared = await request(app).post('/api/verify-checks/assign').set(...COOKIE)
    .send({ task_id: 't1', check_id: null }).expect(200);
  assert.equal(cleared.body.task.verify_check_id, null);
});

test('list + get + delete (command delete human-only)', async (t) => {
  const app = setup(t);
  const c = (await request(app).post('/api/verify-checks').set(...COOKIE)
    .send({ kind: 'command', project_id: 'p1', name: 'c', spec_json: { command: 'x' } }).expect(201)).body.check;
  const list = await request(app).get('/api/verify-checks?project_id=p1').set(...COOKIE).expect(200);
  assert.ok(list.body.checks.some((x) => x.id === c.id));
  await request(app).delete(`/api/verify-checks/${c.id}`).set(...BEARER).expect(403);
  await request(app).delete(`/api/verify-checks/${c.id}`).set(...COOKIE).expect(200);
});
