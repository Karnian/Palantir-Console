// L2 Master Memory P1c Slice 3 — cross-project L1 scan -> XPROJECT candidates.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createMemoryService } = require('../services/memoryService');
const { createMasterMemoryService } = require('../services/masterMemoryService');
const { createApp } = require('../app');
const { invokeApp } = require('./helpers/invokeApp');

const COOKIE = { Cookie: 'palantir_token=secret-token' };

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setupDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-mm-xproject-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 'test.db'));
  migrate();
  t.after(() => {
    try { close(); } catch { /* */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

function seedProjects(db, ids = ['p1', 'p2']) {
  for (const id of ids) {
    db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(id, id);
  }
}

function captureBus(events) {
  return {
    emit(channel, data) {
      events.push({ channel, data });
    },
  };
}

async function setupAppWithSeed(t, { content, authToken = 'secret-token' } = {}) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-mm-xproject-app-'));
  const dbPath = path.join(tmp, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  seedProjects(db);
  const l1 = createMemoryService(db);
  l1.createMemoryItem({ projectId: 'p1', kind: 'convention', content, origin: 'human' });
  l1.createMemoryItem({ projectId: 'p2', kind: 'convention', content, origin: 'human' });
  close();

  const app = createApp({
    storageRoot: tmp,
    fsRoot: tmp,
    dbPath,
    authResolverOpts: { hasKeychain: () => false },
    authToken,
    masterMemoryXprojectScanIntervalMs: 60 * 60 * 1000,
    masterMemoryXprojectScanDebounceMs: 5,
  });
  t.after(async () => {
    try { if (app.shutdown) await app.shutdown(); else app.closeDb(); } catch { /* */ }
    await fsp.rm(tmp, { recursive: true, force: true });
  });
  return app;
}

test('scanCrossProjectCandidates: same content in two projects creates a cross_project XPROJECT candidate', (t) => {
  const db = setupDb(t);
  seedProjects(db);
  const l1 = createMemoryService(db);
  const events = [];
  const master = createMasterMemoryService(db, captureBus(events));
  const content = 'Use the shared migration helper for sqlite schema updates.';

  l1.createMemoryItem({ projectId: 'p1', kind: 'convention', content, origin: 'human' });
  l1.createMemoryItem({ projectId: 'p2', kind: 'convention', content, origin: 'human' });

  const summary = master.scanCrossProjectCandidates();
  assert.deepEqual(summary, { created: 1, skipped: 0, scanned: 1 });

  const candidates = master.listCandidates('cross_project');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].scope, 'cross_project');
  assert.equal(candidates[0].rule, 'XPROJECT');
  assert.equal(candidates[0].dedup_key, sha256(content));
  assert.equal(candidates[0].kind, 'convention');

  const stored = JSON.parse(db.prepare('SELECT raw_json FROM master_memory_candidates WHERE id=?').get(candidates[0].id).raw_json);
  assert.equal(stored.rule, 'XPROJECT');
  assert.equal(stored.content, content);
  assert.equal(stored.content_hash, sha256(content));
  assert.equal(stored.projects, 2);
  assert.ok(events.some((e) => e.channel === 'master_memory:scanned' && e.data.created === 1));
});

test('scanCrossProjectCandidates: one project does not create a candidate', (t) => {
  const db = setupDb(t);
  seedProjects(db);
  const l1 = createMemoryService(db);
  const master = createMasterMemoryService(db);

  l1.createMemoryItem({
    projectId: 'p1',
    kind: 'convention',
    content: 'Use the shared migration helper for sqlite schema updates.',
    origin: 'human',
  });

  assert.deepEqual(master.scanCrossProjectCandidates(), { created: 0, skipped: 0, scanned: 0 });
  assert.equal(master.listCandidates('cross_project').length, 0);
});

test('scanCrossProjectCandidates: fact/env rows are excluded from XPROJECT signals', (t) => {
  const db = setupDb(t);
  seedProjects(db);
  const l1 = createMemoryService(db);
  const master = createMasterMemoryService(db);

  l1.upsertFact({ projectId: 'p1', factKey: 'env.test_command', content: 'Project test command: npm test' });
  l1.upsertFact({ projectId: 'p2', factKey: 'env.test_command', content: 'Project test command: npm test' });
  l1.upsertFact({ projectId: 'p1', factKey: 'deploy.region', content: 'Deploys to nrt region.' });
  l1.upsertFact({ projectId: 'p2', factKey: 'deploy.region', content: 'Deploys to nrt region.' });

  assert.deepEqual(master.scanCrossProjectCandidates(), { created: 0, skipped: 0, scanned: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM master_memory_candidates').get().n, 0);
});

test('scanCrossProjectCandidates: rescans dedup by content_hash', (t) => {
  const db = setupDb(t);
  seedProjects(db);
  const l1 = createMemoryService(db);
  const master = createMasterMemoryService(db);
  const content = 'Keep migration files additive and monotonic.';

  l1.createMemoryItem({ projectId: 'p1', kind: 'constraint', content, origin: 'human' });
  l1.createMemoryItem({ projectId: 'p2', kind: 'constraint', content, origin: 'human' });

  assert.deepEqual(master.scanCrossProjectCandidates(), { created: 1, skipped: 0, scanned: 1 });
  assert.deepEqual(master.scanCrossProjectCandidates(), { created: 0, skipped: 0, scanned: 1 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM master_memory_candidates').get().n, 1);
});

test('scanCrossProjectCandidates: non L2 fixed-point content is skipped and logged', (t) => {
  const db = setupDb(t);
  seedProjects(db);
  const l1 = createMemoryService(db);
  const events = [];
  const master = createMasterMemoryService(db, captureBus(events));
  const content = '  Keep the cross-project scanner deterministic.  ';
  const hash = sha256(content);

  l1.createMemoryItem({ projectId: 'p1', kind: 'convention', content, origin: 'human' });
  l1.createMemoryItem({ projectId: 'p2', kind: 'convention', content, origin: 'human' });

  assert.deepEqual(master.scanCrossProjectCandidates(), { created: 0, skipped: 1, scanned: 1 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM master_memory_candidates').get().n, 0);
  assert.ok(events.some((e) => (
    e.channel === 'master_memory:scan_skipped'
    && e.data.content_hash === hash
    && e.data.reason === 'not_l2_fixed_point'
  )));
});

test('routes: scanner-created XPROJECT candidate promotes via cookie route to user-scope active memory', async (t) => {
  const content = 'Use the shared migration helper for sqlite schema updates.';
  const app = await setupAppWithSeed(t, { content });

  const list = await invokeApp(app, {
    method: 'GET',
    path: '/api/master-memory/candidates?scope=cross_project',
    headers: COOKIE,
  });
  assert.equal(list.status, 200);
  assert.equal(list.body.candidates.length, 1);
  assert.equal(list.body.candidates[0].scope, 'cross_project');

  const promoted = await invokeApp(app, {
    method: 'POST',
    path: `/api/master-memory/candidates/${list.body.candidates[0].id}/promote`,
    headers: COOKIE,
  });
  assert.equal(promoted.status, 200);
  assert.equal(promoted.body.memory.scope, 'user');
  assert.equal(promoted.body.memory.status, 'active');
  assert.equal(promoted.body.memory.origin, 'deterministic');
  assert.equal(promoted.body.memory.kind, 'pattern');
  assert.equal(app.services.masterMemoryService.listForScope('cross_project').length, 0);
  assert.equal(app.services.masterMemoryService.listForScope('user').length, 1);
});

test('app scanner scheduler: boot tick scans and shutdown clears interval', async (t) => {
  const app = await setupAppWithSeed(t, {
    content: 'Prefer additive sqlite migrations over destructive schema rewrites.',
    authToken: null,
  });

  assert.equal(app.services.masterMemoryService.listCandidates('cross_project').length, 1);
  assert.ok(app.services.masterMemoryXprojectScanner.interval);
  await app.shutdown();
  assert.equal(app.services.masterMemoryXprojectScanner.interval, null);
});

test('app scanner scheduler: memory event hint debounces and triggers a scan', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-mm-xproject-hint-'));
  const app = createApp({
    storageRoot: tmp,
    fsRoot: tmp,
    dbPath: path.join(tmp, 'test.db'),
    authResolverOpts: { hasKeychain: () => false },
    authToken: null,
    masterMemoryXprojectScanIntervalMs: 60 * 60 * 1000,
    masterMemoryXprojectScanDebounceMs: 5,
  });
  t.after(async () => {
    try { if (app.shutdown) await app.shutdown(); else app.closeDb(); } catch { /* */ }
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  seedProjects(app.services._rawDb);
  const content = 'Run the project test command before reporting completion.';
  app.services.memoryService.createMemoryItem({ projectId: 'p1', kind: 'heuristic', content, origin: 'human' });
  app.services.memoryService.createMemoryItem({ projectId: 'p2', kind: 'heuristic', content, origin: 'human' });

  assert.equal(app.services.masterMemoryService.listCandidates('cross_project').length, 0);
  app.services.eventBus.emit('memory:promoted', { projectId: 'p1', count: 1 });
  await wait(30);
  const candidates = app.services.masterMemoryService.listCandidates('cross_project');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].rule, 'XPROJECT');
});
