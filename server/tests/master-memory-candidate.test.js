// L2 Master Memory P1c Slice 1 — candidates + human approval promotion.

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

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function setupDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-mm-cand-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 'test.db'));
  migrate();
  t.after(() => { try { close(); } catch { /* */ } fs.rmSync(dir, { recursive: true, force: true }); });
  return db;
}

function seedProject(db, id, name = id) {
  db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(id, name);
}

async function setupApp(t, { authToken = 'secret-token' } = {}) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-mm-cand-app-'));
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

const COOKIE = { Cookie: 'palantir_token=secret-token' };
const BEARER = { Authorization: 'Bearer secret-token' };

test('createCandidate dedups by UNIQUE and listCandidates does not leak raw_json', (t) => {
  const db = setupDb(t);
  const svc = createMasterMemoryService(db);

  const a = svc.createCandidate({
    scope: 'user',
    rule: 'R4',
    rawJson: { schema_version: 1, kind: 'preference', content: 'Prefer concise status updates.' },
    dedupKey: 'same-key',
  });
  const b = svc.createCandidate({
    scope: 'user',
    rule: 'R4',
    rawJson: { schema_version: 1, kind: 'preference', content: 'Prefer concise status updates.' },
    dedupKey: 'same-key',
  });

  assert.equal(a.id, b.id, 'duplicate insert returns the holder');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM master_memory_candidates').get().n, 1);

  const rows = svc.listCandidates('user');
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    'created_at', 'dedup_key', 'id', 'promoted_to', 'rule', 'scope', 'status',
  ].sort());
  assert.equal('raw_json' in rows[0], false, 'raw JSON blob is not exposed');
});

test('promoteCandidate maps L1 kinds to pattern and writes deterministic origin', (t) => {
  const db = setupDb(t);
  const svc = createMasterMemoryService(db);
  const cand = svc.createCandidate({
    scope: 'user',
    rule: 'R4',
    rawJson: { schema_version: 1, kind: 'pitfall', content: 'Native modules must be rebuilt after switching Node versions.' },
    dedupKey: 'pitfall-node-switch',
  });

  const result = svc.promoteCandidate({ candidateId: cand.id });
  assert.equal(result.promoted, true);
  assert.equal(result.item.kind, 'pattern');
  assert.equal(result.item.origin, 'deterministic');
  assert.equal(result.item.status, 'active');
  const evidence = JSON.parse(result.item.evidence_json);
  assert.equal(evidence.original_kind, 'pitfall');
  assert.deepEqual(evidence.candidate_ids, [cand.id]);

  const stored = db.prepare('SELECT status, promoted_to FROM master_memory_candidates WHERE id=?').get(cand.id);
  assert.equal(stored.status, 'promoted');
  assert.equal(stored.promoted_to, result.item.id);
});

test('promoteCandidate enforces XPROJECT >=2 active L1 projects at approval time', (t) => {
  const db = setupDb(t);
  seedProject(db, 'p1', 'One');
  seedProject(db, 'p2', 'Two');
  const l1 = createMemoryService(db);
  const master = createMasterMemoryService(db);
  const content = 'Use the shared migration helper for sqlite schema updates.';
  const contentHash = sha256(content);

  l1.createMemoryItem({ projectId: 'p1', kind: 'convention', content, origin: 'human' });
  const fail = master.createCandidate({
    scope: 'cross_project',
    rule: 'XPROJECT',
    rawJson: { schema_version: 1, kind: 'convention', content, content_hash: contentHash },
    dedupKey: `xproject:${contentHash}:fail`,
  });
  const skipped = master.promoteCandidate({ candidateId: fail.id });
  assert.equal(skipped.promoted, false);
  assert.equal(skipped.reason, 'xproject_recheck_failed');
  assert.equal(db.prepare('SELECT status FROM master_memory_candidates WHERE id=?').get(fail.id).status, 'rejected');
  assert.equal(master.listForScope('cross_project').length, 0);

  l1.createMemoryItem({ projectId: 'p2', kind: 'convention', content, origin: 'human' });
  const ok = master.createCandidate({
    scope: 'cross_project',
    rule: 'XPROJECT',
    rawJson: { schema_version: 1, kind: 'convention', content, content_hash: contentHash },
    dedupKey: `xproject:${contentHash}:ok`,
  });
  const promoted = master.promoteCandidate({ candidateId: ok.id });
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.item.scope, 'cross_project');
  assert.equal(promoted.item.kind, 'pattern');
  assert.equal(promoted.item.origin, 'deterministic');
});

test('routes: bearer remember creates candidate; candidates are cookie-only; cookie promote creates active item', async (t) => {
  const app = await setupApp(t);

  const staged = await invokeApp(app, {
    method: 'POST',
    path: '/api/master-memory/remember',
    headers: BEARER,
    body: { scope: 'user', kind: 'preference', content: 'Prefer direct implementation notes in reviews.' },
  });
  assert.equal(staged.status, 202);
  assert.equal(staged.body.origin, 'pm');
  assert.equal(staged.body.candidate.status, 'pending');
  assert.equal('raw_json' in staged.body.candidate, false);
  assert.equal(app.services._rawDb.prepare("SELECT COUNT(*) n FROM master_memory_items WHERE status='active'").get().n, 0);

  const forbidden = await invokeApp(app, { method: 'GET', path: '/api/master-memory/candidates', headers: BEARER });
  assert.equal(forbidden.status, 403);

  const list = await invokeApp(app, { method: 'GET', path: '/api/master-memory/candidates', headers: COOKIE });
  assert.equal(list.status, 200);
  assert.equal(list.body.candidates.length, 1);
  assert.equal('raw_json' in list.body.candidates[0], false);

  const promoted = await invokeApp(app, {
    method: 'POST',
    path: `/api/master-memory/candidates/${staged.body.candidate.id}/promote`,
    headers: COOKIE,
  });
  assert.equal(promoted.status, 200);
  assert.equal(promoted.body.memory.status, 'active');
  assert.equal(promoted.body.memory.origin, 'deterministic');
  assert.equal(promoted.body.candidate.status, 'promoted');
});
