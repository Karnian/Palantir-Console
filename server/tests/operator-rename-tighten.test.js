'use strict';

// PM→Operator rename Phase 4 (FINAL CLEANUP) — migration 046 tighten test.
//
// Mirrors operator-rename-migration.test.js (the 045 test). We build a v45 DB
// (relaxed CHECKs that still accept the legacy 'pm' form), seed residual
// 'pm:' / 'pm' rows, then apply migration 046 through the FK-off runner and
// assert:
//   (a) the defensive sweep migrated the residual pm rows → operator,
//   (b) all child rows are preserved + foreign_key_check empty + FK on +
//       schema_version = 46,
//   (c) the tightened CHECKs now REJECT 'pm' but still accept 'operator'/'top',
//   (d) indexes + columns are intact.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MIG_DIR = path.join(__dirname, '..', 'db', 'migrations');

const RUN_COLUMNS = [
  'id',
  'task_id',
  'agent_profile_id',
  'worktree_path',
  'branch',
  'tmux_session',
  'status',
  'prompt',
  'result_summary',
  'exit_code',
  'input_tokens',
  'output_tokens',
  'cost_usd',
  'error_message',
  'started_at',
  'ended_at',
  'created_at',
  'is_manager',
  'parent_run_id',
  'claude_session_id',
  'manager_adapter',
  'manager_thread_id',
  'manager_layer',
  'conversation_id',
  'mcp_config_path',
  'mcp_config_snapshot',
  'preset_id',
  'preset_snapshot_hash',
  'queued_args',
  'retry_count',
];

const COMPOSITION_EVENT_COLUMNS = [
  'id',
  'run_id',
  'conversation_id',
  'task_id',
  'slot_kind',
  'provenance_key',
  'mode',
  'composer_version',
  'policy_version',
  'prompt_payload_hash',
  'retrieval_query_hash',
  'token_budget',
  'owner_vector_hash',
  'selected_set_hash',
  'fingerprint',
  'block_hash',
  'status',
  'created_at',
  'accepted_at',
];

const RUN_INDEXES = [
  'idx_runs_task',
  'idx_runs_status',
  'idx_runs_parent',
  'idx_runs_manager',
  'idx_runs_manager_adapter',
  'idx_runs_manager_layer',
  'idx_runs_conversation_id',
];

const CHILD_TABLES = [
  'run_events',
  'approvals',
  'external_sessions',
  'run_skill_packs',
  'run_acceptance_checks',
  'run_preset_snapshots',
];

// Apply migrations 001..maxVersion faithfully (bootstrap schema_version and
// honor the v34 procedural merge hook), matching database.js:migrate order.
function applyMigrationsUpTo(db, maxVersion) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))");
  const files = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const v = parseInt(f.split('_')[0], 10);
    if (Number.isNaN(v) || v > maxVersion) continue;
    if (v === 34) require('../services/ownerMergeSlice2a').runSlice2aMerge(db);
    db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
    if (!db.prepare('SELECT 1 FROM schema_version WHERE version = ?').get(v)) {
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(v);
    }
  }
}

// Apply a single FK-off migration exactly like db/database.js does for files
// carrying the `-- migrate:no-foreign-keys` marker.
function applyFkOffMigration(db, version, sql) {
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
}

// Build a v45 DB (relaxed CHECKs accept both 'pm' and 'operator'), optionally
// seed, then apply migration 046 (tighten) via the FK-off runner.
function migratedThrough046(t, seed) {
  const state = { db: null };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-tighten-'));
  const dbPath = path.join(dir, 'test.db');
  t.after(() => {
    if (state.db) {
      try { state.db.close(); } catch { /* noop */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  state.db = new Database(dbPath);
  state.db.pragma('foreign_keys = ON');
  applyMigrationsUpTo(state.db, 45);
  assert.equal(state.db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 45, 'seeded at v45');
  if (seed) seed(state.db);

  const sql = fs.readFileSync(path.join(MIG_DIR, '046_operator_rename_tighten.sql'), 'utf8');
  assert.match(sql, /^-- migrate:no-foreign-keys/, '046 must carry the FK-off marker');
  applyFkOffMigration(state.db, 46, sql);
  return state.db;
}

function insertRun(db, {
  id,
  taskId = null,
  parentRunId = null,
  managerLayer = null,
  conversationId = null,
  isManager = 0,
}) {
  db.prepare(`
    INSERT INTO runs
      (id, task_id, status, prompt, is_manager, parent_run_id, manager_layer, conversation_id)
    VALUES
      (@id, @task_id, 'queued', @prompt, @is_manager, @parent_run_id, @manager_layer, @conversation_id)
  `).run({
    id,
    task_id: taskId,
    prompt: `prompt:${id}`,
    is_manager: isManager,
    parent_run_id: parentRunId,
    manager_layer: managerLayer,
    conversation_id: conversationId,
  });
}

function insertCompositionEvent(db, {
  id,
  runId = 'run-ledger',
  conversationId = null,
  taskId = null,
  slotKind = 'operator',
  provenanceKey = 'pk',
  selectedSetHash = null,
  status = 'pending',
  acceptedAt = null,
}) {
  db.prepare(`
    INSERT INTO memory_composition_events
      (id, run_id, conversation_id, task_id, slot_kind, provenance_key,
       composer_version, policy_version, selected_set_hash, fingerprint, status, accepted_at)
    VALUES
      (@id, @run_id, @conversation_id, @task_id, @slot_kind, @provenance_key,
       'composer-test', 'policy-test', @selected_set_hash, @fingerprint, @status, @accepted_at)
  `).run({
    id,
    run_id: runId,
    conversation_id: conversationId,
    task_id: taskId,
    slot_kind: slotKind,
    provenance_key: provenanceKey,
    selected_set_hash: selectedSetHash,
    fingerprint: `fp:${id}`,
    status,
    accepted_at: acceptedAt,
  });
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
}

function columnMap(db, table) {
  return new Map(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => [r.name, r]));
}

function fkOn(db) {
  return db.pragma('foreign_keys', { simple: true });
}

test('(a) defensive sweep rewrites residual pm:/pm rows to operator', (t) => {
  const db = migratedThrough046(t, (pre) => {
    // Residual legacy rows that Phase 1/2 did not (hypothetically) migrate.
    insertRun(pre, { id: 'run-pm', managerLayer: 'pm', conversationId: 'pm:legacy', isManager: 1 });
    insertRun(pre, { id: 'run-op', managerLayer: 'operator', conversationId: 'operator:kept', isManager: 1 });
    insertRun(pre, { id: 'run-upper', managerLayer: 'operator', conversationId: 'PM:kept', isManager: 1 });
    insertRun(pre, { id: 'run-top', managerLayer: 'top', conversationId: 'top', isManager: 1 });

    insertCompositionEvent(pre, { id: 'ce-pm', runId: 'run-pm', conversationId: 'pm:legacy', slotKind: 'pm', provenanceKey: 'pk-1' });
    insertCompositionEvent(pre, { id: 'ce-op', runId: 'run-op', conversationId: 'operator:kept', slotKind: 'operator', provenanceKey: 'pk-2' });
    insertCompositionEvent(pre, { id: 'ce-top', runId: 'run-top', conversationId: 'top', slotKind: 'top', provenanceKey: 'pk-3' });
  });

  // runs: pm → operator (layer + conversation_id); other forms untouched.
  const runs = new Map(
    db.prepare('SELECT id, manager_layer, conversation_id FROM runs ORDER BY id').all().map((r) => [r.id, r])
  );
  assert.deepEqual(runs.get('run-pm'), { id: 'run-pm', manager_layer: 'operator', conversation_id: 'operator:legacy' });
  assert.deepEqual(runs.get('run-op'), { id: 'run-op', manager_layer: 'operator', conversation_id: 'operator:kept' });
  // Uppercase PM: is NOT a match for the lowercase substr sweep — left as-is.
  assert.deepEqual(runs.get('run-upper'), { id: 'run-upper', manager_layer: 'operator', conversation_id: 'PM:kept' });
  assert.deepEqual(runs.get('run-top'), { id: 'run-top', manager_layer: 'top', conversation_id: 'top' });

  // composition events: slot_kind pm → operator; conversation_id pm: → operator:
  const events = new Map(
    db.prepare('SELECT id, slot_kind, conversation_id FROM memory_composition_events ORDER BY id').all().map((r) => [r.id, r])
  );
  assert.deepEqual(events.get('ce-pm'), { id: 'ce-pm', slot_kind: 'operator', conversation_id: 'operator:legacy' });
  assert.deepEqual(events.get('ce-op'), { id: 'ce-op', slot_kind: 'operator', conversation_id: 'operator:kept' });
  assert.deepEqual(events.get('ce-top'), { id: 'ce-top', slot_kind: 'top', conversation_id: 'top' });

  // No residual legacy form remains.
  const residual = db.prepare(
    "SELECT COUNT(*) AS c FROM runs WHERE substr(conversation_id,1,3)='pm:' OR manager_layer='pm'"
  ).get().c;
  assert.equal(residual, 0, 'no residual pm rows');
});

test('(b) child rows preserved, parent links intact, FK check empty, schema_version=46', (t) => {
  const db = migratedThrough046(t, (pre) => {
    pre.prepare("INSERT INTO projects(id, name) VALUES('p1', 'Project 1')").run();
    pre.prepare("INSERT INTO tasks(id, project_id, title) VALUES('t1', 'p1', 'Task 1')").run();

    // Legacy-form parent + child, both in the pm layer to exercise the sweep
    // through the rebuild path.
    insertRun(pre, { id: 'run-b', taskId: 't1', managerLayer: 'pm', conversationId: 'pm:parent', isManager: 1 });
    insertRun(pre, { id: 'run-a', taskId: 't1', parentRunId: 'run-b', managerLayer: 'pm', conversationId: 'pm:child', isManager: 1 });

    pre.prepare("INSERT INTO run_events(run_id, event_type, payload_json) VALUES('run-a', 'log', '{}')").run();
    pre.prepare("INSERT INTO approvals(run_id, prompt, response) VALUES('run-a', 'Approve?', 'yes')").run();
    pre.prepare("INSERT INTO external_sessions(run_id, provider, external_session_id) VALUES('run-a', 'claude', 'ext-1')").run();
    pre.prepare("INSERT INTO run_skill_packs(run_id, skill_pack_name, prompt_text) VALUES('run-a', 'Pack 1', 'prompt')").run();
    pre.prepare("INSERT INTO run_acceptance_checks(run_id, check_index, checked) VALUES('run-a', 0, 1)").run();
    pre.prepare("INSERT INTO run_preset_snapshots(run_id, preset_id, preset_snapshot_hash, snapshot_json, file_hashes) VALUES('run-a', 'preset-1', 'hash-1', '{}', '[]')").run();
  });

  for (const table of CHILD_TABLES) {
    const count = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE run_id = 'run-a'`).get().c;
    assert.equal(count, 1, `${table} row preserved`);
  }

  assert.equal(db.prepare("SELECT parent_run_id FROM runs WHERE id = 'run-a'").get().parent_run_id, 'run-b');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM runs WHERE id IN ('run-a', 'run-b')").get().c, 2);
  // Both were swept to operator.
  assert.equal(db.prepare("SELECT conversation_id FROM runs WHERE id = 'run-a'").get().conversation_id, 'operator:child');
  assert.equal(db.prepare("SELECT conversation_id FROM runs WHERE id = 'run-b'").get().conversation_id, 'operator:parent');

  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(fkOn(db), 1);
  assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 46);
});

test("(c) tightened CHECKs reject 'pm' but accept 'operator'/'top'", (t) => {
  const db = migratedThrough046(t);

  const insertRunLayer = db.prepare('INSERT INTO runs(id, manager_layer) VALUES(?, ?)');
  insertRunLayer.run('run-operator', 'operator');
  insertRunLayer.run('run-top', 'top');
  insertRunLayer.run('run-null', null); // NULL still allowed
  assert.throws(() => insertRunLayer.run('run-pm', 'pm'), /CHECK|constraint/i);
  assert.throws(() => insertRunLayer.run('run-garbage', 'garbage'), /CHECK|constraint/i);

  const insertEventSlot = db.prepare(`
    INSERT INTO memory_composition_events
      (id, run_id, slot_kind, provenance_key, composer_version, policy_version, fingerprint)
    VALUES (?, ?, ?, 'pk', 'composer', 'policy', ?)
  `);
  insertEventSlot.run('event-operator', 'run-operator', 'operator', 'fp-op');
  insertEventSlot.run('event-top', 'run-top', 'top', 'fp-top');
  assert.throws(() => insertEventSlot.run('event-pm', 'run-operator', 'pm', 'fp-pm'), /CHECK|constraint/i);
  assert.throws(() => insertEventSlot.run('event-garbage', 'run-operator', 'garbage', 'fp-bad'), /CHECK|constraint/i);
});

test('(d) schema fidelity: columns, defaults, FKs, indexes, and no triggers', (t) => {
  const db = migratedThrough046(t);

  assert.deepEqual(columnNames(db, 'runs'), RUN_COLUMNS);
  assert.deepEqual(columnNames(db, 'memory_composition_events'), COMPOSITION_EVENT_COLUMNS);

  const runCols = columnMap(db, 'runs');
  assert.equal(runCols.get('status').dflt_value, "'queued'");
  assert.equal(runCols.get('input_tokens').dflt_value, '0');
  assert.equal(runCols.get('output_tokens').dflt_value, '0');
  assert.equal(runCols.get('cost_usd').dflt_value, '0');
  assert.match(runCols.get('created_at').dflt_value, /datetime\('now'\)/);
  assert.equal(runCols.get('is_manager').dflt_value, '0');
  assert.equal(runCols.get('retry_count').notnull, 1);
  assert.equal(runCols.get('retry_count').dflt_value, '0');

  const eventCols = columnMap(db, 'memory_composition_events');
  assert.equal(eventCols.get('slot_kind').notnull, 1);
  assert.equal(eventCols.get('status').notnull, 1);
  assert.equal(eventCols.get('status').dflt_value, "'pending'");
  assert.match(eventCols.get('created_at').dflt_value, /datetime\('now'\)/);

  const runFks = db.prepare('PRAGMA foreign_key_list(runs)').all();
  assert.ok(runFks.some((fk) => fk.from === 'task_id' && fk.table === 'tasks' && fk.on_delete === 'CASCADE'));
  assert.ok(runFks.some((fk) => fk.from === 'agent_profile_id' && fk.table === 'agent_profiles' && fk.on_delete === 'SET NULL'));
  assert.ok(runFks.some((fk) => fk.from === 'parent_run_id' && fk.table === 'runs' && fk.on_delete === 'SET NULL'));

  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'runs'").all().map((r) => r.name);
  for (const index of RUN_INDEXES) {
    assert.ok(indexes.includes(index), `${index} exists`);
  }

  const compositionIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'memory_composition_events'").all().map((r) => r.name);
  assert.ok(compositionIndexes.includes('idx_composition_events_gate'));

  const triggers = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'trigger' AND tbl_name IN ('runs', 'memory_composition_events')
  `).all();
  assert.deepEqual(triggers, []);

  // Tightened CHECK text no longer mentions 'pm'.
  const runsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='runs'").get().sql;
  assert.match(runsSql, /manager_layer.*IN\s*\('top','operator'\)/);
  assert.doesNotMatch(runsSql, /'pm'/);
  const eventsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_composition_events'").get().sql;
  assert.match(eventsSql, /slot_kind.*IN\s*\('top','operator'\)/);
  assert.doesNotMatch(eventsSql, /'pm'/);
});
