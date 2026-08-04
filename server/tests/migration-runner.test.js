'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
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
  const firstChecksums = db.prepare(
    'SELECT version, content_sha256 FROM schema_version ORDER BY version'
  ).all();

  assert.doesNotThrow(() => migrate(migrationsDir));
  assert.deepEqual(appliedVersions(db), firstApplied);
  assert.deepEqual(
    db.prepare('SELECT version, content_sha256 FROM schema_version ORDER BY version').all(),
    firstChecksums,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM migration_log').get().count, 2);
});

test('applying a migration records its exact content SHA-256', (t) => {
  const { db, migrate, migrationsDir } = setup(t);
  const sql = 'CREATE TABLE checksum_log (value TEXT);';
  writeMigration(migrationsDir, '001_checksum.sql', sql);

  migrate(migrationsDir);

  const row = db.prepare(
    'SELECT content_sha256 FROM schema_version WHERE version = 1'
  ).get();
  assert.equal(row.content_sha256, createHash('sha256').update(sql).digest('hex'));
  assert.match(row.content_sha256, /^[0-9a-f]{64}$/);
});

test('applying a self-inserting migration overwrites its bogus non-NULL checksum', (t) => {
  const { db, migrate, migrationsDir } = setup(t);
  const sql = `
    INSERT INTO schema_version (version, content_sha256) VALUES (1, 'bogus');
    CREATE TABLE self_insert_log (value TEXT);
  `;
  writeMigration(migrationsDir, '001_self_insert.sql', sql);

  migrate(migrationsDir);

  assert.equal(
    db.prepare('SELECT content_sha256 FROM schema_version WHERE version = 1').get().content_sha256,
    createHash('sha256').update(sql).digest('hex'),
  );
  // MUTATION: Restoring the NULL-only UPDATE leaves "bogus" recorded, so this
  // second migrate() falsely throws that the unchanged file content changed.
  assert.doesNotThrow(() => migrate(migrationsDir));
});

test('changing an already-applied migration content throws', (t) => {
  const { migrate, migrationsDir } = setup(t);
  const filename = '001_tamper_target.sql';
  writeMigration(migrationsDir, filename, 'CREATE TABLE tamper_target (value TEXT);');
  migrate(migrationsDir);

  writeMigration(
    migrationsDir,
    filename,
    'CREATE TABLE tamper_target (value TEXT);\n-- changed after application',
  );

  // MUTATION: Reverting checksum verification silently accepts the tampered file,
  // so this assertion fails because migrate() does not throw.
  assert.throws(
    () => migrate(migrationsDir),
    /migration 001_tamper_target\.sql content changed after it was applied \(recorded [0-9a-f]{8} != current [0-9a-f]{8}\)/,
  );
});

test('an applied migration with a NULL checksum remains unverifiable and does not throw', (t) => {
  const { db, migrate, migrationsDir } = setup(t);
  const filename = '001_legacy.sql';
  writeMigration(migrationsDir, filename, 'CREATE TABLE legacy_data (value TEXT);');
  migrate(migrationsDir);
  db.prepare('UPDATE schema_version SET content_sha256 = NULL WHERE version = 1').run();
  writeMigration(migrationsDir, filename, 'SELECT 1; -- current bytes were never observed');

  assert.doesNotThrow(() => migrate(migrationsDir));
  assert.equal(
    db.prepare('SELECT content_sha256 FROM schema_version WHERE version = 1').get().content_sha256,
    null,
  );
});

test('bootstrap adds content_sha256 to a legacy schema_version table without data loss', (t) => {
  const { db, migrate, migrationsDir } = setup(t);
  db.exec(`
    CREATE TABLE schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    );
    INSERT INTO schema_version (version, applied_at) VALUES (1, '2026-01-02 03:04:05');
  `);
  writeMigration(migrationsDir, '001_legacy_applied.sql', 'SELECT 1;');

  migrate(migrationsDir);

  assert.equal(
    db.pragma('table_info(schema_version)').some(column => column.name === 'content_sha256'),
    true,
  );
  assert.deepEqual(
    db.prepare(
      'SELECT version, applied_at, content_sha256 FROM schema_version WHERE version = 1'
    ).get(),
    { version: 1, applied_at: '2026-01-02 03:04:05', content_sha256: null },
  );
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
