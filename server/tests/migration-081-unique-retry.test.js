'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const migrationSql = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '081_unique_retry_attempt.sql'),
  'utf8',
);

test('migration 081 preserves duplicate history and enforces one row per root attempt', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      retry_root_run_id TEXT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0
    );
  `);
  const insert = db.prepare(
    'INSERT INTO runs (id, retry_root_run_id, retry_count) VALUES (?, ?, ?)',
  );
  insert.run('retry_a', 'root_1', 1);
  insert.run('retry_b', 'root_1', 1);
  insert.run('retry_c', 'root_1', 2);
  insert.run('retry_d', 'root_1', 2);
  insert.run('manual_a', null, 0);
  insert.run('manual_b', null, 0);

  db.exec(migrationSql);

  const retries = db.prepare(`
    SELECT id, retry_count
    FROM runs
    WHERE retry_root_run_id = 'root_1'
    ORDER BY retry_count ASC
  `).all();
  assert.equal(retries.length, 4, 'historical duplicate runs are retained');
  assert.deepEqual(retries.map((run) => run.retry_count), [1, 2, 3, 4]);

  const index = db.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'index' AND name = 'ux_runs_retry_root_count'
  `).get();
  assert.match(index.sql, /UNIQUE INDEX/i);
  assert.match(index.sql, /WHERE retry_root_run_id IS NOT NULL/i);

  assert.throws(
    () => insert.run('retry_loser', 'root_1', 1),
    (error) => error.code === 'SQLITE_CONSTRAINT_UNIQUE',
  );
  assert.doesNotThrow(
    () => insert.run('manual_c', null, 0),
    'manual executions remain outside the partial index',
  );
  db.close();
});
