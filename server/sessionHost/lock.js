'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function acquireLock(runtimeDir) {
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(runtimeDir, 0o700);
  const db = new Database(path.join(runtimeDir, 'host.lock'), { timeout: 0 });
  try {
    db.pragma('busy_timeout = 0');
    db.pragma('locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner(pid INTEGER); DELETE FROM owner;');
    db.prepare('INSERT INTO owner VALUES(?)').run(process.pid);
    db.exec('COMMIT');
  } catch (error) {
    db.close();
    const failure = new Error(error.code === 'SQLITE_BUSY' ? 'host_locked' : 'lock_failed');
    failure.code = failure.message;
    throw failure;
  }
  // EXCLUSIVE locking mode retains the kernel lock after COMMIT until close.
  return { release() { if (db.open) db.close(); } };
}
module.exports = { acquireLock };
