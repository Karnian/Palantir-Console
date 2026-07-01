'use strict';

// Operator Profile entity (PF-1) — CRUD service + /api/operator/profiles route.
// HTTP-level via supertest (route always mounted; not flag-gated).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');
const { createApp } = require('../app');

async function makeApp(t) {
  const mk = (p) => fs.mkdtemp(path.join(os.tmpdir(), p));
  const storageRoot = await mk('pal-s-'); const fsRoot = await mk('pal-f-'); const dbDir = await mk('pal-d-');
  const app = createApp({ storageRoot, fsRoot, opencodeBin: 'opencode', dbPath: path.join(dbDir, 'test.db'), authToken: null });
  t.after(async () => {
    if (app.shutdown) app.shutdown();
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
    await fs.rm(dbDir, { recursive: true, force: true });
  });
  return app;
}
const B = '/api/operator/profiles';

test('POST create → 201 with hydrated profile', async (t) => {
  const app = await makeApp(t);
  const res = await request(app).post(B).send({ name: 'sec-reviewer', description: '보안 검토', persona: 'You review security.', capabilities: ['registry_metadata_search'] });
  assert.equal(res.status, 201);
  assert.ok(res.body.profile.id.startsWith('op_'));
  assert.equal(res.body.profile.name, 'sec-reviewer');
  assert.deepEqual(res.body.profile.capabilities, ['registry_metadata_search']);
  assert.equal(res.body.profile.persona, 'You review security.');
});

test('GET list + GET :id', async (t) => {
  const app = await makeApp(t);
  const c = await request(app).post(B).send({ name: 'p1' });
  const id = c.body.profile.id;
  const list = await request(app).get(B);
  assert.equal(list.status, 200);
  assert.ok(list.body.profiles.some((p) => p.id === id));
  const one = await request(app).get(`${B}/${id}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.profile.name, 'p1');
});

test('PATCH updates fields; DELETE then 404', async (t) => {
  const app = await makeApp(t);
  const c = await request(app).post(B).send({ name: 'p2', capabilities: [] });
  const id = c.body.profile.id;
  const upd = await request(app).patch(`${B}/${id}`).send({ persona: 'new persona', capabilities: ['registry_metadata_search'] });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.profile.persona, 'new persona');
  assert.deepEqual(upd.body.profile.capabilities, ['registry_metadata_search']);
  assert.equal(upd.body.profile.name, 'p2'); // unchanged
  const del = await request(app).delete(`${B}/${id}`);
  assert.equal(del.status, 200);
  assert.equal((await request(app).get(`${B}/${id}`)).status, 404);
});

test('duplicate name → 409', async (t) => {
  const app = await makeApp(t);
  await request(app).post(B).send({ name: 'dup' });
  const res = await request(app).post(B).send({ name: 'dup' });
  assert.equal(res.status, 409);
});

test('validation: missing name 400, unknown cap 400, non-array caps 400, oversized persona 400', async (t) => {
  const app = await makeApp(t);
  assert.equal((await request(app).post(B).send({ description: 'x' })).status, 400);
  assert.equal((await request(app).post(B).send({ name: 'a', capabilities: ['bogus'] })).status, 400);
  assert.equal((await request(app).post(B).send({ name: 'b', capabilities: 'shell' })).status, 400);
  assert.equal((await request(app).post(B).send({ name: 'c', persona: 'x'.repeat(2001) })).status, 400);
});

test('GET :id unknown → 404', async (t) => {
  const app = await makeApp(t);
  assert.equal((await request(app).get(`${B}/nope`)).status, 404);
});

test('capabilities: empty array valid; duplicates deduped', async (t) => {
  const app = await makeApp(t);
  const empty = await request(app).post(B).send({ name: 'empty', capabilities: [] });
  assert.equal(empty.status, 201);
  assert.deepEqual(empty.body.profile.capabilities, []);
  const dup = await request(app).post(B).send({ name: 'dupcaps', capabilities: ['registry_metadata_search', 'registry_metadata_search', 'project_read'] });
  assert.equal(dup.status, 201);
  assert.deepEqual(dup.body.profile.capabilities, ['registry_metadata_search', 'project_read']);
});

test('PATCH duplicate name → 409; PATCH unknown → 404', async (t) => {
  const app = await makeApp(t);
  await request(app).post(B).send({ name: 'taken' });
  const other = await request(app).post(B).send({ name: 'other' });
  const clash = await request(app).patch(`${B}/${other.body.profile.id}`).send({ name: 'taken' });
  assert.equal(clash.status, 409);
  assert.equal((await request(app).patch(`${B}/nope`).send({ persona: 'x' })).status, 404);
});

test('non-object body → 400 (R2 MINOR: no silent no-op)', async (t) => {
  const app = await makeApp(t);
  assert.equal((await request(app).post(B).send(['a', 'b'])).status, 400);
  const c = await request(app).post(B).send({ name: 'obj-guard' });
  // PATCH with an array body must not silently no-op
  assert.equal((await request(app).patch(`${B}/${c.body.profile.id}`).send([1, 2])).status, 400);
});

test('read filters bogus stored capabilities (R2 MINOR defensive)', async (t) => {
  const app = await makeApp(t);
  // Direct DB write bypassing validation — the SQL CHECK only enforces array shape.
  app.services._rawDb.prepare(
    "INSERT INTO operator_profiles (id, name, capabilities_json) VALUES ('op_bad', 'badprof', ?)"
  ).run(JSON.stringify(['registry_metadata_search', 'bogus_cap', 123]));
  const res = await request(app).get(`${B}/op_bad`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.profile.capabilities, ['registry_metadata_search']);
});

test('service exposed on app.services', async (t) => {
  const app = await makeApp(t);
  assert.equal(typeof app.services.operatorProfileService.createProfile, 'function');
});
