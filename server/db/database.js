const Database = require('better-sqlite3');
const { createHash } = require('node:crypto');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

/**
 * Creates and initializes a SQLite database with WAL mode and migration support.
 * @param {string} dbPath - Path to the SQLite database file
 * @returns {{ db: Database, migrate: (migrationsDir?: string) => void, close: () => void }}
 */
function createDatabase(dbPath) {
  const db = new Database(dbPath);

  // Performance pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('recursive_triggers = ON');
  if (db.pragma('recursive_triggers', { simple: true }) !== 1) {
    throw new Error('SQLite recursive_triggers must be enabled');
  }

  function migrate(migrationsDir = join(__dirname, 'migrations')) {
    const seenVersions = new Map();
    const migrations = readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .map(file => {
        const match = /^(\d+)_.+\.sql$/.exec(file);
        if (!match) {
          throw new Error(`malformed migration filename "${file}"; expected NNN_name.sql`);
        }

        const version = Number(match[1]);
        if (!Number.isSafeInteger(version) || version <= 0) {
          throw new Error(`migration version must be a positive integer: "${file}"`);
        }

        const duplicate = seenVersions.get(version);
        if (duplicate) {
          throw new Error(`duplicate migration version ${version}: "${duplicate}" and "${file}"`);
        }
        seenVersions.set(version, file);
        return { file, version };
      })
      .sort((a, b) => a.version - b.version);

    // Ensure schema_version table exists (bootstrap)
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT DEFAULT (datetime('now'))
      )
    `);

    const schemaVersionColumns = db.pragma('table_info(schema_version)');
    if (!schemaVersionColumns.some(column => column.name === 'content_sha256')) {
      try {
        db.exec('ALTER TABLE schema_version ADD COLUMN content_sha256 TEXT');
      } catch (err) {
        if (
          err.code !== 'SQLITE_ERROR' ||
          !/duplicate column name:\s*content_sha256/i.test(err.message)
        ) {
          throw err;
        }
      }
    }

    // migrate() is single-runner by design: it reads the applied set once here
    // and loops. Concurrent boot against one DB is unsupported (pre-existing —
    // this read, the ALTER above, and re-execution all assume a single runner;
    // the app runs one control-plane instance per DB). Under that assumption an
    // apply-path row is always created by the current migration's transaction,
    // so the unconditional checksum UPDATE below records the runner's
    // authoritative hash (correcting a migration that self-inserts its own
    // schema_version row). Full concurrent-boot safety is out of scope.
    const appliedRows = db.prepare(
      'SELECT version, content_sha256 FROM schema_version'
    ).all();
    const appliedVersions = appliedRows.map(row => Number(row.version));
    const applied = new Set(appliedVersions);
    const recordedChecksums = new Map(
      appliedRows.map(row => [Number(row.version), row.content_sha256])
    );
    let maxApplied = appliedVersions.length ? Math.max(...appliedVersions) : 0;

    for (const { file, version } of migrations) {
      if (applied.has(version)) {
        const sql = readFileSync(join(migrationsDir, file), 'utf-8');
        const currentChecksum = createHash('sha256').update(sql).digest('hex');
        const recordedChecksum = recordedChecksums.get(version);
        if (recordedChecksum !== null && recordedChecksum !== currentChecksum) {
          throw new Error(
            `migration ${file} content changed after it was applied ` +
            `(recorded ${recordedChecksum.slice(0, 8)} != current ${currentChecksum.slice(0, 8)})`
          );
        }
        continue;
      }
      if (version < maxApplied) {
        throw new Error(
          `retroactive migration ${file} is below the applied head (${maxApplied}) — renumber it above the head`
        );
      }

      const sql = readFileSync(join(migrationsDir, file), 'utf-8');
      const contentSha256 = createHash('sha256').update(sql).digest('hex');
      // Check if this migration opts into FK-off mode (exact first-line match only)
      const firstLine = sql.split('\n')[0].trim();
      const fkOff = firstLine === '-- migrate:no-foreign-keys';

      if (fkOff) {
        // FK-off safe-alter sequence (better-sqlite3 12.10 - pragma string form required)
        if (db.inTransaction) throw new Error('unexpected open txn before FK-off migration');
        db.pragma('foreign_keys = OFF');
        try {
          db.exec('BEGIN');
          db.exec(sql);
          const v = db.pragma('foreign_key_check');
          if (v.length) throw new Error('FK violation: ' + JSON.stringify(v[0]));
          if (!db.prepare('SELECT 1 FROM schema_version WHERE version = ?').get(version)) {
            db.prepare(
              'INSERT INTO schema_version (version, content_sha256) VALUES (?, ?)'
            ).run(version, contentSha256);
          } else {
            db.prepare(
              'UPDATE schema_version SET content_sha256 = ? WHERE version = ?'
            ).run(contentSha256, version);
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
      } else {
        db.transaction(() => {
          if (version === 34) {
            // Slice 2a needs procedural evidence union before owner-unique
            // indexes are created; keep merge + DDL atomic in this migration tx.
            require('../services/ownerMergeSlice2a').runSlice2aMerge(db);
          }
          db.exec(sql);
          // If migration already inserts into schema_version, skip duplicate
          const exists = db.prepare(
            'SELECT 1 FROM schema_version WHERE version = ?'
          ).get(version);
          if (!exists) {
            db.prepare(
              'INSERT INTO schema_version (version, content_sha256) VALUES (?, ?)'
            ).run(version, contentSha256);
          } else {
            db.prepare(
              'UPDATE schema_version SET content_sha256 = ? WHERE version = ?'
            ).run(contentSha256, version);
          }
        })();
      }

      applied.add(version);
      maxApplied = version;
    }
  }

  function close() {
    db.close();
  }

  return { db, migrate, close };
}

module.exports = { createDatabase };
