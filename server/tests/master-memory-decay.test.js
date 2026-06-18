// L2 Master Memory P1c Slice 2 — cap admission, TTL decay, correction CRUD,
// and the app-level decay scheduler.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createMasterMemoryService } = require('../services/masterMemoryService');
const { createApp } = require('../app');
const { invokeApp } = require('./helpers/invokeApp');

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function setupDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-mm-s2-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 'test.db'));
  migrate();
  t.after(() => { try { close(); } catch { /* */ } fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}

async function setupApp(t, { authToken = 'secret-token' } = {}) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-mm-s2-app-'));
  const app = createApp({
    storageRoot: tmp,
    fsRoot: tmp,
    dbPath: path.join(tmp, 'test.db'),
    authResolverOpts: { hasKeychain: () => false },
    authToken,
  });
  t.after(async () => {
    try { if (app.shutdown) app.shutdown(); else app.closeDb(); } catch { /* */ }
    await fsp.rm(tmp, { recursive: true, force: true });
  });
  return app;
}

function fillScope(svc, scope, n, { prefix = 'cap', confidence = 0.6, importance = 1 } = {}) {
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const item = svc.createMemoryItem({
      scope,
      kind: 'pattern',
      content: `${prefix} memory ${i}`,
      origin: 'deterministic',
      confidence,
      importance,
    });
    assert.equal(item.skipped, undefined, `seed ${i} admitted`);
    ids.push(item.id);
  }
  return ids;
}

const COOKIE = { Cookie: 'palantir_token=secret-token' };
const BEARER = { Authorization: 'Bearer secret-token' };

test('cap admission: non-human must beat lowest evictable; human and other scopes bypass user cap', (t) => {
  const db = setupDb(t);
  const svc = createMasterMemoryService(db);
  const victim = svc.createMemoryItem({
    scope: 'user',
    kind: 'pattern',
    content: 'lowest deterministic victim',
    origin: 'deterministic',
    confidence: 0.1,
    importance: 1,
  });
  fillScope(svc, 'user', 499, { prefix: 'higher deterministic', confidence: 0.6, importance: 1 });

  const rejected = svc.createMemoryItem({
    scope: 'user',
    kind: 'pattern',
    content: 'too weak to enter',
    origin: 'deterministic',
    confidence: 0.05,
    importance: 1,
  });
  assert.deepEqual(rejected, { skipped: true, reason: 'cap_rejected', scope: 'user' });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM master_memory_items WHERE scope='user' AND status='active'").get().n, 500);

  const winner = svc.createMemoryItem({
    scope: 'user',
    kind: 'pattern',
    content: 'strong enough to enter',
    origin: 'deterministic',
    confidence: 0.2,
    importance: 1,
  });
  assert.equal(winner.status, 'active');
  assert.equal(svc.getMemoryItem(victim.id).status, 'archived');
  assert.equal(svc.getMemoryItem(victim.id).archive_reason, 'cap_evicted');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM master_memory_items WHERE scope='user' AND status='active'").get().n, 500);

  const human = svc.createMemoryItem({
    scope: 'user',
    kind: 'preference',
    content: 'human memory over cap still enters',
    origin: 'human',
  });
  assert.equal(human.status, 'active');
  assert.equal(human.valid_to, null);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM master_memory_items WHERE scope='user' AND status='active'").get().n, 501);

  const cross = svc.createMemoryItem({
    scope: 'cross_project',
    kind: 'pattern',
    content: 'cross scope has independent cap accounting',
    origin: 'deterministic',
  });
  assert.equal(cross.status, 'active');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM master_memory_items WHERE scope='cross_project' AND status='active'").get().n, 1);
});

test('upsertFact cap admission: new deterministic fact is not a free 501st active row, human fact still admits', (t) => {
  const db = setupDb(t);
  const svc = createMasterMemoryService(db);
  fillScope(svc, 'user', 500, { prefix: 'hard cap deterministic', confidence: 0.9, importance: 10 });

  const rejected = svc.upsertFact({
    scope: 'user',
    factKey: 'cap.deterministic',
    content: 'deterministic fact should not bypass cap',
    origin: 'deterministic',
  });
  assert.deepEqual(rejected, { skipped: true, reason: 'cap_rejected', scope: 'user' });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM master_memory_items WHERE scope='user' AND status='active'").get().n, 500);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM master_memory_items WHERE fact_key='cap.deterministic'").get().n, 0);

  const human = svc.upsertFact({
    scope: 'user',
    factKey: 'cap.human',
    content: 'human fact still admits at cap',
    origin: 'human',
  });
  assert.equal(human.status, 'active');
  assert.equal(human.origin, 'human');
  assert.equal(human.valid_to, null);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM master_memory_items WHERE scope='user' AND status='active'").get().n, 501);
});

test('cap admission: exact merge bypasses cap and human merge upgrades deterministic row to permanent', (t) => {
  const db = setupDb(t);
  const svc = createMasterMemoryService(db);
  const existing = svc.createMemoryItem({
    scope: 'user',
    kind: 'pattern',
    content: 'duplicate content at cap',
    origin: 'deterministic',
    confidence: 0.6,
    importance: 1,
  });
  fillScope(svc, 'user', 499, { prefix: 'cap filler', confidence: 0.6, importance: 1 });

  const merged = svc.createMemoryItem({
    scope: 'user',
    kind: 'pattern',
    content: 'duplicate content at cap',
    origin: 'deterministic',
    confidence: 0.01,
    importance: 1,
  });
  assert.equal(merged.id, existing.id);
  assert.equal(merged.source_count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM master_memory_items WHERE scope='user' AND status='active'").get().n, 500);

  const upgraded = svc.createMemoryItem({
    scope: 'user',
    kind: 'preference',
    content: 'duplicate content at cap',
    origin: 'human',
  });
  assert.equal(upgraded.id, existing.id);
  assert.equal(upgraded.origin, 'human');
  assert.equal(upgraded.valid_to, null);
  assert.equal(upgraded.source_count, 3);
});

test('decay: non-human TTL is 180d; expiry archives by scope revision; human/pinned excluded; review refreshes no-bump', (t) => {
  const db = setupDb(t);
  const events = [];
  const svc = createMasterMemoryService(db, { emit: (channel, data) => events.push({ channel, data }) });
  const auto = svc.createMemoryItem({ scope: 'user', kind: 'pattern', content: 'auto ttl memory', origin: 'deterministic' });
  assert.ok(auto.valid_to, 'non-human valid_to set');
  const days = (new Date(`${auto.valid_to}Z`) - Date.now()) / 86400000;
  assert.ok(days > 170 && days < 190, `valid_to ~180 days out, got ${days.toFixed(1)}`);

  const human = svc.createMemoryItem({ scope: 'user', kind: 'preference', content: 'human permanent memory', origin: 'human' });
  assert.equal(human.valid_to, null);
  const pinned = svc.createMemoryItem({ scope: 'user', kind: 'pattern', content: 'pinned expired memory', origin: 'deterministic' });
  svc.pinMemory(pinned.id, true);
  db.prepare("UPDATE master_memory_items SET valid_to=datetime('now','-1 hour') WHERE id IN (?, ?)").run(auto.id, pinned.id);

  const rev0 = svc.getRevision('user');
  const expired = svc.expireStaleMemories();
  assert.equal(expired, 1);
  assert.equal(svc.getMemoryItem(auto.id).status, 'archived');
  assert.equal(svc.getMemoryItem(auto.id).archive_reason, 'ttl_expired');
  assert.equal(svc.getMemoryItem(human.id).status, 'active');
  assert.equal(svc.getMemoryItem(pinned.id).status, 'active');
  assert.ok(svc.getRevision('user') > rev0, 'expiry bumps scope revision');
  assert.ok(events.some((e) => e.channel === 'master_memory:decayed' && e.data.count === 1));

  const review = svc.createMemoryItem({ scope: 'user', kind: 'pattern', content: 'review refresh memory', origin: 'deterministic' });
  db.prepare("UPDATE master_memory_items SET valid_to=datetime('now','+1 day') WHERE id=?").run(review.id);
  const before = svc.getMemoryItem(review.id).valid_to;
  const rev1 = svc.getRevision('user');
  const reviewed = svc.markReviewed(review.id);
  assert.ok(reviewed.reviewed_at);
  assert.ok(reviewed.valid_to > before);
  assert.equal(svc.getRevision('user'), rev1, 'review refresh does not bump revision');
});

test('upsertFact: human facts are permanent; deterministic unchanged refreshes TTL/reviewed_at without bump', (t) => {
  const svc = createMasterMemoryService(setupDb(t));
  const det = svc.upsertFact({ scope: 'user', factKey: 'tool.node', content: 'node 24', origin: 'deterministic' });
  assert.ok(det.valid_to);
  const rev0 = svc.getRevision('user');
  const oldValidTo = det.valid_to;
  const refreshed = svc.upsertFact({ scope: 'user', factKey: 'tool.node', content: 'node 24', origin: 'deterministic' });
  assert.equal(refreshed.id, det.id);
  assert.ok(refreshed.reviewed_at);
  assert.ok(refreshed.valid_to >= oldValidTo);
  assert.equal(svc.getRevision('user'), rev0);

  const human = svc.upsertFact({ scope: 'user', factKey: 'user.region', content: 'nrt', origin: 'human' });
  assert.equal(human.valid_to, null);
});

test('upsertFact: deterministic write cannot supersede an active human fact with the same fact_key', (t) => {
  const db = setupDb(t);
  const svc = createMasterMemoryService(db);
  const human = svc.upsertFact({
    scope: 'user',
    factKey: 'deploy.region',
    content: 'Deploys to nrt.',
    origin: 'human',
  });
  const rev0 = svc.getRevision('user');

  const deterministic = svc.upsertFact({
    scope: 'user',
    factKey: 'deploy.region',
    content: 'Deploys to iad.',
    origin: 'deterministic',
  });

  assert.equal(deterministic.id, human.id);
  assert.equal(deterministic.origin, 'human');
  assert.equal(deterministic.content, 'Deploys to nrt.');
  assert.equal(svc.getMemoryItem(human.id).status, 'active');
  assert.equal(svc.getMemoryItem(human.id).content, 'Deploys to nrt.');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM master_memory_items WHERE scope='user' AND fact_key='deploy.region' AND status='active'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM master_memory_items WHERE scope='user' AND fact_key='deploy.region' AND status='superseded'").get().n, 0);
  assert.equal(svc.getRevision('user'), rev0);
});

test('correction service: update sanitizes and bumps; pin/review no-bump; restore folds before cap', (t) => {
  const db = setupDb(t);
  const svc = createMasterMemoryService(db);
  const item = svc.createMemoryItem({ scope: 'user', kind: 'preference', content: 'old correction content', origin: 'human' });
  const rev0 = svc.getRevision('user');
  const updated = svc.updateMemory(item.id, {
    content: 'deploy using ghp_0123456789abcdefghijABCDEFGHIJklmnop token',
    importance: 8,
  });
  assert.match(updated.content, /\[REDACTED\]/);
  assert.doesNotMatch(updated.content, /ghp_/);
  assert.equal(updated.importance, 8);
  assert.ok(svc.getRevision('user') > rev0);

  const rev1 = svc.getRevision('user');
  assert.equal(svc.pinMemory(item.id, true).pinned, 1);
  assert.ok(svc.markReviewed(item.id).reviewed_at);
  assert.equal(svc.getRevision('user'), rev1, 'pin/review do not bump revision');

  const archived = svc.createMemoryItem({ scope: 'user', kind: 'preference', content: 'restore duplicate fold', origin: 'human' });
  svc.archiveMemory(archived.id);
  const active = svc.createMemoryItem({ scope: 'user', kind: 'pattern', content: 'restore duplicate fold', origin: 'deterministic' });
  fillScope(svc, 'user', 498, { prefix: 'restore cap filler', confidence: 0.6, importance: 1 });
  const folded = svc.restoreMemory(archived.id, { activeCap: 500 });
  assert.equal(folded.id, active.id);
  assert.equal(folded.origin, 'human', 'restoring human duplicate upgrades active deterministic row');
  assert.equal(folded.valid_to, null);
  assert.equal(svc.getMemoryItem(archived.id).status, 'archived');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM master_memory_items WHERE scope='user' AND status='active'").get().n, 500);
});

test('restoreMemory: active fact_key collision surfaces as MEMORY_DUPLICATE and PATCH restore returns 400', async (t) => {
  const db = setupDb(t);
  const svc = createMasterMemoryService(db);
  const archived = svc.upsertFact({
    scope: 'user',
    factKey: 'restore.fact_key_collision',
    content: 'archived fact value',
    origin: 'human',
  });
  svc.archiveMemory(archived.id);
  const active = svc.upsertFact({
    scope: 'user',
    factKey: 'restore.fact_key_collision',
    content: 'active fact value',
    origin: 'human',
  });
  assert.notEqual(active.id, archived.id);
  assert.throws(
    () => svc.restoreMemory(archived.id),
    (err) => err && err.code === 'MEMORY_DUPLICATE'
  );
  assert.equal(svc.getMemoryItem(archived.id).status, 'archived');
  assert.equal(svc.getMemoryItem(active.id).status, 'active');

  const app = await setupApp(t);
  const routeArchived = app.services.masterMemoryService.upsertFact({
    scope: 'user',
    factKey: 'restore.route_collision',
    content: 'route archived fact',
    origin: 'human',
  });
  app.services.masterMemoryService.archiveMemory(routeArchived.id);
  app.services.masterMemoryService.upsertFact({
    scope: 'user',
    factKey: 'restore.route_collision',
    content: 'route active fact',
    origin: 'human',
  });

  const restored = await invokeApp(app, {
    method: 'PATCH',
    path: `/api/master-memory/${routeArchived.id}`,
    headers: COOKIE,
    body: { action: 'restore' },
  });
  assert.equal(restored.status, 400);
});

test('PATCH /api/master-memory/:id is cookie-only and update re-sanitizes', async (t) => {
  const app = await setupApp(t);
  const item = app.services.masterMemoryService.createMemoryItem({
    scope: 'user',
    kind: 'preference',
    content: 'route correction content',
    origin: 'human',
  });

  const bearer = await invokeApp(app, {
    method: 'PATCH',
    path: `/api/master-memory/${item.id}`,
    headers: BEARER,
    body: { action: 'archive' },
  });
  assert.equal(bearer.status, 403);

  const rev0 = app.services.masterMemoryService.getRevision('user');
  const updated = await invokeApp(app, {
    method: 'PATCH',
    path: `/api/master-memory/${item.id}`,
    headers: COOKIE,
    body: { action: 'update', content: 'store token=ghp_0123456789abcdefghijABCDEFGHIJklmnop safely' },
  });
  assert.equal(updated.status, 200);
  assert.match(updated.body.memory.content, /\[REDACTED\]/);
  assert.ok(app.services.masterMemoryService.getRevision('user') > rev0);

  const noAuthApp = await setupApp(t, { authToken: null });
  const noneItem = noAuthApp.services.masterMemoryService.createMemoryItem({
    scope: 'user',
    kind: 'preference',
    content: 'none auth patch guard',
    origin: 'human',
  });
  const none = await invokeApp(noAuthApp, {
    method: 'PATCH',
    path: `/api/master-memory/${noneItem.id}`,
    body: { action: 'archive' },
  });
  assert.equal(none.status, 403);
});

test('app scheduler: boot tick expires stale master memory and shutdown clears interval', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-mm-scheduler-'));
  const dbPath = path.join(tmp, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  db.prepare(`
    INSERT INTO master_memory_items (id, scope, kind, content, content_hash, evidence_json, origin, confidence, importance, status, valid_to)
    VALUES (?, 'user', 'pattern', ?, ?, '{}', 'deterministic', 0.5, 5, 'active', datetime('now','-1 hour'))
  `).run('expired-master-scheduler', 'scheduler expired content', sha256('scheduler expired content'));
  close();

  const app = createApp({
    storageRoot: tmp,
    fsRoot: tmp,
    dbPath,
    authResolverOpts: { hasKeychain: () => false },
    authToken: null,
  });
  try {
    const row = app.services._rawDb.prepare("SELECT status, archive_reason FROM master_memory_items WHERE id='expired-master-scheduler'").get();
    assert.equal(row.status, 'archived');
    assert.equal(row.archive_reason, 'ttl_expired');
    assert.ok(app.services.masterMemoryDecayScheduler.interval);
    app.shutdown();
    assert.equal(app.services.masterMemoryDecayScheduler.interval, null);
  } finally {
    try { if (app.shutdown) app.shutdown(); else app.closeDb(); } catch { /* */ }
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});
