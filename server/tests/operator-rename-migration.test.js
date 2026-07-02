'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createDatabase } = require('../db/database');
const { createCompositionLedger } = require('../services/compositionLedger');

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
  // Fleet P1a (migration 047): worker-run node snapshot — ALTER ADD appends at end.
  'node_id',
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

// Faithfully replicate database.js:migrate up to maxVersion: bootstrap
// schema_version and honor the v34 procedural merge hook.
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

function migratedThrough045(t, seed) {
  const state = { pre: null, handle: null };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-rename-'));
  const dbPath = path.join(dir, 'test.db');
  t.after(() => {
    if (state.pre) {
      try { state.pre.close(); } catch { /* noop */ }
    }
    if (state.handle) {
      try { state.handle.close(); } catch { /* noop */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  state.pre = new Database(dbPath);
  state.pre.pragma('foreign_keys = ON');
  applyMigrationsUpTo(state.pre, 44);
  if (seed) seed(state.pre);
  state.pre.close();
  state.pre = null;

  state.handle = createDatabase(dbPath);
  state.handle.migrate();
  return state.handle.db;
}

function directDb(t, prefix = 'op-rename-direct-') {
  const state = { db: null };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, 'test.db');
  t.after(() => {
    if (state.db) {
      try { state.db.close(); } catch { /* noop */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  state.db = new Database(dbPath);
  state.db.pragma('foreign_keys = ON');
  state.db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))");
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
  slotKind = 'pm',
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

test('(1) runs rebuild preserves all inbound child rows and parent links', (t) => {
  const db = migratedThrough045(t, (pre) => {
    pre.prepare("INSERT INTO projects(id, name) VALUES('p1', 'Project 1')").run();
    pre.prepare("INSERT INTO tasks(id, project_id, title) VALUES('t1', 'p1', 'Task 1')").run();

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
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(fkOn(db), 1);
  // migrate() applies all migrations in the dir. This guard only needs the
  // rename migrations (045+046) applied — later migrations (047 fleet nodes, …)
  // legitimately advance the version, so assert a floor, not an exact match.
  assert.ok(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v >= 46);
});

test('(2) composition events, owner state, and item edges are preserved while slot_kind migrates', (t) => {
  const db = migratedThrough045(t, (pre) => {
    insertCompositionEvent(pre, {
      id: 'ce-1',
      runId: 'run-comp',
      conversationId: 'pm:alpha',
      taskId: 'task-comp',
      slotKind: 'pm',
      provenanceKey: 'workspace:p1',
      selectedSetHash: 'sel-1',
      status: 'accepted',
      acceptedAt: '2024-01-01 00:00:00',
    });
    pre.prepare(`
      INSERT INTO memory_composition_owner_state
        (composition_id, owner_type, owner_id, provenance_key, revision,
         selected_set_hash, suppressed_set_hash, selected_count, suppressed_count,
         budget_limit, budget_used)
      VALUES
        ('ce-1', 'workspace', 'p1', 'workspace:p1', 7, 'sel-owner', 'sup-owner', 3, 1, 1000, 55)
    `).run();
    pre.prepare(`
      INSERT INTO memory_composition_item_edges
        (composition_id, item_table, item_id, item_revision, content_hash, fact_key,
         kind, source_owner_type, source_owner_id, provenance_key, decision, reason,
         rank, token_cost)
      VALUES
        ('ce-1', 'memory_items', 'mem-1', 4, 'content-hash', NULL,
         'heuristic', 'workspace', 'p1', 'workspace:p1', 'included', 'fits',
         1, 12)
    `).run();
  });

  const event = db.prepare("SELECT slot_kind, conversation_id, selected_set_hash FROM memory_composition_events WHERE id = 'ce-1'").get();
  assert.deepEqual(event, {
    slot_kind: 'operator',
    conversation_id: 'operator:alpha',
    selected_set_hash: 'sel-1',
  });

  const owner = db.prepare("SELECT owner_type, owner_id, provenance_key, revision, budget_used FROM memory_composition_owner_state WHERE composition_id = 'ce-1'").get();
  assert.deepEqual(owner, {
    owner_type: 'workspace',
    owner_id: 'p1',
    provenance_key: 'workspace:p1',
    revision: 7,
    budget_used: 55,
  });

  const edge = db.prepare("SELECT item_table, item_id, item_revision, decision, token_cost FROM memory_composition_item_edges WHERE composition_id = 'ce-1'").get();
  assert.deepEqual(edge, {
    item_table: 'memory_items',
    item_id: 'mem-1',
    item_revision: 4,
    decision: 'included',
    token_cost: 12,
  });
});

test('(3) schema fidelity: columns, defaults, FKs, indexes, and no triggers', (t) => {
  const db = migratedThrough045(t);

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
});

test("(4) tightened CHECKs accept 'operator'/'top' but reject legacy 'pm' and garbage", (t) => {
  // Phase 4 (migration 046) drops 'pm' from both CHECKs.
  const db = migratedThrough045(t);

  const insertRunLayer = db.prepare('INSERT INTO runs(id, manager_layer) VALUES(?, ?)');
  insertRunLayer.run('run-operator', 'operator');
  insertRunLayer.run('run-top', 'top');
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

test('(5) conversation_id rewrite is lowercase pm: only and leaves other forms unchanged', (t) => {
  const cases = [
    ['lower', 'pm:alpha'],
    ['upper', 'PM:alpha'],
    ['operator', 'operator:x'],
    ['top', 'top'],
    ['worker', 'worker:x'],
    ['null', null],
  ];

  const db = migratedThrough045(t, (pre) => {
    for (const [name, conversationId] of cases) {
      insertRun(pre, {
        id: `run-${name}`,
        managerLayer: name === 'top' ? 'top' : (name === 'worker' || name === 'null' ? null : 'pm'),
        conversationId,
        isManager: name === 'worker' || name === 'null' ? 0 : 1,
      });
      insertCompositionEvent(pre, {
        id: `event-${name}`,
        runId: `run-${name}`,
        conversationId,
        slotKind: name === 'top' ? 'top' : 'pm',
        provenanceKey: `pk-${name}`,
      });
    }
  });

  const expected = new Map([
    ['lower', 'operator:alpha'],
    ['upper', 'PM:alpha'],
    ['operator', 'operator:x'],
    ['top', 'top'],
    ['worker', 'worker:x'],
    ['null', null],
  ]);

  for (const [name] of cases) {
    assert.equal(db.prepare('SELECT conversation_id FROM runs WHERE id = ?').get(`run-${name}`).conversation_id, expected.get(name));
    assert.equal(db.prepare('SELECT conversation_id FROM memory_composition_events WHERE id = ?').get(`event-${name}`).conversation_id, expected.get(name));
  }
});

test('(6) failing FK-off migration rolls back schema/data and restores FK enforcement', (t) => {
  const db = directDb(t, 'op-rename-fail-');
  db.exec(`
    CREATE TABLE victim (
      id TEXT PRIMARY KEY,
      note TEXT NOT NULL CHECK(note IN ('ok'))
    );
    INSERT INTO victim(id, note) VALUES('v1', 'ok');
  `);
  const originalSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'victim'").get().sql;

  const badSql = `
-- migrate:no-foreign-keys
CREATE TABLE victim_new (
  id TEXT PRIMARY KEY,
  note TEXT NOT NULL
);
INSERT INTO victim_new SELECT id, note FROM victim;
DROP TABLE victim;
ALTER TABLE victim_new RENAME TO victim;
INSERT INTO missing_table VALUES (1);
  `.trimStart();

  assert.throws(() => applyFkOffMigration(db, 900, badSql), /missing_table|no such table/i);
  assert.equal(db.inTransaction, false);
  assert.equal(fkOn(db), 1);
  assert.equal(db.prepare('SELECT 1 FROM schema_version WHERE version = 900').get(), undefined);
  assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'victim'").get().sql, originalSql);
  assert.equal(db.prepare("SELECT note FROM victim WHERE id = 'v1'").get().note, 'ok');
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'victim_new'").get(), undefined);
  assert.throws(() => db.prepare("INSERT INTO victim(id, note) VALUES('bad', 'bad')").run(), /CHECK|constraint/i);
});

test('(7) FK-off migration aborts before commit when foreign_key_check finds a dangling ref', (t) => {
  const db = directDb(t, 'op-rename-fkcheck-');
  db.exec(`
    CREATE TABLE parent (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE child (
      id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL REFERENCES parent(id) ON DELETE CASCADE
    );
    INSERT INTO parent(id) VALUES('p1');
    INSERT INTO child(id, parent_id) VALUES('c1', 'p1');
  `);
  const originalChildSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'child'").get().sql;

  const badSql = `
-- migrate:no-foreign-keys
CREATE TABLE child_new (
  id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL REFERENCES parent(id) ON DELETE CASCADE
);
INSERT INTO child_new(id, parent_id) VALUES('c1', 'missing-parent');
DROP TABLE child;
ALTER TABLE child_new RENAME TO child;
  `.trimStart();

  assert.throws(() => applyFkOffMigration(db, 901, badSql), /FK violation/);
  assert.equal(db.inTransaction, false);
  assert.equal(fkOn(db), 1);
  assert.equal(db.prepare('SELECT 1 FROM schema_version WHERE version = 901').get(), undefined);
  assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'child'").get().sql, originalChildSql);
  assert.equal(db.prepare("SELECT parent_id FROM child WHERE id = 'c1'").get().parent_id, 'p1');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('(8) compositionLedger reads operator rows and cleanup prunes to the latest (operator-only, Phase 4)', (t) => {
  const db = migratedThrough045(t);
  const ledger = createCompositionLedger(db);
  const runId = 'run-ledger-op';
  const provenanceKey = 'workspace:p1';

  insertCompositionEvent(db, {
    id: 'comp-operator-old',
    runId,
    conversationId: 'operator:p1',
    slotKind: 'operator',
    provenanceKey,
    selectedSetHash: 'sel-old',
    status: 'accepted',
    acceptedAt: '2024-01-01 00:00:00',
  });

  const gate = ledger.shouldCompose({
    runId,
    slotKind: 'operator',
    provenanceKey,
    currentOwnerRevisions: [],
  });
  assert.deepEqual(gate, { compose: false, reason: 'unchanged' });

  const priorSelected = ledger.getLastAcceptedSelectedSetHash({ runId, slotKind: 'operator', provenanceKey });
  assert.deepEqual(priorSelected, { id: 'comp-operator-old', selected_set_hash: 'sel-old' });

  insertCompositionEvent(db, {
    id: 'comp-operator-new',
    runId,
    conversationId: 'operator:p1',
    slotKind: 'operator',
    provenanceKey,
    selectedSetHash: 'sel-new',
    status: 'accepted',
    acceptedAt: '2024-01-02 00:00:00',
  });

  ledger.cleanup(runId, 'operator', provenanceKey);

  const rows = db.prepare(`
    SELECT id, slot_kind FROM memory_composition_events
    WHERE run_id = ? AND provenance_key = ? AND status = 'accepted'
    ORDER BY id
  `).all(runId, provenanceKey);
  assert.deepEqual(rows, [{ id: 'comp-operator-new', slot_kind: 'operator' }]);
});
