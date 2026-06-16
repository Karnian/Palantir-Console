// ML PR4a — post-hoc correction: memoryService CRUD (update/archive/restore/
// review/pin) + PATCH /memory/:id + GET /memory/:id/provenance.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');

const { createDatabase } = require('../db/database');
const { createMemoryService } = require('../services/memoryService');
const { createApp } = require('../app');

function setupDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-crud-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 'test.db'));
  migrate();
  t.after(() => { try { close(); } catch { /* */ } fs.rmSync(dir, { recursive: true, force: true }); });
  db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'P')").run();
  return db;
}

function setupApp(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-crud-app-'));
  const app = createApp({
    storageRoot: tmp, fsRoot: tmp, dbPath: path.join(tmp, 'test.db'),
    authResolverOpts: { hasKeychain: () => false }, authToken: 'secret-token',
  });
  t.after(() => { try { if (app.shutdown) app.shutdown(); else app.closeDb(); } catch { /* */ } fs.rmSync(tmp, { recursive: true, force: true }); });
  app.services._rawDb.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'P')").run();
  return app;
}

const COOKIE = ['Cookie', 'palantir_token=secret-token'];

// --------------------------------------------------------------------------
// memoryService CRUD (unit)
// --------------------------------------------------------------------------

test('migration 028: archived_at + pinned columns exist', (t) => {
  const db = setupDb(t);
  const cols = db.prepare('PRAGMA table_info(memory_items)').all().map((c) => c.name);
  assert.ok(cols.includes('archived_at'));
  assert.ok(cols.includes('pinned'));
});

test('updateMemoryContent: edits active content + bumps revision', (t) => {
  const svc = createMemoryService(setupDb(t));
  const item = svc.createMemoryItem({ projectId: 'p1', kind: 'pitfall', content: 'old content here', origin: 'human' });
  const rev0 = svc.getRevision('p1');
  const updated = svc.updateMemoryContent({ id: item.id, content: 'new content here' });
  assert.equal(updated.content, 'new content here');
  assert.ok(svc.getRevision('p1') > rev0, 'content edit bumps revision');
});

test('archiveMemory / restoreMemory: status, archived_at, revision, list exclusion', (t) => {
  const svc = createMemoryService(setupDb(t));
  const item = svc.createMemoryItem({ projectId: 'p1', kind: 'pitfall', content: 'x content here', origin: 'human' });
  const r1 = svc.getRevision('p1');
  const arch = svc.archiveMemory(item.id);
  assert.equal(arch.status, 'archived');
  assert.ok(arch.archived_at);
  assert.ok(svc.getRevision('p1') > r1, 'archive bumps revision');
  assert.equal(svc.listForProject('p1').length, 0, 'archived item excluded from active list');
  const r2 = svc.getRevision('p1');
  const rest = svc.restoreMemory(item.id);
  assert.equal(rest.status, 'active');
  assert.equal(rest.archived_at, null);
  assert.ok(svc.getRevision('p1') > r2, 'restore bumps revision');
  assert.equal(svc.listForProject('p1').length, 1);
});

test('archiveMemory: not-active / missing -> null', (t) => {
  const svc = createMemoryService(setupDb(t));
  assert.equal(svc.archiveMemory('ghost'), null);
});

test('updateMemoryContent: duplicate active content -> MEMORY_DUPLICATE', (t) => {
  const svc = createMemoryService(setupDb(t));
  svc.createMemoryItem({ projectId: 'p1', kind: 'pitfall', content: 'existing content', origin: 'human' });
  const b = svc.createMemoryItem({ projectId: 'p1', kind: 'pitfall', content: 'other content', origin: 'human' });
  assert.throws(() => svc.updateMemoryContent({ id: b.id, content: 'existing content' }), (e) => e.code === 'MEMORY_DUPLICATE');
});

test('markReviewed / setPinned: no revision bump (injected text unchanged)', (t) => {
  const svc = createMemoryService(setupDb(t));
  const item = svc.createMemoryItem({ projectId: 'p1', kind: 'pitfall', content: 'content here', origin: 'human' });
  const rev = svc.getRevision('p1');
  assert.ok(svc.markReviewed(item.id).reviewed_at);
  assert.equal(svc.setPinned({ id: item.id, pinned: true }).pinned, 1);
  assert.equal(svc.setPinned({ id: item.id, pinned: false }).pinned, 0);
  assert.equal(svc.getRevision('p1'), rev, 'review/pin must not bump revision');
});

// --------------------------------------------------------------------------
// PATCH + provenance (routes)
// --------------------------------------------------------------------------

async function seedActive(app, content) {
  const res = await request(app).post('/api/projects/p1/memory/remember').set(...COOKIE)
    .send({ kind: 'pitfall', content }).expect(201);
  return res.body.memory.id;
}

test('PATCH archive then restore (route)', async (t) => {
  const app = setupApp(t);
  const id = await seedActive(app, 'archive me content here');
  const arch = await request(app).patch(`/api/projects/p1/memory/${id}`).set(...COOKIE).send({ action: 'archive' }).expect(200);
  assert.equal(arch.body.memory.status, 'archived');
  const rest = await request(app).patch(`/api/projects/p1/memory/${id}`).set(...COOKIE).send({ action: 'restore' }).expect(200);
  assert.equal(rest.body.memory.status, 'active');
});

test('PATCH update re-sanitizes content (secret redacted)', async (t) => {
  const app = setupApp(t);
  const id = await seedActive(app, 'original content here');
  const res = await request(app).patch(`/api/projects/p1/memory/${id}`).set(...COOKIE)
    .send({ action: 'update', content: 'use ghp_0123456789abcdefghijABCDEFGHIJklmnop to deploy' }).expect(200);
  assert.match(res.body.memory.content, /\[REDACTED\]/);
  assert.doesNotMatch(res.body.memory.content, /ghp_/);
});

test('PATCH review + pin', async (t) => {
  const app = setupApp(t);
  const id = await seedActive(app, 'review and pin me here');
  const rv = await request(app).patch(`/api/projects/p1/memory/${id}`).set(...COOKIE).send({ action: 'review' }).expect(200);
  assert.ok(rv.body.memory.reviewed_at);
  const pn = await request(app).patch(`/api/projects/p1/memory/${id}`).set(...COOKIE).send({ action: 'pin', pinned: true }).expect(200);
  assert.equal(pn.body.memory.pinned, 1);
});

test('PATCH: unknown action -> 400; cross-project/missing -> 404', async (t) => {
  const app = setupApp(t);
  const id = await seedActive(app, 'some content here ok');
  await request(app).patch(`/api/projects/p1/memory/${id}`).set(...COOKIE).send({ action: 'bogus' }).expect(400);
  await request(app).patch('/api/projects/p1/memory/ghost').set(...COOKIE).send({ action: 'archive' }).expect(404);
});

test('PATCH: archive on already-archived -> 400 (not applicable)', async (t) => {
  const app = setupApp(t);
  const id = await seedActive(app, 'double archive content');
  await request(app).patch(`/api/projects/p1/memory/${id}`).set(...COOKIE).send({ action: 'archive' }).expect(200);
  await request(app).patch(`/api/projects/p1/memory/${id}`).set(...COOKIE).send({ action: 'archive' }).expect(400);
});

test('GET provenance: redacts secrets in evidence', async (t) => {
  const app = setupApp(t);
  // seed an item carrying a secret-bearing evidence excerpt directly.
  app.services._rawDb.prepare(
    "INSERT INTO memory_items (id, project_id, kind, content, content_hash, evidence_json, origin) VALUES (?,?,?,?,?,?,?)"
  ).run('prov1', 'p1', 'pitfall', 'prov content', 'provhash', JSON.stringify({ excerpt: 'leaked ghp_0123456789abcdefghijABCDEFGHIJklmnop here', rule: 'R1b' }), 'batch_llm');
  const res = await request(app).get('/api/projects/p1/memory/prov1/provenance').set(...COOKIE).expect(200);
  assert.equal(res.body.origin, 'batch_llm');
  assert.match(res.body.evidence.excerpt, /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(res.body.evidence), /ghp_/);
  assert.equal(res.body.evidence.rule, 'R1b');
});

test('GET provenance: cross-project/missing -> 404', async (t) => {
  const app = setupApp(t);
  await request(app).get('/api/projects/p1/memory/ghost/provenance').set(...COOKIE).expect(404);
});

test('PATCH: bearer (PM) cannot mutate active memory -> 403 (actor split, Codex SERIOUS)', async (t) => {
  const app = setupApp(t);
  const id = await seedActive(app, 'pm cannot touch this content');
  await request(app).patch(`/api/projects/p1/memory/${id}`)
    .set('Authorization', 'Bearer secret-token').send({ action: 'archive' }).expect(403);
  assert.equal(app.services._rawDb.prepare('SELECT status FROM memory_items WHERE id=?').get(id).status, 'active', 'still active after rejected PATCH');
});

test('GET provenance: a secret appearing as an evidence KEY is redacted (Codex SERIOUS)', async (t) => {
  const app = setupApp(t);
  app.services._rawDb.prepare(
    "INSERT INTO memory_items (id, project_id, kind, content, content_hash, evidence_json, origin) VALUES (?,?,?,?,?,?,?)"
  ).run('provk', 'p1', 'pitfall', 'c', 'ph', JSON.stringify({ 'ghp_0123456789abcdefghijABCDEFGHIJklmnop': true, ok: 'v' }), 'batch_llm');
  const res = await request(app).get('/api/projects/p1/memory/provk/provenance').set(...COOKIE).expect(200);
  assert.doesNotMatch(JSON.stringify(res.body.evidence), /ghp_/, 'secret in an evidence key must be redacted');
});

test('GET ?status: active (default) vs archived vs all', async (t) => {
  const app = setupApp(t);
  const id = await seedActive(app, 'will be archived content here');
  await request(app).patch(`/api/projects/p1/memory/${id}`).set(...COOKIE).send({ action: 'archive' }).expect(200);
  // default = active -> empty
  const active = await request(app).get('/api/projects/p1/memory').set(...COOKIE).expect(200);
  assert.equal(active.body.memory.length, 0);
  // archived -> the one item
  const arch = await request(app).get('/api/projects/p1/memory?status=archived').set(...COOKIE).expect(200);
  assert.equal(arch.body.memory.length, 1);
  assert.equal(arch.body.memory[0].status, 'archived');
  assert.ok(arch.body.memory[0].archived_at);
  // all -> the one item too
  const all = await request(app).get('/api/projects/p1/memory?status=all').set(...COOKIE).expect(200);
  assert.equal(all.body.memory.length, 1);
  // bogus status falls back to active
  const bogus = await request(app).get('/api/projects/p1/memory?status=bogus').set(...COOKIE).expect(200);
  assert.equal(bogus.body.memory.length, 0);
});

test('app.shutdown is idempotent — double call is safe (Codex PR5b SERIOUS)', async (t) => {
  const app = setupApp(t);
  const p1 = app.shutdown();
  const p2 = app.shutdown();
  assert.equal(p1, p2, 'returns the same memoized promise (no double dispose/closeDb)');
  await assert.doesNotReject(Promise.resolve(p1));
  await assert.doesNotReject(Promise.resolve(p2));
  // t.after will call shutdown a 3rd time — also a no-op.
});
