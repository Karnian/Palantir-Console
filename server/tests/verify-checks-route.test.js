// G2 — verify_checks HTTP routes: actor-split (§6 command human-only), provenance,
// task assignment with cross-project guard.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const request = require('supertest');

const { createApp } = require('../app');
const { canonicalSpecHash, validateSpec } = require('../services/verifyCheckService');

// A2: keep exercising the PRODUCTION wiring (createApp + the real cookie/bearer
// auth middleware). A hand-rolled express app with a fake `req.auth` header would
// pass while the real auth middleware drifted — the actor split is the whole
// point of this file, so it must be the real one.
function setup(t, { goalActive = true, authToken = 'secret-token' } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-vc-route-'));
  const app = createApp({
    storageRoot: tmp, fsRoot: tmp, dbPath: path.join(tmp, 'test.db'),
    authResolverOpts: { hasKeychain: () => false }, authToken,
    goalFeatureActive: () => goalActive,
  });
  t.after(() => { try { if (app.shutdown) app.shutdown(); else app.closeDb(); } catch { /* */ } fs.rmSync(tmp, { recursive: true, force: true }); });
  const db = app.services._rawDb;
  db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'P1')").run();
  db.prepare("INSERT INTO projects (id, name) VALUES ('p2', 'P2')").run();
  db.prepare("INSERT INTO tasks (id, project_id, title) VALUES ('t1', 'p1', 'T1')").run();
  return app;
}

function attachSchedule(app, checkId, suffix = 'route') {
  const db = app.services._rawDb;
  const profileId = `op_precheck_${suffix}`;
  const instanceId = `oi_precheck_${suffix}`;
  const scheduleId = `os_precheck_${suffix}`;
  db.prepare('INSERT INTO operator_profiles (id, name) VALUES (?, ?)').run(profileId, `Precheck ${suffix}`);
  db.prepare('INSERT INTO operator_instances (id, profile_id) VALUES (?, ?)').run(instanceId, profileId);
  db.prepare(`
    INSERT INTO operator_schedules (
      id, operator_instance_id, name, prompt, codebase_project_id,
      rule_json, timezone, precheck_verify_check_id
    ) VALUES (?, ?, 'Precheck', 'Inspect', 'p1', ?, 'UTC', ?)
  `).run(scheduleId, instanceId, JSON.stringify({ kind: 'interval', minutes: 60 }), checkId);
  return scheduleId;
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
  // command assignment stays human-only (§6): goal mode is ON here, so a
  // bearer caller is 403 (lacks authority) — NOT 503 (feature unavailable).
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

test('goal OFF exposes artifact CRUD but hides command reads and blocks command writes', async (t) => {
  const app = setup(t, { goalActive: false });
  const db = app.services._rawDb;
  const commandId = Number(db.prepare(`
    INSERT INTO verify_checks (kind, project_id, name, spec_json, created_by)
    VALUES ('command', 'p1', 'hidden-command', ?, 'human')
  `).run(JSON.stringify({ command: 'echo hidden', timeout_ms: null })).lastInsertRowid);

  const artifact = (await request(app).post('/api/verify-checks').set(...COOKIE)
    .send({ kind: 'artifact', name: 'open-artifact', spec_json: { report: { min_chars: 1 } } })
    .expect(201)).body.check;
  await request(app).get(`/api/verify-checks/${artifact.id}`).set(...COOKIE).expect(200);
  await request(app).patch(`/api/verify-checks/${artifact.id}`).set(...COOKIE)
    .send({ name: 'renamed-artifact' }).expect(200);
  const list = await request(app).get('/api/verify-checks').set(...COOKIE).expect(200);
  assert.equal(list.body.checks.some((check) => check.id === commandId), false);
  assert.equal(list.body.checks.some((check) => check.id === artifact.id), true);
  await request(app).get(`/api/verify-checks/${commandId}`).set(...COOKIE).expect(404);

  await request(app).post('/api/verify-checks').set(...COOKIE)
    .send({ kind: 'command', project_id: 'p1', name: 'blocked', spec_json: { command: 'true' } })
    .expect(503);
  await request(app).patch(`/api/verify-checks/${commandId}`).set(...COOKIE)
    .send({ name: 'blocked-rename' }).expect(503);
  await request(app).delete(`/api/verify-checks/${commandId}`).set(...COOKIE).expect(503);
  await request(app).post('/api/verify-checks/assign').set(...COOKIE)
    .send({ task_id: 'missing', check_id: null }).expect(503);

  await request(app).delete(`/api/verify-checks/${artifact.id}`).set(...COOKIE).expect(200);
});

test('list + get + delete (command delete human-only)', async (t) => {
  const app = setup(t);
  const c = (await request(app).post('/api/verify-checks').set(...COOKIE)
    .send({ kind: 'command', project_id: 'p1', name: 'c', spec_json: { command: 'x' } }).expect(201)).body.check;
  const list = await request(app).get('/api/verify-checks?project_id=p1').set(...COOKIE).expect(200);
  assert.ok(list.body.checks.some((x) => x.id === c.id));
  // goal mode is ON here → a bearer caller lacks authority (403), not 503.
  await request(app).delete(`/api/verify-checks/${c.id}`).set(...BEARER).expect(403);
  await request(app).delete(`/api/verify-checks/${c.id}`).set(...COOKIE).expect(200);
});

test('PATCH attest promotes only with the reviewed canonical spec hash', async (t) => {
  const app = setup(t);
  const spec = { report: { min_chars: 7 } };
  // INDEPENDENT fixture: hashing through the production helper would move in
  // lock-step with a broken implementation and prove nothing. This is sha256 of
  // the canonical form the contract promises.
  const EXPECTED_HASH = createHash('sha256')
    .update(JSON.stringify({ files: [], report: { min_chars: 7 } })).digest('hex');
  assert.equal(canonicalSpecHash(validateSpec('artifact', spec)), EXPECTED_HASH,
    'canonical spec hash must equal an independently computed sha256');

  const c = (await request(app).post('/api/verify-checks').set(...BEARER)
    .send({ kind: 'artifact', project_id: 'p1', name: 'attest-route', spec_json: spec })
    .expect(201)).body.check;

  const renamed = await request(app).patch(`/api/verify-checks/${c.id}`).set(...COOKIE)
    .send({ name: 'human-renamed-only' }).expect(200);
  assert.equal(renamed.body.check.created_by, 'operator');
  await request(app).patch(`/api/verify-checks/${c.id}`).set(...BEARER)
    .send({ attest: true, spec_hash: EXPECTED_HASH })
    .expect(403);
  await request(app).patch(`/api/verify-checks/${c.id}`).set(...COOKIE)
    .send({ attest: true, spec_hash: '0'.repeat(64) }).expect(409);
  const attested = await request(app).patch(`/api/verify-checks/${c.id}`).set(...COOKIE)
    .send({ attest: true, spec_hash: EXPECTED_HASH })
    .expect(200);
  assert.equal(attested.body.check.created_by, 'human');

  // A STALE hash (the spec moved on after review) must be refused, or attest
  // degrades into "any 64 hex chars promotes".
  await request(app).patch(`/api/verify-checks/${c.id}`).set(...COOKIE)
    .send({ spec_json: { report: { min_chars: 9 } } }).expect(200);
  await request(app).patch(`/api/verify-checks/${c.id}`).set(...COOKIE)
    .send({ attest: true, spec_hash: EXPECTED_HASH }).expect(409);
});

test('is_default flip cannot launder collateral writes past the actor gates', async (t) => {
  const app = setup(t);
  const db = app.services._rawDb;
  // An ATTACHED artifact holding the project default. Editing it directly is
  // cookie-only — so clearing its default from a bearer request must be too.
  const attachedId = Number(db.prepare(`
    INSERT INTO verify_checks (kind, project_id, name, spec_json, created_by, is_default)
    VALUES ('artifact', 'p1', 'default-attached', ?, 'human', 1)
  `).run(JSON.stringify({ files: [], report: { min_chars: 1 } })).lastInsertRowid);
  attachSchedule(app, attachedId, 'default');

  await request(app).post('/api/verify-checks').set(...BEARER)
    .send({ kind: 'artifact', project_id: 'p1', name: 'usurper', is_default: true,
      spec_json: { report: { min_chars: 2 } } })
    .expect(403);
  assert.equal(db.prepare('SELECT is_default FROM verify_checks WHERE id = ?').get(attachedId).is_default, 1,
    'attached default must survive a bearer default-flip attempt');

  // The same flip from a human cookie is legitimate.
  await request(app).post('/api/verify-checks').set(...COOKIE)
    .send({ kind: 'artifact', project_id: 'p1', name: 'human-usurper', is_default: true,
      spec_json: { report: { min_chars: 3 } } })
    .expect(201);
  assert.equal(db.prepare('SELECT is_default FROM verify_checks WHERE id = ?').get(attachedId).is_default, 0);
});

test('attached artifact is immutable to bearer; cookie can update but FK delete is 409', async (t) => {
  const app = setup(t);
  const c = (await request(app).post('/api/verify-checks').set(...COOKIE)
    .send({ kind: 'artifact', project_id: 'p1', name: 'attached-route', spec_json: { report: { min_chars: 1 } } })
    .expect(201)).body.check;
  const scheduleId = attachSchedule(app, c.id);

  await request(app).patch(`/api/verify-checks/${c.id}`).set(...BEARER)
    .send({ name: 'blocked' }).expect(403);
  await request(app).delete(`/api/verify-checks/${c.id}`).set(...BEARER).expect(403);
  await request(app).patch(`/api/verify-checks/${c.id}`)
    .send({ name: 'blocked-without-auth' }).expect(403);
  await request(app).delete(`/api/verify-checks/${c.id}`).expect(403);
  await request(app).patch(`/api/verify-checks/${c.id}`).set(...COOKIE)
    .send({ name: 'human-update' }).expect(200);
  await request(app).delete(`/api/verify-checks/${c.id}`).set(...COOKIE)
    .expect(409)
    .expect((res) => assert.match(res.body.error, /detach.*schedule/i));

  app.services._rawDb.prepare(
    'UPDATE operator_schedules SET precheck_verify_check_id = NULL WHERE id = ?',
  ).run(scheduleId);
  await request(app).patch(`/api/verify-checks/${c.id}`).set(...BEARER)
    .send({ name: 'detached-operator-update' }).expect(200);
  await request(app).delete(`/api/verify-checks/${c.id}`).set(...BEARER).expect(200);
});

test('attached artifact is also immutable to auth-disabled none actor; unreferenced remains open', async (t) => {
  // `req.auth.method === 'none'` only exists when auth is DISABLED (no token).
  // With a token configured the middleware 401s before the route, so this actor
  // must be produced the way production produces it: authToken null.
  const app = setup(t, { authToken: null });
  const db = app.services._rawDb;
  const attachedId = Number(db.prepare(`
    INSERT INTO verify_checks (kind, project_id, name, spec_json, created_by)
    VALUES ('artifact', 'p1', 'none-attached', ?, 'human')
  `).run(JSON.stringify({ files: [], report: { min_chars: 1 } })).lastInsertRowid);
  attachSchedule(app, attachedId, 'none');

  await request(app).patch(`/api/verify-checks/${attachedId}`)
    .send({ name: 'blocked-none' }).expect(403);
  await request(app).delete(`/api/verify-checks/${attachedId}`).expect(403);

  const freeId = Number(db.prepare(`
    INSERT INTO verify_checks (kind, project_id, name, spec_json, created_by)
    VALUES ('artifact', 'p1', 'none-free', ?, 'operator')
  `).run(JSON.stringify({ files: [], report: { min_chars: 1 } })).lastInsertRowid);
  await request(app).patch(`/api/verify-checks/${freeId}`)
    .send({ name: 'none-update-allowed' }).expect(200);
  await request(app).delete(`/api/verify-checks/${freeId}`).expect(200);
});
