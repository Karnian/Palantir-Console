'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../db/database');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pal-migration-runner-'));
  const migrationsDir = path.join(dir, 'migrations');
  fs.mkdirSync(migrationsDir);
  const handle = createDatabase(path.join(dir, 'test.db'));
  t.after(() => {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { ...handle, migrationsDir };
}

function writeMigration(migrationsDir, filename, sql) {
  fs.writeFileSync(path.join(migrationsDir, filename), sql, 'utf8');
}

function appliedVersions(db) {
  return db.prepare('SELECT version FROM schema_version ORDER BY version').all()
    .map(row => row.version);
}

test('retroactive migration below the applied head throws', (t) => {
  const { db, migrate, migrationsDir } = setup(t);
  writeMigration(migrationsDir, '001_create_log.sql', 'CREATE TABLE migration_log (version INTEGER PRIMARY KEY);');
  writeMigration(migrationsDir, '003_reach_head.sql', 'INSERT INTO migration_log (version) VALUES (3);');
  migrate(migrationsDir);
  assert.deepEqual(appliedVersions(db), [1, 3]);

  writeMigration(migrationsDir, '002_retroactive.sql', 'INSERT INTO migration_log (version) VALUES (2);');

  // MUTATION: Reverting the guard to `version <= MAX` silently skips this file,
  // so this assertion fails because migrate() does not throw.
  assert.throws(
    () => migrate(migrationsDir),
    /retroactive migration 002_retroactive\.sql is below the applied head \(3\) — renumber it above the head/,
  );
  assert.deepEqual(appliedVersions(db), [1, 3]);
  assert.equal(db.prepare('SELECT 1 FROM migration_log WHERE version = 2').get(), undefined);
});

test('fileless numeric gap below the head does not trip the guard', (t) => {
  const { db, migrate, migrationsDir } = setup(t);
  writeMigration(migrationsDir, '001_create_log.sql', 'CREATE TABLE migration_log (version INTEGER PRIMARY KEY);');
  writeMigration(migrationsDir, '003_after_gap.sql', 'INSERT INTO migration_log (version) VALUES (3);');

  assert.doesNotThrow(() => migrate(migrationsDir));
  assert.deepEqual(appliedVersions(db), [1, 3]);
});

test('fresh database applies every migration in numeric order and a second call is a no-op', (t) => {
  const { db, migrate, migrationsDir } = setup(t);
  writeMigration(
    migrationsDir,
    '010_last.sql',
    "INSERT INTO migration_log (version) VALUES (10);",
  );
  writeMigration(
    migrationsDir,
    '002_first.sql',
    'CREATE TABLE migration_log (version INTEGER PRIMARY KEY); INSERT INTO migration_log (version) VALUES (2);',
  );

  migrate(migrationsDir);
  const firstApplied = appliedVersions(db);
  assert.deepEqual(firstApplied, [2, 10]);
  assert.deepEqual(
    db.prepare('SELECT version FROM migration_log ORDER BY rowid').all().map(row => row.version),
    [2, 10],
  );

  assert.doesNotThrow(() => migrate(migrationsDir));
  assert.deepEqual(appliedVersions(db), firstApplied);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM migration_log').get().count, 2);
});

test('duplicate numeric migration prefix throws', (t) => {
  const { migrate, migrationsDir } = setup(t);
  writeMigration(migrationsDir, '001_one.sql', 'SELECT 1;');
  writeMigration(migrationsDir, '1_duplicate.sql', 'SELECT 1;');

  assert.throws(
    () => migrate(migrationsDir),
    /duplicate migration version 1: .*001_one\.sql.*1_duplicate\.sql|duplicate migration version 1: .*1_duplicate\.sql.*001_one\.sql/,
  );
});

test('malformed SQL migration filename throws', (t) => {
  const { migrate, migrationsDir } = setup(t);
  writeMigration(migrationsDir, 'not-a-migration.sql', 'SELECT 1;');

  assert.throws(
    () => migrate(migrationsDir),
    /malformed migration filename "not-a-migration\.sql"; expected NNN_name\.sql/,
  );
});
