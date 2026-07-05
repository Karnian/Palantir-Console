'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const { createDatabase } = require('../db/database');

const MIG_DIR = path.join(__dirname, '..', 'db', 'migrations');
const MIG_049 = path.join(MIG_DIR, '049_node_cordon.sql');

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

function nodeColumn(db, name) {
  return db.prepare('PRAGMA table_info(nodes)').all().find((col) => col.name === name);
}

test('049 fresh migration adds nodes.cordoned with default and check constraint', () => {
  const { db, migrate, close } = createDatabase(':memory:');
  try {
    migrate();
    assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 49);

    const column = nodeColumn(db, 'cordoned');
    assert.ok(column, 'nodes.cordoned column exists');
    assert.equal(column.notnull, 1);
    assert.equal(String(column.dflt_value), '0');

    assert.equal(db.prepare("SELECT cordoned FROM nodes WHERE id = 'local'").get().cordoned, 0);
    db.prepare("INSERT INTO nodes (id, name, kind, can_execute, reachable) VALUES ('n1', 'Node 1', 'local', 1, 1)").run();
    assert.equal(db.prepare("SELECT cordoned FROM nodes WHERE id = 'n1'").get().cordoned, 0);
    assert.throws(
      () => db.prepare("INSERT INTO nodes (id, name, kind, can_execute, reachable, cordoned) VALUES ('bad', 'Bad', 'local', 1, 1, 2)").run(),
      /CHECK constraint failed/,
    );
  } finally {
    close();
  }
});

test('049 upgrades existing nodes and preserves them as uncordoned', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    applyMigrationsUpTo(db, 48);
    assert.equal(nodeColumn(db, 'cordoned'), undefined);

    db.prepare(`
      INSERT INTO nodes (id, name, kind, can_execute, can_control, files_only, ssh_host, ssh_user, exposed_roots, reachable)
      VALUES ('ssh-old', 'Old SSH', 'ssh', 1, 0, 0, 'worker.local', 'ubuntu', '["/srv/workspaces"]', 1)
    `).run();

    db.exec(fs.readFileSync(MIG_049, 'utf8'));

    assert.ok(nodeColumn(db, 'cordoned'), 'nodes.cordoned column exists after 049');
    assert.equal(db.prepare("SELECT cordoned FROM nodes WHERE id = 'local'").get().cordoned, 0);
    assert.equal(db.prepare("SELECT cordoned FROM nodes WHERE id = 'ssh-old'").get().cordoned, 0);
    assert.throws(
      () => db.prepare("UPDATE nodes SET cordoned = 7 WHERE id = 'ssh-old'").run(),
      /CHECK constraint failed/,
    );
  } finally {
    db.close();
  }
});
