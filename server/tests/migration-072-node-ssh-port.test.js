'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const { createDatabase } = require('../db/database');

const MIG_DIR = path.join(__dirname, '..', 'db', 'migrations');
const MIG_072 = path.join(MIG_DIR, '072_node_ssh_port.sql');

function applyMigrationsUpTo(db, maxVersion) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))");
  const files = fs.readdirSync(MIG_DIR).filter((file) => file.endsWith('.sql')).sort();
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
  return db.prepare('PRAGMA table_info(nodes)').all().find((column) => column.name === name);
}

test('072 fresh migration adds nullable nodes.ssh_port with a range check', () => {
  const { db, migrate, close } = createDatabase(':memory:');
  try {
    migrate();
    assert.ok(db.prepare('SELECT MAX(version) AS version FROM schema_version').get().version >= 72);

    const column = nodeColumn(db, 'ssh_port');
    assert.ok(column, 'nodes.ssh_port column exists');
    assert.equal(column.notnull, 0);
    assert.equal(column.dflt_value, null);
    assert.equal(db.prepare("SELECT ssh_port FROM nodes WHERE id = 'local'").get().ssh_port, null);

    db.prepare("INSERT INTO nodes (id, name, ssh_port) VALUES ('custom-port', 'Custom', 2222)").run();
    assert.equal(db.prepare("SELECT ssh_port FROM nodes WHERE id = 'custom-port'").get().ssh_port, 2222);

    for (const sshPort of [0, -1, 65536]) {
      assert.throws(
        () => db.prepare("INSERT INTO nodes (id, name, ssh_port) VALUES ('bad-port', 'Bad', ?)").run(sshPort),
        /CHECK constraint failed/,
      );
    }
  } finally {
    close();
  }
});

test('072 upgrades existing nodes with NULL ssh_port and enforces the range', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    applyMigrationsUpTo(db, 71);
    assert.equal(nodeColumn(db, 'ssh_port'), undefined);

    db.prepare(`
      INSERT INTO nodes (id, name, kind, ssh_host, ssh_user, exposed_roots)
      VALUES ('ssh-old', 'Old SSH', 'ssh', 'worker.local', 'ubuntu', '["/srv/workspaces"]')
    `).run();

    db.exec(fs.readFileSync(MIG_072, 'utf8'));

    assert.ok(nodeColumn(db, 'ssh_port'), 'nodes.ssh_port column exists after 072');
    assert.equal(db.prepare("SELECT ssh_port FROM nodes WHERE id = 'local'").get().ssh_port, null);
    assert.equal(db.prepare("SELECT ssh_port FROM nodes WHERE id = 'ssh-old'").get().ssh_port, null);
    assert.throws(
      () => db.prepare("UPDATE nodes SET ssh_port = 65536 WHERE id = 'ssh-old'").run(),
      /CHECK constraint failed/,
    );
  } finally {
    db.close();
  }
});
