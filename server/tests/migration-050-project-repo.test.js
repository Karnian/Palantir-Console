'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MIG_DIR = path.join(__dirname, '..', 'db', 'migrations');

const PROJECT_COLUMNS = [
  'source_type',
  'repo_url',
  'repo_ref',
  'repo_subdir',
  'repo_remote_fingerprint',
  'source_generation',
  'last_repo_preflight_at',
  'last_repo_preflight_error',
  'mcp_config_source',
  'mcp_config_relpath',
];

const RUN_COLUMNS = [
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

const BRIEF_COLUMNS = [
  'pm_thread_source_generation',
  'pm_thread_source_hash',
  'pm_thread_workspace_path',
];

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
  const files = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const version = parseInt(file.split('_')[0], 10);
    if (Number.isNaN(version) || version > maxVersion) continue;
    const sql = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
    applySqlMigration(db, version, sql);
  }
}

function applyMigration050(db) {
  const sql = fs.readFileSync(path.join(MIG_DIR, '050_project_repo_source.sql'), 'utf8');
  applySqlMigration(db, 50, sql);
}

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-050-'));
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

function columnNames(db, table) {
  return new Set(db.pragma(`table_info(${table})`).map((col) => col.name));
}

function seedPre050Rows(db) {
  db.prepare(`
    INSERT INTO projects (
      id, name, directory, description, color, budget_usd,
      pm_enabled, preferred_pm_adapter, mcp_config_path, test_command,
      node_id, allow_non_git_dir
    )
    VALUES (
      'proj_seed', 'Seed Project', '/tmp/seed-project', 'keep me',
      '#123456', 12.5, 1, 'codex', '/tmp/mcp.json', 'npm test',
      NULL, 0
    )
  `).run();
  db.prepare("INSERT INTO tasks (id, project_id, title, status) VALUES ('task_seed', 'proj_seed', 'Seed task', 'todo')").run();
  db.prepare(`
    INSERT INTO runs (
      id, task_id, agent_profile_id, status, prompt, is_manager,
      retry_count, manager_layer, conversation_id, node_id
    )
    VALUES (
      'run_seed_parent', 'task_seed', 'codex', 'queued', 'parent prompt',
      0, 0, 'operator', 'operator:proj_seed', 'local'
    )
  `).run();
  db.prepare(`
    INSERT INTO runs (
      id, task_id, agent_profile_id, status, prompt, is_manager,
      parent_run_id, retry_count, node_id
    )
    VALUES (
      'run_seed_child', 'task_seed', 'codex', 'queued', 'child prompt',
      0, 'run_seed_parent', 0, 'local'
    )
  `).run();
  db.prepare(`
    INSERT INTO project_briefs (project_id, conventions, known_pitfalls, pm_thread_id, pm_adapter)
    VALUES ('proj_seed', 'keep conventions', 'avoid pitfalls', 'thread_seed', 'codex')
  `).run();
}

test('migration 050 adds repo source schema and preserves existing rows', (t) => {
  const db = tempDb(t);
  applyMigrationsUpTo(db, 49);
  seedPre050Rows(db);

  applyMigration050(db);

  for (const column of PROJECT_COLUMNS) {
    assert.ok(columnNames(db, 'projects').has(column), `projects.${column} exists`);
  }
  for (const column of RUN_COLUMNS) {
    assert.ok(columnNames(db, 'runs').has(column), `runs.${column} exists`);
  }
  for (const column of BRIEF_COLUMNS) {
    assert.ok(columnNames(db, 'project_briefs').has(column), `project_briefs.${column} exists`);
  }

  const project = db.prepare(`
    SELECT directory, description, source_type, repo_ref, source_generation, mcp_config_source
    FROM projects WHERE id = 'proj_seed'
  `).get();
  assert.equal(project.directory, '/tmp/seed-project');
  assert.equal(project.description, 'keep me');
  assert.equal(project.source_type, 'legacy_directory');
  assert.equal(project.repo_ref, 'HEAD');
  assert.equal(project.source_generation, 0);
  assert.equal(project.mcp_config_source, 'legacy_control_plane_path');

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM runs').get().count, 2);
  const parentRun = db.prepare(`
    SELECT prompt, status, materialize_attempts, manager_layer, node_id
    FROM runs WHERE id = 'run_seed_parent'
  `).get();
  assert.equal(parentRun.prompt, 'parent prompt');
  assert.equal(parentRun.status, 'queued');
  assert.equal(parentRun.materialize_attempts, 0);
  assert.equal(parentRun.manager_layer, 'operator');
  assert.equal(parentRun.node_id, 'local');

  const childRun = db.prepare(`
    SELECT parent_run_id, prompt, status, materialize_attempts
    FROM runs WHERE id = 'run_seed_child'
  `).get();
  assert.equal(childRun.parent_run_id, 'run_seed_parent');
  assert.equal(childRun.prompt, 'child prompt');
  assert.equal(childRun.status, 'queued');
  assert.equal(childRun.materialize_attempts, 0);

  assert.doesNotThrow(() => {
    db.prepare("INSERT INTO runs (id, agent_profile_id, status) VALUES ('run_materializing_db', 'codex', 'materializing')").run();
  });
  assert.doesNotThrow(() => {
    db.prepare("UPDATE runs SET status = 'materializing' WHERE id = 'run_seed_child'").run();
  });
  assert.throws(
    () => db.prepare("INSERT INTO runs (id, agent_profile_id, status) VALUES ('run_bad_status', 'codex', 'not_a_status')").run(),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => db.prepare("INSERT INTO runs (id, agent_profile_id, status, manager_layer) VALUES ('run_bad_layer', 'codex', 'queued', 'pm')").run(),
    /CHECK constraint failed/,
  );

  const brief = db.prepare(`
    SELECT conventions, known_pitfalls, pm_thread_source_generation, pm_thread_workspace_path
    FROM project_briefs WHERE project_id = 'proj_seed'
  `).get();
  assert.equal(brief.conventions, 'keep conventions');
  assert.equal(brief.known_pitfalls, 'avoid pitfalls');
  assert.equal(brief.pm_thread_source_generation, null);
  assert.equal(brief.pm_thread_workspace_path, null);

  const tables = new Set(db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'project_node_workspaces',
      'project_materialization_leases',
      'project_workspace_refs'
    )
  `).all().map((row) => row.name));
  assert.deepEqual(tables, new Set([
    'project_node_workspaces',
    'project_materialization_leases',
    'project_workspace_refs',
  ]));

  const indexes = db.prepare(`
    SELECT name, tbl_name FROM sqlite_master
    WHERE type = 'index' AND name IN (
      'idx_matlease_singleflight',
      'idx_project_workspace_refs_run_id',
      'idx_project_workspace_refs_active'
    )
  `).all();
  assert.equal(indexes.length, 3);
  assert.equal(
    db.pragma('index_list(project_materialization_leases)')
      .find((idx) => idx.name === 'idx_matlease_singleflight')?.partial,
    1,
  );
  assert.equal(
    db.pragma('index_list(project_workspace_refs)')
      .find((idx) => idx.name === 'idx_project_workspace_refs_active')?.partial,
    1,
  );

  const insertLease = db.prepare(`
    INSERT INTO project_materialization_leases (
      project_id, node_id, source_generation, status
    ) VALUES (?, ?, ?, ?)
  `);
  insertLease.run('proj_seed', 'local', 0, 'pending');
  assert.throws(
    () => insertLease.run('proj_seed', 'local', 0, 'running'),
    /UNIQUE constraint failed/,
  );
  assert.doesNotThrow(() => insertLease.run('proj_seed', 'local', 0, 'failed'));
  assert.doesNotThrow(() => insertLease.run('proj_seed', 'local', 0, 'completed'));

  assert.deepEqual(db.pragma('foreign_key_check'), []);

  db.prepare("DELETE FROM tasks WHERE id = 'task_seed'").run();
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM runs WHERE id IN ('run_seed_parent', 'run_seed_child')").get().count,
    0,
  );
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
