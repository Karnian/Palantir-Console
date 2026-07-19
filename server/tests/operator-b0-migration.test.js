'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MIG_DIR = path.join(__dirname, '..', 'db', 'migrations');

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-b0-migration-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

function applySqlMigration(db, version, sql) {
  const firstLine = sql.split('\n')[0].trim();
  const fkOff = firstLine === '-- migrate:no-foreign-keys';

  if (fkOff) {
    if (db.inTransaction) throw new Error('unexpected open txn before FK-off migration');
    db.pragma('foreign_keys = OFF');
    try {
      db.exec('BEGIN');
      db.exec(sql);
      const violations = db.pragma('foreign_key_check');
      if (violations.length) throw new Error('FK violation: ' + JSON.stringify(violations[0]));
      if (!db.prepare('SELECT 1 FROM schema_version WHERE version = ?').get(version)) {
        db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
      }
      db.exec('COMMIT');
    } catch (err) {
      if (db.inTransaction) db.exec('ROLLBACK');
      throw err;
    } finally {
      if (!db.inTransaction) db.pragma('foreign_keys = ON');
    }
    return;
  }

  db.transaction(() => {
    if (version === 34) {
      require('../services/ownerMergeSlice2a').runSlice2aMerge(db);
    }
    db.exec(sql);
    if (!db.prepare('SELECT 1 FROM schema_version WHERE version = ?').get(version)) {
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
    }
  })();
}

function applyMigrationsUpTo(db, maxVersion) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))");
  const files = fs.readdirSync(MIG_DIR).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    const version = parseInt(file.split('_')[0], 10);
    if (Number.isNaN(version) || version > maxVersion) continue;
    if (db.prepare('SELECT 1 FROM schema_version WHERE version = ?').get(version)) continue;
    const sql = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
    applySqlMigration(db, version, sql);
  }
}

test('migration 064 backfills every profile-less instance and preserves rebuilt state', (t) => {
  const db = tempDb(t);
  applyMigrationsUpTo(db, 63);

  db.exec(`
    INSERT INTO projects (id, name) VALUES
      ('proj_primary', 'Primary'),
      ('proj_reference', 'Reference');

    INSERT INTO operator_profiles (
      id, name, description, persona, capabilities_json
    ) VALUES (
      'op_existing', 'Existing', 'Existing description', 'Existing persona', '["existing"]'
    );

    INSERT INTO operator_instances (
      id, profile_id, thread_id, pm_adapter, node_id, cwd,
      source_generation, source_hash, workspace_path, status,
      watchlist_version, created_at, updated_at, fast_mode
    ) VALUES
      (
        'oi_preserve', NULL, 'thread-preserve', 'codex', 'local', '/work/preserve',
        7, 'hash-preserve', '/workspace/preserve', 'running',
        11, '2026-01-02 03:04:05', '2026-02-03 04:05:06', 1
      ),
      (
        'oi_reference_only', NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, 'idle', 0,
        '2026-03-04 05:06:07', '2026-03-04 05:06:07', 0
      ),
      (
        'oi_orphan', NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, 'idle', 0,
        '2026-04-05 06:07:08', '2026-04-05 06:07:08', NULL
      ),
      (
        'oi_existing', 'op_existing', 'thread-existing', 'claude', NULL, NULL,
        NULL, NULL, NULL, 'idle', 3,
        '2026-05-06 07:08:09', '2026-05-06 07:08:09', NULL
      );

    INSERT INTO operator_codebase_refs (instance_id, project_id, role) VALUES
      ('oi_preserve', 'proj_primary', 'primary'),
      ('oi_reference_only', 'proj_reference', 'reference');
  `);

  const sql = fs.readFileSync(path.join(MIG_DIR, '064_operator_instance_profile.sql'), 'utf8');
  assert.match(sql, /^-- migrate:no-foreign-keys\n/);
  applySqlMigration(db, 64, sql);

  const columns = db.pragma('table_info(operator_instances)');
  assert.deepEqual(columns.map((column) => column.name), [
    'id',
    'profile_id',
    'thread_id',
    'pm_adapter',
    'node_id',
    'cwd',
    'source_generation',
    'source_hash',
    'workspace_path',
    'status',
    'watchlist_version',
    'created_at',
    'updated_at',
    'fast_mode',
  ]);
  assert.equal(columns.find((column) => column.name === 'profile_id').notnull, 1);

  const backfilled = db.prepare(`
    SELECT oi.id, oi.profile_id, op.name, op.description, op.persona,
           op.capabilities_json, op.is_private
    FROM operator_instances oi
    JOIN operator_profiles op ON op.id = oi.profile_id
    WHERE oi.id IN ('oi_preserve', 'oi_reference_only', 'oi_orphan')
    ORDER BY oi.id
  `).all();
  assert.deepEqual(backfilled, [
    {
      id: 'oi_orphan',
      profile_id: 'op_priv_oi_orphan',
      name: 'Private: oi_orphan',
      description: 'Auto-generated private profile for oi_orphan',
      persona: null,
      capabilities_json: '[]',
      is_private: 1,
    },
    {
      id: 'oi_preserve',
      profile_id: 'op_priv_oi_preserve',
      name: 'Private: oi_preserve',
      description: 'Auto-generated private profile for oi_preserve',
      persona: null,
      capabilities_json: '[]',
      is_private: 1,
    },
    {
      id: 'oi_reference_only',
      profile_id: 'op_priv_oi_reference_only',
      name: 'Private: oi_reference_only',
      description: 'Auto-generated private profile for oi_reference_only',
      persona: null,
      capabilities_json: '[]',
      is_private: 1,
    },
  ]);

  assert.deepEqual(db.prepare(`
    SELECT id, profile_id, thread_id, pm_adapter, node_id, cwd,
           source_generation, source_hash, workspace_path, status,
           watchlist_version, created_at, updated_at, fast_mode
    FROM operator_instances
    WHERE id = 'oi_preserve'
  `).get(), {
    id: 'oi_preserve',
    profile_id: 'op_priv_oi_preserve',
    thread_id: 'thread-preserve',
    pm_adapter: 'codex',
    node_id: 'local',
    cwd: '/work/preserve',
    source_generation: 7,
    source_hash: 'hash-preserve',
    workspace_path: '/workspace/preserve',
    status: 'running',
    watchlist_version: 11,
    created_at: '2026-01-02 03:04:05',
    updated_at: '2026-02-03 04:05:06',
    fast_mode: 1,
  });

  assert.deepEqual(db.prepare(`
    SELECT oi.profile_id, op.is_private
    FROM operator_instances oi
    JOIN operator_profiles op ON op.id = oi.profile_id
    WHERE oi.id = 'oi_existing'
  `).get(), { profile_id: 'op_existing', is_private: 0 });
  assert.deepEqual(db.prepare(`
    SELECT instance_id, project_id, role
    FROM operator_codebase_refs
    ORDER BY project_id
  `).all(), [
    { instance_id: 'oi_preserve', project_id: 'proj_primary', role: 'primary' },
    { instance_id: 'oi_reference_only', project_id: 'proj_reference', role: 'reference' },
  ]);

  assert.throws(
    () => db.prepare("INSERT INTO operator_instances (id) VALUES ('oi_x')").run(),
    /NOT NULL constraint failed: operator_instances\.profile_id/,
  );
  assert.ok(db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'index' AND name = 'idx_operator_instances_profile_id'
  `).get());
  assert.deepEqual(db.pragma('foreign_key_check'), []);

  db.prepare("DELETE FROM operator_instances WHERE id = 'oi_reference_only'").run();
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count
    FROM operator_codebase_refs
    WHERE instance_id = 'oi_reference_only'
  `).get().count, 0);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
