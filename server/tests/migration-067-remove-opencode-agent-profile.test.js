'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const { createDatabase } = require('../db/database');

const MIG_DIR = path.join(__dirname, '..', 'db', 'migrations');
const MIG_067 = path.join(MIG_DIR, '067_remove_opencode_agent_profile.sql');

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
    const sql = fs.readFileSync(path.join(MIG_DIR, file), 'utf8');
    applySqlMigration(db, version, sql);
  }
}

function applyMigration067(db) {
  applySqlMigration(db, 67, fs.readFileSync(MIG_067, 'utf8'));
}

function createUpgradeDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrationsUpTo(db, 66);
  return db;
}

test('067 fresh database has no seeded OpenCode profile', () => {
  const { db, migrate, close } = createDatabase(':memory:');
  try {
    migrate();

    assert.ok(db.prepare('SELECT MAX(version) AS version FROM schema_version').get().version >= 67);
    assert.equal(db.prepare("SELECT id FROM agent_profiles WHERE id = 'opencode'").get(), undefined);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    close();
  }
});

test('067 upgrade removes the seeded profile, nulls references, and fails safe nonterminal runs', () => {
  const db = createUpgradeDatabase();
  try {
    assert.equal(db.prepare("SELECT command FROM agent_profiles WHERE id = 'opencode'").get().command, 'opencode');

    db.prepare(`
      INSERT INTO tasks (id, title, suggested_agent_profile_id)
      VALUES ('task_opencode', 'Legacy OpenCode task', 'opencode')
    `).run();

    const insertRun = db.prepare(`
      INSERT INTO runs (id, agent_profile_id, status)
      VALUES (?, 'opencode', ?)
    `);
    const safeNonterminalStatuses = ['queued', 'paused', 'needs_input'];
    for (const status of safeNonterminalStatuses) {
      insertRun.run(`run_${status}`, status);
    }
    insertRun.run('run_completed', 'completed');

    applyMigration067(db);

    assert.equal(db.prepare("SELECT id FROM agent_profiles WHERE id = 'opencode'").get(), undefined);
    assert.equal(
      db.prepare("SELECT suggested_agent_profile_id FROM tasks WHERE id = 'task_opencode'").get().suggested_agent_profile_id,
      null,
    );

    for (const previousStatus of safeNonterminalStatuses) {
      const run = db.prepare(`
        SELECT agent_profile_id, status, ended_at, non_retryable
        FROM runs WHERE id = ?
      `).get(`run_${previousStatus}`);
      assert.equal(run.agent_profile_id, null, `${previousStatus} run profile reference cleared`);
      assert.equal(run.status, 'failed', `${previousStatus} run failed`);
      assert.ok(run.ended_at, `${previousStatus} run received ended_at`);
      assert.equal(run.non_retryable, 1, `${previousStatus} run is non-retryable`);
    }

    const completed = db.prepare(`
      SELECT agent_profile_id, status, ended_at, non_retryable
      FROM runs WHERE id = 'run_completed'
    `).get();
    assert.deepEqual(completed, {
      agent_profile_id: null,
      status: 'completed',
      ended_at: null,
      non_retryable: 0,
    });
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});

for (const status of ['running', 'materializing']) {
  test(`067 leaves a ${status} run untouched and retains its profile`, () => {
    const db = createUpgradeDatabase();
    try {
      db.prepare(`
        INSERT INTO runs (id, agent_profile_id, status)
        VALUES (?, 'opencode', ?)
      `).run(`run_${status}`, status);

      applyMigration067(db);

      assert.deepEqual(
        db.prepare("SELECT id, command FROM agent_profiles WHERE id = 'opencode'").get(),
        { id: 'opencode', command: 'opencode' },
      );
      assert.deepEqual(
        db.prepare('SELECT agent_profile_id, status, ended_at, non_retryable FROM runs WHERE id = ?')
          .get(`run_${status}`),
        { agent_profile_id: 'opencode', status, ended_at: null, non_retryable: 0 },
      );
      assert.deepEqual(db.pragma('foreign_key_check'), []);
    } finally {
      db.close();
    }
  });
}

test('067 deletes the seeded profile when no runs reference it', () => {
  const db = createUpgradeDatabase();
  try {
    assert.equal(db.prepare("SELECT command FROM agent_profiles WHERE id = 'opencode'").get().command, 'opencode');

    applyMigration067(db);

    assert.equal(db.prepare("SELECT id FROM agent_profiles WHERE id = 'opencode'").get(), undefined);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});

test('067 preserves a repurposed opencode profile and its references', () => {
  const db = createUpgradeDatabase();
  try {
    db.prepare("UPDATE agent_profiles SET type = 'made-up', command = 'gemini' WHERE id = 'opencode'").run();
    db.prepare(`
      INSERT INTO tasks (id, title, suggested_agent_profile_id)
      VALUES ('task_repurposed', 'Repurposed profile task', 'opencode')
    `).run();
    db.prepare(`
      INSERT INTO runs (id, agent_profile_id, status)
      VALUES ('run_repurposed', 'opencode', 'queued')
    `).run();

    applyMigration067(db);

    assert.deepEqual(
      db.prepare("SELECT id, type, command FROM agent_profiles WHERE id = 'opencode'").get(),
      { id: 'opencode', type: 'made-up', command: 'gemini' },
    );
    assert.deepEqual(
      db.prepare("SELECT agent_profile_id, status, ended_at, non_retryable FROM runs WHERE id = 'run_repurposed'").get(),
      { agent_profile_id: 'opencode', status: 'queued', ended_at: null, non_retryable: 0 },
    );
    assert.equal(
      db.prepare("SELECT suggested_agent_profile_id FROM tasks WHERE id = 'task_repurposed'").get().suggested_agent_profile_id,
      'opencode',
    );
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});
