'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createDatabase } = require('../db/database');

const MIG_DIR = path.join(__dirname, '..', 'db', 'migrations');
const MIG_048 = path.join(MIG_DIR, '048_task_status_failed.sql');

const TASK_COLUMNS = [
  'id',
  'project_id',
  'title',
  'description',
  'status',
  'priority',
  'sort_order',
  'created_at',
  'updated_at',
  'due_date',
  'recurrence',
  'parent_task_id',
  'task_kind',
  'requires_capabilities',
  'suggested_agent_profile_id',
  'acceptance_criteria',
  'preferred_preset_id',
  'goal_enabled',     // migration 054 (G1)
  'goal_max_attempts', // migration 054 (G1)
];

const TASK_INDEXES = [
  'idx_tasks_project',
  'idx_tasks_status',
  'idx_tasks_due_date',
  'idx_tasks_recurrence',
  'idx_tasks_parent',
  'idx_tasks_task_kind',
  'idx_tasks_suggested_agent',
  'idx_tasks_preferred_preset_id',
];

function applyMigrationsUpTo(db, maxVersion) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))");
  const files = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const version = parseInt(file.split('_')[0], 10);
    if (Number.isNaN(version) || version > maxVersion) continue;
    if (version === 34) require('../services/ownerMergeSlice2a').runSlice2aMerge(db);
    db.exec(fs.readFileSync(path.join(MIG_DIR, file), 'utf8'));
    if (!db.prepare('SELECT 1 FROM schema_version WHERE version = ?').get(version)) {
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
    }
  }
}

function applyFkOffMigration(db, version, sql) {
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
    if (db.inTransaction) {
      try { db.exec('ROLLBACK'); } catch (e) { err.rollbackError = e; }
    }
    throw err;
  } finally {
    if (!db.inTransaction) db.pragma('foreign_keys = ON');
  }
}

function tempDb(t, prefix = 'migration-048-') {
  const state = { db: null, handle: null };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, 'test.db');
  t.after(() => {
    if (state.handle) {
      try { state.handle.close(); } catch { /* noop */ }
    }
    if (state.db) {
      try { state.db.close(); } catch { /* noop */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { state, dbPath };
}

function migratedFreshDb(t) {
  const { state, dbPath } = tempDb(t, 'migration-048-fresh-');
  state.handle = createDatabase(dbPath);
  state.handle.migrate();
  return state.handle.db;
}

function taskDdl(db) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get().sql;
}

function replaceTasksWithLegacyDrift(db) {
  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(`
      CREATE TABLE tasks_legacy (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'backlog' CHECK(status IN ('backlog','todo','in_progress','review','done')),
        priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
        sort_order INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        due_date TEXT
          CHECK (due_date IS NULL OR due_date GLOB '????-??-??'),
        recurrence TEXT
          CHECK (recurrence IS NULL OR recurrence IN ('daily', 'weekly', 'monthly')),
        parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        task_kind TEXT
          CHECK (task_kind IS NULL OR task_kind IN
            ('code_change','investigation','review','docs','refactor','other')),
        requires_capabilities TEXT,
        suggested_agent_profile_id TEXT REFERENCES agent_profiles(id) ON DELETE SET NULL,
        acceptance_criteria TEXT,
        preferred_preset_id TEXT
      );

      INSERT INTO tasks_legacy (
        id, project_id, title, description, status, priority, sort_order,
        created_at, updated_at, due_date, recurrence, parent_task_id,
        task_kind, requires_capabilities, suggested_agent_profile_id,
        acceptance_criteria, preferred_preset_id
      )
      SELECT
        id, project_id, title, description, status, priority, sort_order,
        created_at, updated_at, due_date, recurrence, parent_task_id,
        task_kind, requires_capabilities, suggested_agent_profile_id,
        acceptance_criteria, preferred_preset_id
      FROM tasks;

      DROP TRIGGER IF EXISTS trg_task_skill_packs_cross_project_insert_guard;
      DROP TRIGGER IF EXISTS trg_task_skill_packs_cross_project_update_guard;

      DROP TABLE tasks;
      ALTER TABLE tasks_legacy RENAME TO tasks;

      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
      CREATE INDEX IF NOT EXISTS idx_tasks_recurrence ON tasks(recurrence) WHERE recurrence IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_task_kind ON tasks(task_kind) WHERE task_kind IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_tasks_suggested_agent ON tasks(suggested_agent_profile_id)
        WHERE suggested_agent_profile_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_tasks_preferred_preset_id
        ON tasks(preferred_preset_id)
        WHERE preferred_preset_id IS NOT NULL;

      CREATE TRIGGER IF NOT EXISTS trg_task_skill_packs_cross_project_insert_guard
        BEFORE INSERT ON task_skill_packs
        WHEN EXISTS (
          SELECT 1 FROM skill_packs sp
          JOIN tasks t ON t.id = NEW.task_id
          WHERE sp.id = NEW.skill_pack_id
            AND sp.scope = 'project'
            AND (t.project_id IS NULL OR sp.project_id != t.project_id)
        )
      BEGIN
        SELECT RAISE(ABORT, 'Cannot bind project-scope skill pack to task in different project');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_task_skill_packs_cross_project_update_guard
        BEFORE UPDATE ON task_skill_packs
        WHEN EXISTS (
          SELECT 1 FROM skill_packs sp
          JOIN tasks t ON t.id = NEW.task_id
          WHERE sp.id = NEW.skill_pack_id
            AND sp.scope = 'project'
            AND (t.project_id IS NULL OR sp.project_id != t.project_id)
        )
      BEGIN
        SELECT RAISE(ABORT, 'Cannot bind project-scope skill pack to task in different project');
      END;
    `);
    db.exec('COMMIT');
  } catch (err) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw err;
  } finally {
    if (!db.inTransaction) db.pragma('foreign_keys = ON');
  }
}

test('048 fresh DB accepts failed task status and keeps invalid statuses rejected', (t) => {
  const db = migratedFreshDb(t);

  assert.doesNotThrow(() => {
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('task_failed_insert', 'failed insert', 'failed')").run();
  });

  db.prepare("INSERT INTO tasks (id, title, status) VALUES ('task_failed_update', 'failed update', 'todo')").run();
  assert.doesNotThrow(() => {
    db.prepare("UPDATE tasks SET status = 'failed' WHERE id = 'task_failed_update'").run();
  });

  assert.throws(
    () => db.prepare("INSERT INTO tasks (id, title, status) VALUES ('task_bad_insert', 'bad insert', 'blocked')").run(),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => db.prepare("UPDATE tasks SET status = 'blocked' WHERE id = 'task_failed_update'").run(),
    /CHECK constraint failed/,
  );
});

test('048 tasks schema has canonical columns, indexes, failed CHECK, and no preset FK', (t) => {
  const db = migratedFreshDb(t);
  const ddl = taskDdl(db);

  assert.match(ddl, /'failed'/);
  assert.doesNotMatch(ddl, /REFERENCES\s+worker_presets/i);
  assert.match(ddl, /json_valid\(requires_capabilities\)/);

  const columns = db.prepare('PRAGMA table_info(tasks)').all().map((row) => row.name);
  assert.deepEqual(columns, TASK_COLUMNS);

  const indexes = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks'").all().map((row) => row.name),
  );
  for (const name of TASK_INDEXES) {
    assert.ok(indexes.has(name), `${name} exists`);
  }

  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('048 preserves legacy production task rows and converges requires_capabilities CHECK', (t) => {
  const { state, dbPath } = tempDb(t, 'migration-048-legacy-');
  state.db = new Database(dbPath);
  state.db.pragma('foreign_keys = ON');
  applyMigrationsUpTo(state.db, 47);
  assert.equal(state.db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 47);

  replaceTasksWithLegacyDrift(state.db);
  assert.doesNotMatch(taskDdl(state.db), /json_valid\(requires_capabilities\)/);
  assert.throws(
    () => state.db.prepare("INSERT INTO tasks (id, title, status) VALUES ('legacy_failed_before', 'before', 'failed')").run(),
    /CHECK constraint failed/,
  );

  state.db.prepare("INSERT INTO projects(id, name) VALUES('project_048', 'Project 048')").run();
  state.db.prepare(`
    INSERT INTO tasks (
      id, project_id, title, description, status, priority, sort_order,
      created_at, updated_at, due_date, recurrence, parent_task_id,
      task_kind, requires_capabilities, suggested_agent_profile_id,
      acceptance_criteria, preferred_preset_id
    )
    VALUES (
      'legacy_parent', 'project_048', 'Legacy parent', 'parent desc', 'todo',
      'high', 7, '2026-01-01 00:00:00', '2026-01-02 00:00:00',
      '2026-08-01', 'weekly', NULL, 'code_change', '["filesystem_write"]',
      'claude-code', 'ship it', 'preset_legacy'
    )
  `).run();
  state.db.prepare(`
    INSERT INTO tasks (
      id, project_id, title, status, priority, sort_order, parent_task_id,
      task_kind, requires_capabilities
    )
    VALUES (
      'legacy_child', 'project_048', 'Legacy child', 'review', 'low', 8,
      'legacy_parent', 'review', NULL
    )
  `).run();

  const sql = fs.readFileSync(MIG_048, 'utf8');
  assert.match(sql, /^-- migrate:no-foreign-keys\n/);
  applyFkOffMigration(state.db, 48, sql);

  assert.equal(state.db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c, 2);
  assert.deepEqual(state.db.prepare(`
    SELECT
      id, project_id, title, description, status, priority, sort_order,
      created_at, updated_at, due_date, recurrence, parent_task_id,
      task_kind, requires_capabilities, suggested_agent_profile_id,
      acceptance_criteria, preferred_preset_id
    FROM tasks WHERE id = 'legacy_parent'
  `).get(), {
    id: 'legacy_parent',
    project_id: 'project_048',
    title: 'Legacy parent',
    description: 'parent desc',
    status: 'todo',
    priority: 'high',
    sort_order: 7,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-02 00:00:00',
    due_date: '2026-08-01',
    recurrence: 'weekly',
    parent_task_id: null,
    task_kind: 'code_change',
    requires_capabilities: '["filesystem_write"]',
    suggested_agent_profile_id: 'claude-code',
    acceptance_criteria: 'ship it',
    preferred_preset_id: 'preset_legacy',
  });
  assert.equal(state.db.prepare("SELECT parent_task_id FROM tasks WHERE id = 'legacy_child'").get().parent_task_id, 'legacy_parent');

  state.db.prepare("UPDATE tasks SET status = 'failed' WHERE id = 'legacy_child'").run();
  assert.equal(state.db.prepare("SELECT status FROM tasks WHERE id = 'legacy_child'").get().status, 'failed');
  assert.throws(
    () => state.db.prepare("UPDATE tasks SET requires_capabilities = '{\"bad\":true}' WHERE id = 'legacy_child'").run(),
    /CHECK constraint failed/,
  );
  assert.deepEqual(state.db.pragma('foreign_key_check'), []);
});

test('048 rebuilt tasks table still cascades child runs on task delete', (t) => {
  const db = migratedFreshDb(t);
  db.prepare("INSERT INTO tasks (id, title, status) VALUES ('task_with_run', 'Task with run', 'todo')").run();
  db.prepare(`
    INSERT INTO runs (id, task_id, agent_profile_id, prompt, status)
    VALUES ('run_for_task', 'task_with_run', 'claude-code', 'prompt', 'queued')
  `).run();

  db.prepare("DELETE FROM tasks WHERE id = 'task_with_run'").run();
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM runs WHERE id = 'run_for_task'").get().c, 0);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
