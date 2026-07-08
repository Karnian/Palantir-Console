'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createProjectService } = require('../services/projectService');

const MIG_DIR = path.join(__dirname, '..', 'db', 'migrations');

const POST_050_RUN_COLUMNS = [
  'node_id',
  'source_type_snapshot',
  'run_source_generation',
  'repo_url_snapshot',
  'repo_ref_snapshot',
  'repo_subdir_snapshot',
  'repo_cache_path',
  'workspace_path',
  'workspace_generation',
  'resolved_commit',
  'materialize_attempts',
  'materialize_run_after',
  'materialize_started_at',
  'materialize_claim_token',
  'materialize_last_error',
  'workspace_ref_released_at',
];

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-instances-'));
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

function columnNames(db, table) {
  return new Set(db.pragma(`table_info(${table})`).map((col) => col.name));
}

function insertProject(db, { id, name, pm_enabled = 1, node_id = null, source_generation = 0 }) {
  db.prepare(`
    INSERT INTO projects (id, name, pm_enabled, node_id, source_generation)
    VALUES (@id, @name, @pm_enabled, @node_id, @source_generation)
  `).run({ id, name, pm_enabled, node_id, source_generation });
}

test('operator instance schema enforces W-P1 constraints', (t) => {
  const db = tempDb(t);
  applyMigrationsUpTo(db, 51);

  assert.throws(
    () => db.prepare("INSERT INTO operator_instances (id) VALUES ('bad_1')").run(),
    /CHECK constraint failed/,
  );
  // GLOB-strength cases (Codex W-P1 review): LIKE would let these through —
  // `_` is a LIKE wildcard ('oixfoo') and LIKE is case-insensitive ('OI_foo').
  assert.throws(
    () => db.prepare("INSERT INTO operator_instances (id) VALUES ('oixfoo')").run(),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => db.prepare("INSERT INTO operator_instances (id) VALUES ('OI_foo')").run(),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => db.prepare("INSERT INTO operator_instances (id) VALUES ('oi_')").run(),
    /CHECK constraint failed/,
  );

  db.prepare("INSERT INTO operator_instances (id) VALUES ('oi_nullable')").run();
  const nullable = db.prepare(`
    SELECT profile_id, thread_id, pm_adapter, node_id, cwd,
           source_generation, source_hash, workspace_path, status,
           watchlist_version
    FROM operator_instances
    WHERE id = 'oi_nullable'
  `).get();
  assert.deepEqual(nullable, {
    profile_id: null,
    thread_id: null,
    pm_adapter: null,
    node_id: null,
    cwd: null,
    source_generation: null,
    source_hash: null,
    workspace_path: null,
    status: 'idle',
    watchlist_version: 0,
  });

  insertProject(db, { id: 'proj_primary_a', name: 'Primary A' });
  insertProject(db, { id: 'proj_primary_b', name: 'Primary B' });
  insertProject(db, { id: 'proj_reference_a', name: 'Reference A' });
  db.prepare("INSERT INTO operator_instances (id) VALUES ('oi_primary_a')").run();
  db.prepare("INSERT INTO operator_instances (id) VALUES ('oi_primary_b')").run();
  db.prepare("INSERT INTO operator_instances (id) VALUES ('oi_reference_a')").run();

  assert.throws(
    () => db.prepare(`
      INSERT INTO operator_codebase_refs (instance_id, project_id, role)
      VALUES ('oi_primary_a', 'proj_primary_a', 'bogus')
    `).run(),
    /CHECK constraint failed/,
  );

  db.prepare(`
    INSERT INTO operator_codebase_refs (instance_id, project_id, role)
    VALUES ('oi_primary_a', 'proj_primary_a', 'primary')
  `).run();
  assert.throws(
    () => db.prepare(`
      INSERT INTO operator_codebase_refs (instance_id, project_id, role)
      VALUES ('oi_primary_b', 'proj_primary_a', 'primary')
    `).run(),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () => db.prepare(`
      INSERT INTO operator_codebase_refs (instance_id, project_id, role)
      VALUES ('oi_primary_a', 'proj_primary_b', 'primary')
    `).run(),
    /UNIQUE constraint failed/,
  );

  db.prepare(`
    INSERT INTO operator_codebase_refs (instance_id, project_id, role)
    VALUES ('oi_reference_a', 'proj_reference_a', 'reference')
  `).run();
  assert.throws(
    () => db.prepare(`
      INSERT INTO operator_codebase_refs (instance_id, project_id, role)
      VALUES ('oi_reference_a', 'proj_reference_a', 'reference')
    `).run(),
    /UNIQUE constraint failed/,
  );

  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('migration 051 backfills pm_enabled projects into one primary instance/ref pair', (t) => {
  const db = tempDb(t);
  applyMigrationsUpTo(db, 50);

  insertProject(db, {
    id: 'proj_enabled_thread',
    name: 'Enabled With Thread',
    pm_enabled: 1,
    node_id: 'local',
    source_generation: 7,
  });
  insertProject(db, { id: 'proj_enabled_empty', name: 'Enabled Empty', pm_enabled: 1 });
  insertProject(db, { id: 'proj_disabled_thread', name: 'Disabled With Thread', pm_enabled: 0, node_id: 'local' });

  db.prepare(`
    INSERT INTO project_briefs (
      project_id,
      conventions,
      known_pitfalls,
      pm_thread_id,
      pm_adapter,
      pm_thread_node_id,
      pm_thread_cwd,
      pm_thread_source_generation,
      pm_thread_source_hash,
      pm_thread_workspace_path
    )
    VALUES (
      'proj_enabled_thread',
      'keep conventions',
      'avoid pitfalls',
      'thread-enabled',
      'codex',
      'local',
      '/workspace/enabled',
      7,
      'hash-enabled',
      '/workspace/enabled'
    )
  `).run();
  db.prepare(`
    INSERT INTO project_briefs (
      project_id,
      pm_thread_id,
      pm_adapter,
      pm_thread_node_id,
      pm_thread_cwd,
      pm_thread_source_generation,
      pm_thread_source_hash,
      pm_thread_workspace_path
    )
    VALUES (
      'proj_disabled_thread',
      'thread-disabled',
      'claude',
      'local',
      '/workspace/disabled',
      9,
      'hash-disabled',
      '/workspace/disabled'
    )
  `).run();

  applyMigrationsUpTo(db, 51);

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM operator_instances').get().count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM operator_codebase_refs').get().count, 2);

  const enabledRows = db.prepare(`
    SELECT p.id AS project_id,
           COUNT(oi.id) AS instance_count,
           COUNT(r.project_id) AS primary_ref_count
    FROM projects p
    LEFT JOIN operator_codebase_refs r
      ON r.project_id = p.id AND r.role = 'primary'
    LEFT JOIN operator_instances oi
      ON oi.id = r.instance_id
    WHERE p.pm_enabled != 0
    GROUP BY p.id
    ORDER BY p.id
  `).all();
  assert.deepEqual(enabledRows, [
    { project_id: 'proj_enabled_empty', instance_count: 1, primary_ref_count: 1 },
    { project_id: 'proj_enabled_thread', instance_count: 1, primary_ref_count: 1 },
  ]);

  const instance = db.prepare(`
    SELECT id, thread_id, pm_adapter, node_id, cwd,
           source_generation, source_hash, workspace_path
    FROM operator_instances
    WHERE id = 'oi_proj_enabled_thread'
  `).get();
  assert.deepEqual(instance, {
    id: 'oi_proj_enabled_thread',
    thread_id: 'thread-enabled',
    pm_adapter: 'codex',
    node_id: 'local',
    cwd: '/workspace/enabled',
    source_generation: 7,
    source_hash: 'hash-enabled',
    workspace_path: '/workspace/enabled',
  });

  const emptyInstance = db.prepare(`
    SELECT thread_id, pm_adapter, node_id, cwd,
           source_generation, source_hash, workspace_path
    FROM operator_instances
    WHERE id = 'oi_proj_enabled_empty'
  `).get();
  assert.deepEqual(emptyInstance, {
    thread_id: null,
    pm_adapter: null,
    node_id: null,
    cwd: null,
    source_generation: null,
    source_hash: null,
    workspace_path: null,
  });

  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM operator_instances WHERE id = 'oi_proj_disabled_thread'").get().count,
    0,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM operator_codebase_refs WHERE project_id = 'proj_disabled_thread'").get().count,
    0,
  );

  const brief = db.prepare(`
    SELECT pm_thread_id, pm_adapter, pm_thread_node_id, pm_thread_cwd,
           pm_thread_source_generation, pm_thread_source_hash,
           pm_thread_workspace_path
    FROM project_briefs
    WHERE project_id = 'proj_enabled_thread'
  `).get();
  assert.deepEqual(brief, {
    pm_thread_id: 'thread-enabled',
    pm_adapter: 'codex',
    pm_thread_node_id: 'local',
    pm_thread_cwd: '/workspace/enabled',
    pm_thread_source_generation: 7,
    pm_thread_source_hash: 'hash-enabled',
    pm_thread_workspace_path: '/workspace/enabled',
  });

  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('runs keeps post-050 shape and new nullable columns default to NULL', (t) => {
  const db = tempDb(t);
  applyMigrationsUpTo(db, 51);

  const columns = columnNames(db, 'runs');
  for (const column of POST_050_RUN_COLUMNS) {
    assert.ok(columns.has(column), `runs.${column} exists`);
  }
  assert.ok(columns.has('operator_instance_id'), 'runs.operator_instance_id exists');
  assert.ok(columns.has('retry_root_run_id'), 'runs.retry_root_run_id exists');

  assert.doesNotThrow(() => {
    db.prepare("INSERT INTO runs (id, status) VALUES ('run_materializing_after_051', 'materializing')").run();
  });
  db.prepare("INSERT INTO runs (id) VALUES ('run_defaults_after_051')").run();
  const row = db.prepare(`
    SELECT operator_instance_id, retry_root_run_id
    FROM runs
    WHERE id = 'run_defaults_after_051'
  `).get();
  assert.deepEqual(row, {
    operator_instance_id: null,
    retry_root_run_id: null,
  });
});

test('projectService-created project IDs stay out of the oi_ namespace', (t) => {
  const db = tempDb(t);
  applyMigrationsUpTo(db, 51);

  const projectService = createProjectService(db);
  const project = projectService.createProject({ name: 'Prefix Guard' });
  assert.ok(project.id.startsWith('proj_'));
  assert.equal(project.id.startsWith('oi_'), false);
});
