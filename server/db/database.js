const Database = require('better-sqlite3');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

/**
 * Creates and initializes a SQLite database with WAL mode and migration support.
 * @param {string} dbPath - Path to the SQLite database file
 * @returns {{ db: Database, migrate: () => void, close: () => void }}
 */
function createDatabase(dbPath) {
  const db = new Database(dbPath);

  // Performance pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  function migrate() {
    const migrationsDir = join(__dirname, 'migrations');
    const files = readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    // Ensure schema_version table exists (bootstrap)
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT DEFAULT (datetime('now'))
      )
    `);

    const currentVersion = db.prepare(
      'SELECT COALESCE(MAX(version), 0) as version FROM schema_version'
    ).get().version;

    for (const file of files) {
      const version = parseInt(file.split('_')[0], 10);
      if (isNaN(version) || version <= currentVersion) continue;

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
    }
  }

  function close() {
    db.close();
  }

  return { db, migrate, close };
}

module.exports = { createDatabase };
