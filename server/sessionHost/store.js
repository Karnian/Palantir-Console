'use strict';
const Database = require('better-sqlite3');

function openStore(dbPath, { faults, now = Date.now, readHooks } = {}) {
  if (!dbPath) throw new Error('host_db_path_required');
  const db = new Database(dbPath);
  let failed = false;
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('secure_delete = ON');
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS host_schema_versions(version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO host_schema_versions VALUES(1);
      CREATE TABLE IF NOT EXISTS owned_sessions(
        id TEXT PRIMARY KEY, cwd TEXT, claude_session_id TEXT, title TEXT,
        state TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS incarnations(
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, host_boot_id TEXT NOT NULL,
        state TEXT NOT NULL, pid INTEGER, pid_started_at TEXT, sdk_version TEXT,
        cli_path TEXT, cli_sha256 TEXT, account_snapshot TEXT, capabilities TEXT,
        started_at INTEGER, ended_at INTEGER, end_reason TEXT,
        turn_gen INTEGER NOT NULL DEFAULT 0, attribution_uncertain INTEGER NOT NULL DEFAULT 0,
        interrupt_unknown INTEGER NOT NULL DEFAULT 0, close_after_turn INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS deliveries(
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, incarnation_id TEXT, kind TEXT NOT NULL,
        body TEXT, target_tool_use_id TEXT, turn_gen INTEGER, request_key TEXT NOT NULL UNIQUE,
        fingerprint TEXT NOT NULL, message_uuid TEXT UNIQUE, state TEXT NOT NULL, outcome TEXT,
        reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, seq INTEGER,
        result_json TEXT, tainted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS tool_requests(
        id TEXT PRIMARY KEY, incarnation_id TEXT NOT NULL, tool_use_id TEXT NOT NULL,
        tool_name TEXT, input TEXT, state TEXT NOT NULL, decision TEXT, answer_delivery_id TEXT,
        UNIQUE(incarnation_id,tool_use_id));
      CREATE TABLE IF NOT EXISTS control_requests(
        request_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, kind TEXT NOT NULL,
        session_id TEXT, incarnation_id TEXT, stage TEXT NOT NULL, state TEXT NOT NULL,
        reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, seq INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_control ON control_requests(session_id) WHERE state='accepted';
      CREATE TABLE IF NOT EXISTS events(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, incarnation_id TEXT,
        type TEXT NOT NULL, json TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS request_tombstones(
        request_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL,
        session_deleted INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS event_session ON events(session_id,seq);
      CREATE INDEX IF NOT EXISTS delivery_incarnation ON deliveries(incarnation_id,state);`);
    const version = db.prepare('SELECT MAX(version) v FROM host_schema_versions').get().v;
    if (![1, 2].includes(version)) throw new Error('host_schema_unsupported');
    if (version === 1) {
      db.exec(`CREATE TABLE request_aliases(request_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
        target_delivery_id TEXT NOT NULL, session_id TEXT NOT NULL, created_at INTEGER NOT NULL);
        INSERT INTO host_schema_versions VALUES(2);`);
    }
  })();
  const store = {
    db,
    get failed() { return failed; },
    read(fn) { return db.transaction(fn).deferred(); },
    readCheckpoint() { readHooks?.afterState?.(); },
    write(fn) {
      if (failed) throw new Error('storage_unavailable');
      try { return db.transaction(() => { faults?.hit?.('db_write'); return fn(); }).immediate(); }
      catch (e) { if (e.name !== 'SimulatedCrash') failed = true; throw e; }
    },
    event(sessionId, incarnationId, type, data) {
      return Number(db.prepare('INSERT INTO events(session_id,incarnation_id,type,json,created_at) VALUES(?,?,?,?,?)')
        .run(sessionId || null, incarnationId || null, type, JSON.stringify(data), now()).lastInsertRowid);
    },
    close() { db.close(); }
  };
  return store;
}
module.exports = { openStore };
