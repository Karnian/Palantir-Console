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
      db.transaction(() => {
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

  function close() {
    db.close();
  }

  return { db, migrate, close };
}

module.exports = { createDatabase };
