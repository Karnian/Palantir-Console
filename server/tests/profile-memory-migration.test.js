'use strict';

// Migration 044 (profile owner in memory_items) — data-preservation guard.
// The rebuild is delicate: FTS5 external-content (rowid_pk mapping) + 3 triggers +
// an INBOUND FK memory_candidates.promoted_to -> memory_items(id) ON DELETE SET NULL.
// With foreign_keys=ON (the runner's mode), a naive DROP TABLE would null every
// promoted_to. This test seeds a v43 DB, applies 044, and asserts nothing is lost.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createDatabase } = require('../db/database');
const { createMemoryService } = require('../services/memoryService');

const MIG_DIR = path.join(__dirname, '..', 'db', 'migrations');

function migratedService(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm044s-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = createDatabase(path.join(dir, 't.db'));
  h.migrate();
  t.after(() => h.close());
  return { db: h.db, svc: createMemoryService(h.db) };
}

// Faithfully replicate the runner (server/db/database.js:migrate) up to maxVersion:
// bootstrap schema_version + honor the v34 procedural merge hook.
function applyMigrationsUpTo(db, maxVersion) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))");
  const files = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const v = parseInt(f.split('_')[0], 10);
    if (Number.isNaN(v) || v > maxVersion) continue;
    if (v === 34) require('../services/ownerMergeSlice2a').runSlice2aMerge(db);
    db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
    if (!db.prepare('SELECT 1 FROM schema_version WHERE version = ?').get(v)) {
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(v);
    }
  }
}

test('044 preserves rows/rowid_pk/FTS/promoted_to and enables profile rows', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm044t-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new Database(path.join(dir, 't.db'));
  db.pragma('foreign_keys = ON'); // replicate the migration runner (BLOCKER-1 hazard)
  applyMigrationsUpTo(db, 43);

  // Confirm we are genuinely pre-044 (project_id still NOT NULL).
  const ddl43 = db.prepare("SELECT sql FROM sqlite_master WHERE name='memory_items'").get().sql;
  assert.match(ddl43, /project_id\s+TEXT\s+NOT NULL/, 'precondition: v43 has project_id NOT NULL');

  // Seed workspace rows, then delete one to open an AUTOINCREMENT gap (hw > max).
  db.prepare("INSERT INTO projects(id,name) VALUES('p1','P1')").run();
  const ins = db.prepare('INSERT INTO memory_items(id,project_id,kind,content,content_hash,origin,owner_type,owner_id) VALUES(?,?,?,?,?,?,?,?)');
  ins.run('m1', 'p1', 'convention', 'alpha note', 'h1', 'human', 'workspace', 'p1');
  ins.run('m2', 'p1', 'heuristic', 'beta note', 'h2', 'human', 'workspace', 'p1');
  ins.run('m3', 'p1', 'pitfall', 'gamma note', 'h3', 'human', 'workspace', 'p1');
  const hw = db.prepare('SELECT MAX(rowid_pk) m FROM memory_items').get().m; // 3
  const m1rowid = db.prepare("SELECT rowid_pk r FROM memory_items WHERE id='m1'").get().r;
  db.prepare("DELETE FROM memory_items WHERE id='m3'").run(); // gap: hw=3, max=2

  // A candidate whose promoted_to points at a surviving item (the inbound FK).
  db.prepare("INSERT INTO memory_candidates(id,project_id,rule,raw_json,dedup_key,status,promoted_to,owner_type,owner_id) VALUES('c1','p1','R4','{}','dk1','promoted','m1','workspace','p1')").run();

  // Apply 044.
  db.exec(fs.readFileSync(path.join(MIG_DIR, '044_profile_memory_items.sql'), 'utf8'));

  // project_id is now nullable + coherence CHECK exists.
  const ddl44 = db.prepare("SELECT sql FROM sqlite_master WHERE name='memory_items'").get().sql;
  assert.doesNotMatch(ddl44, /project_id\s+TEXT\s+NOT NULL/, 'project_id relaxed');
  assert.match(ddl44, /owner_type = 'profile'/, 'coherence CHECK present');

  // Rows + rowid_pk preserved.
  assert.equal(db.prepare('SELECT COUNT(*) c FROM memory_items').get().c, 2, 'surviving rows preserved');
  assert.equal(db.prepare("SELECT rowid_pk r FROM memory_items WHERE id='m1'").get().r, m1rowid, 'rowid_pk preserved verbatim');

  // BLOCKER-1: inbound promoted_to NOT nulled by the DROP.
  assert.equal(db.prepare("SELECT promoted_to p FROM memory_candidates WHERE id='c1'").get().p, 'm1', 'promoted_to preserved');

  // FTS external-content still resolves workspace rows via rowid_pk.
  const fts = db.prepare("SELECT m.id FROM memory_fts f JOIN memory_items m ON m.rowid_pk=f.rowid WHERE memory_fts MATCH 'note' ORDER BY m.id").all().map((r) => r.id);
  assert.deepEqual(fts, ['m1', 'm2'], 'FTS intact after rebuild');

  // AUTOINCREMENT high-water preserved — a new row must NOT reuse the deleted rowid 3.
  const r = ins.run('m4', 'p1', 'convention', 'delta note', 'h4', 'human', 'workspace', 'p1');
  assert.ok(Number(r.lastInsertRowid) > hw, `new rowid ${r.lastInsertRowid} > high-water ${hw}`);

  // Profile rows now insertable; coherence CHECK rejects malformed shapes.
  ins.run('pr1', null, 'heuristic', 'profile note', 'hp', 'human', 'profile', 'op_x');
  assert.equal(db.prepare("SELECT owner_type o FROM memory_items WHERE id='pr1'").get().o, 'profile');
  assert.throws(() => ins.run('bad1', null, 'convention', 'x', 'hb1', 'human', 'workspace', null), /CHECK|constraint/i, 'workspace requires project_id');
  assert.throws(() => ins.run('bad2', 'p1', 'convention', 'y', 'hb2', 'human', 'profile', 'op_y'), /CHECK|constraint/i, 'profile must have NULL project_id');

  db.close();
});

test('createMemoryItem: profile owner → project_id NULL, no workspace revision bump', (t) => {
  const { db, svc } = migratedService(t);
  const it = svc.createMemoryItem({ profileId: 'op_x', kind: 'heuristic', content: 'profile lesson', origin: 'human' });
  assert.equal(it.owner_type, 'profile');
  assert.equal(it.owner_id, 'op_x');
  assert.equal(it.project_id, null);
  // project_memory_revision is workspace-scoped — a profile insert must not create one.
  assert.equal(db.prepare("SELECT COUNT(*) c FROM project_memory_revision WHERE project_id='op_x'").get().c, 0);
});

test('createMemoryItem: workspace path unchanged (owner_id=project_id, revision bumps)', (t) => {
  const { db, svc } = migratedService(t);
  db.prepare("INSERT INTO projects(id,name) VALUES('p1','P1')").run();
  const it = svc.createMemoryItem({ projectId: 'p1', kind: 'convention', content: 'ws lesson', origin: 'human' });
  assert.equal(it.owner_type, 'workspace');
  assert.equal(it.owner_id, 'p1');
  assert.equal(it.project_id, 'p1');
  assert.ok(db.prepare("SELECT COUNT(*) c FROM project_memory_revision WHERE project_id='p1'").get().c >= 1, 'workspace revision bumped');
});

test('createMemoryItem: rejects neither / both owners', (t) => {
  const { db, svc } = migratedService(t);
  db.prepare("INSERT INTO projects(id,name) VALUES('p1','P1')").run();
  assert.throws(() => svc.createMemoryItem({ kind: 'convention', content: 'x', origin: 'human' }), /required/);
  assert.throws(() => svc.createMemoryItem({ projectId: 'p1', profileId: 'op_x', kind: 'convention', content: 'x', origin: 'human' }), /mutually exclusive/);
});

test('checkOwnerParity: a profile row in memory_items is coherent (not flagged)', (t) => {
  const { db, svc } = migratedService(t);
  svc.createMemoryItem({ profileId: 'op_p', kind: 'pitfall', content: 'profile pitfall', origin: 'human' });
  const mismatches = svc.checkOwnerParity(); // returns the array directly
  const flagged = mismatches.filter((m) => m.table === 'memory_items');
  assert.deepEqual(flagged, [], 'profile memory_items row must not be a parity mismatch');
});

test('R4a: profile-row mutations (update/archive/restore/expire) never hit _bumpRevision(null)', (t) => {
  const { db, svc } = migratedService(t);
  const it = svc.createMemoryItem({ profileId: 'op_m', kind: 'convention', content: 'p1', origin: 'human' });
  // update content — previously threw via _bumpRevision(null)
  const upd = svc.updateMemoryContent({ id: it.id, content: 'p1 updated' });
  assert.equal(upd.content, 'p1 updated');
  // archive + restore
  assert.ok(svc.archiveMemory(it.id), 'archive returns the row');
  const restored = svc.restoreMemory(it.id); // returns the item directly
  assert.ok(restored && restored.status === 'active', 'restore re-activates');
  // TTL expiry — mark valid_to in the past; expireStaleMemories must not throw + archive it
  db.prepare("UPDATE memory_items SET valid_to='2000-01-01 00:00:00' WHERE id=?").run(it.id);
  const n = svc.expireStaleMemories();
  assert.ok(n >= 1, 'profile row expired');
  assert.notEqual(db.prepare('SELECT status FROM memory_items WHERE id=?').get(it.id).status, 'active');
});
