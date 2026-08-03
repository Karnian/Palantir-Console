const Database = require('better-sqlite3');
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

    const appliedVersions = db.prepare(
      'SELECT version FROM schema_version'
    ).all().map(row => Number(row.version));
    const applied = new Set(appliedVersions);
    let maxApplied = appliedVersions.length ? Math.max(...appliedVersions) : 0;

    for (const { file, version } of migrations) {
      if (applied.has(version)) continue;
      if (version < maxApplied) {
        throw new Error(
          `retroactive migration ${file} is below the applied head (${maxApplied}) — renumber it above the head`
        );
      }

      const sql = readFileSync(join(migrationsDir, file), 'utf-8');
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
            db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
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
