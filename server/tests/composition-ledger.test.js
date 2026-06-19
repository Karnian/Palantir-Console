'use strict';

/**
 * A2-2 Composition Ledger 테스트
 *
 * 검증 항목:
 * 1. migration 038 clean apply: 3 테이블 + CHECK + FK cascade + gate 인덱스 존재
 * 2. record → 3 테이블 persist (fingerprint 포함), accept pending→accepted
 * 3. gate compatibility cadence:
 *    - 직전 accepted 없음 → compose:true
 *    - 같은 revision → compose:false
 *    - owner revision 증가 → compose:true
 * 4. peek-then-commit: pending(미accept) composition은 gate가 무시
 * 5. CHECK 위반(bad status/slot_kind/decision/item_table) surface
 * 6. FK cascade (events 삭제 시 owner_state/item_edges 삭제)
 * 7. retention cleanup 동작
 * 8. 풀스위트 green: /opt/homebrew/opt/node@22/bin/node --test (baseline 1427, 새 실패 0)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createCompositionLedger } = require('../services/compositionLedger');

// ─── DB setup helper ─────────────────────────────────────────────────────────

function setupDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-cled-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(() => {
    try { close(); } catch { /* */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

// ─── fixture helpers ─────────────────────────────────────────────────────────

function makeComposition({
  fingerprint = 'fp-test-001',
  owner_states = [],
  item_edges = [],
  composer_version = '0.1.0',
  policy_version = '0.1.0',
  ...extra
} = {}) {
  return { fingerprint, owner_states, item_edges, composer_version, policy_version, ...extra };
}

function makeOpts({
  runId = 'run-001',
  conversationId = 'conv-001',
  taskId = 'task-001',
  slotKind = 'pm',
  provenanceKey = 'workspace:proj-001',
  mode = null,
  promptPayloadHash = null,
  blockHash = null,
} = {}) {
  return { runId, conversationId, taskId, slotKind, provenanceKey, mode, promptPayloadHash, blockHash };
}

// ─── 1. migration 038 apply + schema ─────────────────────────────────────────

test('migration 038: 3 tables + CHECK constraints + gate index + FK exist', (t) => {
  const db = setupDb(t);

  // All 3 tables must exist
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'memory_composition%'"
  ).all().map((r) => r.name);

  assert.ok(tables.includes('memory_composition_events'), 'memory_composition_events exists');
  assert.ok(tables.includes('memory_composition_owner_state'), 'memory_composition_owner_state exists');
  assert.ok(tables.includes('memory_composition_item_edges'), 'memory_composition_item_edges exists');

  // Gate index exists
  const indexes = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_composition_events_gate'"
  ).all();
  assert.equal(indexes.length, 1, 'gate index idx_composition_events_gate exists');

  // Partial unique index on item_edges
  const edgeIdx = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_composition_item_edges_dedup'"
  ).all();
  assert.equal(edgeIdx.length, 1, 'dedup index idx_composition_item_edges_dedup exists');

  // FK: foreign_key_list on owner_state references events
  const fkOwner = db.prepare(
    "PRAGMA foreign_key_list(memory_composition_owner_state)"
  ).all();
  assert.ok(fkOwner.some((r) => r.table === 'memory_composition_events'), 'owner_state FK → events');

  const fkEdges = db.prepare(
    "PRAGMA foreign_key_list(memory_composition_item_edges)"
  ).all();
  assert.ok(fkEdges.some((r) => r.table === 'memory_composition_events'), 'item_edges FK → events');
});

// ─── 2. record → 3 tables, accept pending→accepted ───────────────────────────

test('record() persists all 3 tables including fingerprint; accept() transitions pending→accepted', (t) => {
  const db = setupDb(t);
  const ledger = createCompositionLedger(db);

  const composition = makeComposition({
    fingerprint: 'fp-abc-123',
    owner_states: [
      {
        owner_type: 'workspace',
        owner_id: 'proj-001',
        provenance: 'workspace:proj-001',
        revision: 5,
        selected_set_hash: 'sel-hash-1',
        suppressed_set_hash: null,
        selected_count: 2,
        suppressed_count: 0,
        budget_limit: 1000000,
        budget_used: 100,
      },
    ],
    item_edges: [
      {
        item_table: 'memory_items',
        item_id: 'item-001',
        item_revision: 3,
        content_hash: 'ch-001',
        fact_key: null,
        kind: 'heuristic',
        source_owner_type: 'workspace',
        source_owner_id: 'proj-001',
        provenance: 'workspace:proj-001',
        decision: 'included',
        reason: null,
        rank: 0,
        token_cost: 50,
      },
    ],
    composer_version: '0.1.0',
    policy_version: '0.1.0',
  });

  const opts = makeOpts();
  const compositionId = ledger.record(composition, opts);

  assert.ok(compositionId, 'record() returns a compositionId');

  // events row
  const evt = db.prepare('SELECT * FROM memory_composition_events WHERE id = ?').get(compositionId);
  assert.ok(evt, 'event row exists');
  assert.equal(evt.fingerprint, 'fp-abc-123', 'fingerprint persisted');
  assert.equal(evt.status, 'pending', 'status is pending');
  assert.equal(evt.run_id, 'run-001');
  assert.equal(evt.slot_kind, 'pm');
  assert.equal(evt.provenance_key, 'workspace:proj-001');
  assert.equal(evt.composer_version, '0.1.0');
  assert.equal(evt.policy_version, '0.1.0');
  assert.equal(evt.task_id, 'task-001');
  assert.equal(evt.conversation_id, 'conv-001');
  assert.equal(evt.accepted_at, null, 'accepted_at is null for pending');

  // owner_state row
  const ownerRows = db.prepare(
    'SELECT * FROM memory_composition_owner_state WHERE composition_id = ?'
  ).all(compositionId);
  assert.equal(ownerRows.length, 1, '1 owner_state row');
  assert.equal(ownerRows[0].owner_type, 'workspace');
  assert.equal(ownerRows[0].owner_id, 'proj-001');
  assert.equal(ownerRows[0].revision, 5);

  // item_edges row
  const edgeRows = db.prepare(
    'SELECT * FROM memory_composition_item_edges WHERE composition_id = ?'
  ).all(compositionId);
  assert.equal(edgeRows.length, 1, '1 item_edge row');
  assert.equal(edgeRows[0].item_id, 'item-001');
  assert.equal(edgeRows[0].decision, 'included');
  assert.equal(edgeRows[0].rank, 0);
  assert.equal(edgeRows[0].token_cost, 50);

  // accept()
  const accepted = ledger.accept(compositionId);
  assert.equal(accepted, true, 'accept() returns true');

  const evt2 = db.prepare('SELECT status, accepted_at FROM memory_composition_events WHERE id = ?').get(compositionId);
  assert.equal(evt2.status, 'accepted', 'status → accepted');
  assert.ok(evt2.accepted_at, 'accepted_at set');

  // accept() again → idempotent (no update since status≠'pending')
  const accepted2 = ledger.accept(compositionId);
  assert.equal(accepted2, false, 'second accept() on accepted record returns false');
});

// ─── 3. gate compatibility cadence ───────────────────────────────────────────

test('shouldCompose: no prior accepted → compose:true', (t) => {
  const db = setupDb(t);
  const ledger = createCompositionLedger(db);

  const result = ledger.shouldCompose({
    runId: 'run-gate-1',
    slotKind: 'pm',
    provenanceKey: 'workspace:proj-A',
    currentOwnerRevisions: [{ owner_type: 'workspace', owner_id: 'proj-A', revision: 1 }],
  });

  assert.equal(result.compose, true);
  assert.equal(result.reason, 'no_prior_accepted');
});

test('shouldCompose: same revision as accepted → compose:false', (t) => {
  const db = setupDb(t);
  const ledger = createCompositionLedger(db);

  const runId = 'run-gate-2';
  const slotKind = 'pm';
  const provenanceKey = 'workspace:proj-B';

  // Record and accept a composition with revision=3
  const composition = makeComposition({
    fingerprint: 'fp-gate-2',
    owner_states: [
      {
        owner_type: 'workspace', owner_id: 'proj-B',
        provenance: provenanceKey,
        revision: 3,
        selected_set_hash: 'sh1', suppressed_set_hash: null,
        selected_count: 1, suppressed_count: 0,
        budget_limit: 1000000, budget_used: 10,
      },
    ],
    item_edges: [],
  });
  const id = ledger.record(composition, makeOpts({ runId, slotKind, provenanceKey }));
  ledger.accept(id);

  // Same revision → should not recompose
  const result = ledger.shouldCompose({
    runId,
    slotKind,
    provenanceKey,
    currentOwnerRevisions: [{ owner_type: 'workspace', owner_id: 'proj-B', revision: 3 }],
  });

  assert.equal(result.compose, false);
  assert.equal(result.reason, 'unchanged');
});

test('shouldCompose: owner revision increased → compose:true', (t) => {
  const db = setupDb(t);
  const ledger = createCompositionLedger(db);

  const runId = 'run-gate-3';
  const slotKind = 'pm';
  const provenanceKey = 'workspace:proj-C';

  // Accept a composition with revision=2
  const composition = makeComposition({
    fingerprint: 'fp-gate-3',
    owner_states: [
      {
        owner_type: 'workspace', owner_id: 'proj-C',
        provenance: provenanceKey,
        revision: 2,
        selected_set_hash: 'sh2', suppressed_set_hash: null,
        selected_count: 0, suppressed_count: 0,
        budget_limit: 1000000, budget_used: 0,
      },
    ],
    item_edges: [],
  });
  const id = ledger.record(composition, makeOpts({ runId, slotKind, provenanceKey }));
  ledger.accept(id);

  // Now currentOwnerRevisions shows revision=5 (increased)
  const result = ledger.shouldCompose({
    runId,
    slotKind,
    provenanceKey,
    currentOwnerRevisions: [{ owner_type: 'workspace', owner_id: 'proj-C', revision: 5 }],
  });

  assert.equal(result.compose, true);
  assert.ok(result.reason.startsWith('revision_increased:'), `reason starts with revision_increased: got ${result.reason}`);
});

// ─── 4. peek-then-commit: pending composition is invisible to gate ────────────

test('shouldCompose: pending (not-accepted) composition is ignored by gate', (t) => {
  const db = setupDb(t);
  const ledger = createCompositionLedger(db);

  const runId = 'run-peek-1';
  const slotKind = 'pm';
  const provenanceKey = 'workspace:proj-D';

  // Record but do NOT accept — stays pending
  const composition = makeComposition({
    fingerprint: 'fp-peek-1',
    owner_states: [
      {
        owner_type: 'workspace', owner_id: 'proj-D',
        provenance: provenanceKey,
        revision: 7,
        selected_set_hash: 'sh3', suppressed_set_hash: null,
        selected_count: 0, suppressed_count: 0,
        budget_limit: 1000000, budget_used: 0,
      },
    ],
    item_edges: [],
  });
  ledger.record(composition, makeOpts({ runId, slotKind, provenanceKey }));
  // NOT calling ledger.accept()

  // Gate must still see no prior accepted → compose:true
  const result = ledger.shouldCompose({
    runId,
    slotKind,
    provenanceKey,
    currentOwnerRevisions: [{ owner_type: 'workspace', owner_id: 'proj-D', revision: 7 }],
  });

  assert.equal(result.compose, true);
  assert.equal(result.reason, 'no_prior_accepted', 'pending composition not counted as accepted');
});

// ─── 5. CHECK violations surface ────────────────────────────────────────────

test('CHECK violation: bad slot_kind throws', (t) => {
  const db = setupDb(t);

  // Direct SQL insert to test the CHECK constraint
  assert.throws(() => {
    db.prepare(`
      INSERT INTO memory_composition_events
        (id, run_id, slot_kind, provenance_key, composer_version, policy_version, fingerprint, status)
      VALUES ('x', 'r', 'bad_slot', 'pk', 'v', 'v', 'fp', 'pending')
    `).run();
  }, /CHECK constraint failed/, 'bad slot_kind CHECK fires');
});

test('CHECK violation: bad status throws', (t) => {
  const db = setupDb(t);

  assert.throws(() => {
    db.prepare(`
      INSERT INTO memory_composition_events
        (id, run_id, slot_kind, provenance_key, composer_version, policy_version, fingerprint, status)
      VALUES ('x2', 'r', 'pm', 'pk', 'v', 'v', 'fp', 'invalid_status')
    `).run();
  }, /CHECK constraint failed/, 'bad status CHECK fires');
});

test('CHECK violation: bad decision on item_edge throws', (t) => {
  const db = setupDb(t);

  // Insert a valid event first
  db.prepare(`
    INSERT INTO memory_composition_events
      (id, run_id, slot_kind, provenance_key, composer_version, policy_version, fingerprint, status)
    VALUES ('evt-chk-1', 'r', 'pm', 'pk', 'v', 'v', 'fp', 'pending')
  `).run();

  assert.throws(() => {
    db.prepare(`
      INSERT INTO memory_composition_item_edges
        (composition_id, item_table, decision)
      VALUES ('evt-chk-1', 'memory_items', 'bad_decision')
    `).run();
  }, /CHECK constraint failed/, 'bad decision CHECK fires');
});

test('CHECK violation: bad item_table on item_edge throws', (t) => {
  const db = setupDb(t);

  db.prepare(`
    INSERT INTO memory_composition_events
      (id, run_id, slot_kind, provenance_key, composer_version, policy_version, fingerprint, status)
    VALUES ('evt-chk-2', 'r', 'top', 'pk', 'v', 'v', 'fp', 'pending')
  `).run();

  assert.throws(() => {
    db.prepare(`
      INSERT INTO memory_composition_item_edges
        (composition_id, item_table, decision)
      VALUES ('evt-chk-2', 'bad_table', 'included')
    `).run();
  }, /CHECK constraint failed/, 'bad item_table CHECK fires');
});

// ─── 6. FK cascade ───────────────────────────────────────────────────────────

test('FK cascade: deleting event removes owner_state and item_edges', (t) => {
  const db = setupDb(t);
  const ledger = createCompositionLedger(db);

  const composition = makeComposition({
    fingerprint: 'fp-cascade-1',
    owner_states: [
      {
        owner_type: 'workspace', owner_id: 'proj-X',
        provenance: 'workspace:proj-X',
        revision: 1,
        selected_set_hash: 'sh', suppressed_set_hash: null,
        selected_count: 1, suppressed_count: 0,
        budget_limit: 1000000, budget_used: 10,
      },
    ],
    item_edges: [
      {
        item_table: 'memory_items',
        item_id: 'item-cascade-1',
        item_revision: 1,
        content_hash: 'ch',
        fact_key: null,
        kind: 'heuristic',
        source_owner_type: 'workspace',
        source_owner_id: 'proj-X',
        provenance: 'workspace:proj-X',
        decision: 'included',
        reason: null,
        rank: 0,
        token_cost: 10,
      },
    ],
  });

  const id = ledger.record(composition, makeOpts({ runId: 'run-cas-1', provenanceKey: 'workspace:proj-X' }));
  assert.ok(id, 'record returns id');

  // Verify rows exist
  const ownerBefore = db.prepare('SELECT COUNT(*) AS c FROM memory_composition_owner_state WHERE composition_id = ?').get(id);
  assert.equal(ownerBefore.c, 1, '1 owner_state before delete');
  const edgeBefore = db.prepare('SELECT COUNT(*) AS c FROM memory_composition_item_edges WHERE composition_id = ?').get(id);
  assert.equal(edgeBefore.c, 1, '1 item_edge before delete');

  // Delete the event
  db.prepare('DELETE FROM memory_composition_events WHERE id = ?').run(id);

  // Children must be gone via CASCADE
  const ownerAfter = db.prepare('SELECT COUNT(*) AS c FROM memory_composition_owner_state WHERE composition_id = ?').get(id);
  assert.equal(ownerAfter.c, 0, 'owner_state deleted by CASCADE');
  const edgeAfter = db.prepare('SELECT COUNT(*) AS c FROM memory_composition_item_edges WHERE composition_id = ?').get(id);
  assert.equal(edgeAfter.c, 0, 'item_edges deleted by CASCADE');
});

// ─── 7. retention cleanup ────────────────────────────────────────────────────

test('cleanup(): keeps only latest accepted per (runId, slotKind, provenanceKey)', (t) => {
  const db = setupDb(t);
  const ledger = createCompositionLedger(db);

  const runId = 'run-cleanup-1';
  const slotKind = 'pm';
  const provenanceKey = 'workspace:proj-Y';
  const opts = makeOpts({ runId, slotKind, provenanceKey });

  // Record and accept 3 compositions
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const id = ledger.record(makeComposition({ fingerprint: `fp-cleanup-${i}` }), opts);
    ledger.accept(id);
    ids.push(id);
  }

  // All 3 accepted
  const beforeCleanup = db.prepare(
    "SELECT COUNT(*) AS c FROM memory_composition_events WHERE run_id = ? AND status = 'accepted'"
  ).get(runId);
  assert.equal(beforeCleanup.c, 3, '3 accepted before cleanup');

  ledger.cleanup(runId, slotKind, provenanceKey);

  const afterCleanup = db.prepare(
    "SELECT COUNT(*) AS c FROM memory_composition_events WHERE run_id = ? AND status = 'accepted'"
  ).get(runId);
  assert.equal(afterCleanup.c, 1, 'only 1 accepted remains after cleanup');

  // The remaining one must be one of the 3 we inserted (not a phantom)
  const remaining = db.prepare(
    "SELECT id FROM memory_composition_events WHERE run_id = ? AND status = 'accepted'"
  ).get(runId);
  assert.ok(ids.includes(remaining.id), 'remaining accepted is one of the original 3 ids');
});

test('cleanup(): stale pending events (>1 day) are removed by cleanupStalePending', (t) => {
  const db = setupDb(t);
  const ledger = createCompositionLedger(db);

  // Insert a stale pending event directly (backdated created_at)
  db.prepare(`
    INSERT INTO memory_composition_events
      (id, run_id, slot_kind, provenance_key, composer_version, policy_version, fingerprint, status, created_at)
    VALUES ('stale-1', 'run-stale', 'pm', 'pk-stale', 'v', 'v', 'fp-stale', 'pending',
            datetime('now', '-2 days'))
  `).run();

  // Insert a fresh pending event
  db.prepare(`
    INSERT INTO memory_composition_events
      (id, run_id, slot_kind, provenance_key, composer_version, policy_version, fingerprint, status)
    VALUES ('fresh-1', 'run-fresh', 'pm', 'pk-fresh', 'v', 'v', 'fp-fresh', 'pending')
  `).run();

  // cleanup with some arbitrary (runId, slotKind, provenanceKey) — stale pending removal is global
  ledger.cleanup('run-stale', 'pm', 'pk-stale');

  const stale = db.prepare("SELECT id FROM memory_composition_events WHERE id = 'stale-1'").get();
  assert.equal(stale, undefined, 'stale pending event removed');

  const fresh = db.prepare("SELECT id FROM memory_composition_events WHERE id = 'fresh-1'").get();
  assert.ok(fresh, 'fresh pending event retained');
});

// ─── 8. additional edge cases ────────────────────────────────────────────────

test('record() with null composition or opts returns null (never-throws)', (t) => {
  const db = setupDb(t);
  const ledger = createCompositionLedger(db);

  const r1 = ledger.record(null, makeOpts());
  assert.equal(r1, null, 'null composition → null');

  const r2 = ledger.record(makeComposition(), null);
  assert.equal(r2, null, 'null opts → null');
});

test('accept() with invalid id returns false (never-throws)', (t) => {
  const db = setupDb(t);
  const ledger = createCompositionLedger(db);

  const result = ledger.accept('non-existent-id');
  assert.equal(result, false);
});

test('shouldCompose: new owner not in prior accepted → compose:true', (t) => {
  const db = setupDb(t);
  const ledger = createCompositionLedger(db);

  const runId = 'run-newowner-1';
  const slotKind = 'top';
  const provenanceKey = 'user:u-1';

  // Accept a composition with only workspace owner
  const composition = makeComposition({
    fingerprint: 'fp-newowner-1',
    owner_states: [
      {
        owner_type: 'workspace', owner_id: 'proj-N',
        provenance: provenanceKey,
        revision: 1,
        selected_set_hash: 'sh', suppressed_set_hash: null,
        selected_count: 0, suppressed_count: 0,
        budget_limit: 1000000, budget_used: 0,
      },
    ],
    item_edges: [],
  });
  const id = ledger.record(composition, makeOpts({ runId, slotKind, provenanceKey }));
  ledger.accept(id);

  // Now add a user owner → new owner not seen in prior
  const result = ledger.shouldCompose({
    runId,
    slotKind,
    provenanceKey,
    currentOwnerRevisions: [
      { owner_type: 'workspace', owner_id: 'proj-N', revision: 1 },
      { owner_type: 'user', owner_id: 'user-1', revision: 3 },
    ],
  });

  assert.equal(result.compose, true);
  assert.ok(result.reason.startsWith('new_owner:'), `reason starts with new_owner: got ${result.reason}`);
});

test('record() with item_edges including budget_exceeded decision', (t) => {
  const db = setupDb(t);
  const ledger = createCompositionLedger(db);

  const composition = makeComposition({
    fingerprint: 'fp-budget-1',
    owner_states: [],
    item_edges: [
      {
        item_table: 'memory_items',
        item_id: 'item-budg-1',
        item_revision: 1,
        content_hash: null,
        fact_key: null,
        kind: 'heuristic',
        source_owner_type: 'workspace',
        source_owner_id: 'proj-001',
        provenance: 'workspace:proj-001',
        decision: 'budget_exceeded',
        reason: 'budget_limit=10 budget_used=5 token_cost=8',
        rank: 1,
        token_cost: 8,
      },
    ],
  });

  const id = ledger.record(composition, makeOpts());
  assert.ok(id, 'record with budget_exceeded edge works');

  const edge = db.prepare(
    "SELECT decision, reason FROM memory_composition_item_edges WHERE composition_id = ?"
  ).get(id);
  assert.equal(edge.decision, 'budget_exceeded');
  assert.ok(edge.reason.includes('budget_limit=10'));
});

test('record() with all valid decision types for item_edges', (t) => {
  const db = setupDb(t);
  const ledger = createCompositionLedger(db);

  const decisions = ['included', 'suppressed', 'truncated', 'deduped', 'conflicted', 'budget_exceeded'];
  const itemEdges = decisions.map((decision, rank) => ({
    item_table: 'memory_items',
    item_id: `item-dec-${rank}`,
    item_revision: 1,
    content_hash: null,
    fact_key: null,
    kind: 'heuristic',
    source_owner_type: 'workspace',
    source_owner_id: 'proj-001',
    provenance: null,
    decision,
    reason: null,
    rank,
    token_cost: 10,
  }));

  const composition = makeComposition({
    fingerprint: 'fp-decisions-all',
    owner_states: [],
    item_edges: itemEdges,
  });

  const id = ledger.record(composition, makeOpts({ runId: 'run-dec-all' }));
  assert.ok(id);

  const rows = db.prepare(
    "SELECT decision FROM memory_composition_item_edges WHERE composition_id = ? ORDER BY rank"
  ).all(id);
  assert.equal(rows.length, decisions.length, 'all decision rows inserted');
  for (let i = 0; i < decisions.length; i++) {
    assert.equal(rows[i].decision, decisions[i]);
  }
});

test('shouldCompose: empty currentOwnerRevisions → compose:false when prior accepted exists', (t) => {
  const db = setupDb(t);
  const ledger = createCompositionLedger(db);

  const runId = 'run-empty-owners';
  const slotKind = 'pm';
  const provenanceKey = 'workspace:proj-E';

  const id = ledger.record(makeComposition({ fingerprint: 'fp-empty' }), makeOpts({ runId, slotKind, provenanceKey }));
  ledger.accept(id);

  // No current owners to check → all prior owners unchanged (none to compare)
  const result = ledger.shouldCompose({
    runId,
    slotKind,
    provenanceKey,
    currentOwnerRevisions: [],
  });

  assert.equal(result.compose, false);
  assert.equal(result.reason, 'unchanged');
});

test('both item_tables accepted by CHECK: memory_items and master_memory_items', (t) => {
  const db = setupDb(t);

  db.prepare(`
    INSERT INTO memory_composition_events
      (id, run_id, slot_kind, provenance_key, composer_version, policy_version, fingerprint, status)
    VALUES ('evt-tbl-1', 'r', 'top', 'pk', 'v', 'v', 'fp', 'pending')
  `).run();

  // Both valid item_tables
  assert.doesNotThrow(() => {
    db.prepare(`
      INSERT INTO memory_composition_item_edges
        (composition_id, item_table, item_id, decision)
      VALUES ('evt-tbl-1', 'memory_items', 'item-a', 'included')
    `).run();
  }, 'memory_items is valid item_table');

  assert.doesNotThrow(() => {
    db.prepare(`
      INSERT INTO memory_composition_item_edges
        (composition_id, item_table, item_id, decision)
      VALUES ('evt-tbl-1', 'master_memory_items', 'item-b', 'included')
    `).run();
  }, 'master_memory_items is valid item_table');
});

// ─── NEW: event columns match composition fingerprint inputs ─────────────────

test('record(): event columns retrieval_query_hash/token_budget match composition values', (t) => {
  const db = setupDb(t);
  const ledger = createCompositionLedger(db);

  const composition = {
    fingerprint: 'fp-match-1',
    retrieval_query_hash: 'rqh-abc123',
    token_budget: 42000,
    owner_vector_hash: 'ovh-xyz789',
    selected_set_hash: 'ssh-def456',
    owner_states: [],
    item_edges: [],
    composer_version: '0.1.0',
    policy_version: '0.1.0',
  };

  const id = ledger.record(composition, makeOpts({ runId: 'run-match-1' }));
  assert.ok(id);

  const evt = db.prepare('SELECT retrieval_query_hash, token_budget, owner_vector_hash, selected_set_hash FROM memory_composition_events WHERE id = ?').get(id);
  assert.equal(evt.retrieval_query_hash, 'rqh-abc123', 'retrieval_query_hash persisted from composition');
  assert.equal(evt.token_budget, 42000, 'token_budget persisted from composition');
  assert.equal(evt.owner_vector_hash, 'ovh-xyz789', 'owner_vector_hash persisted from composition');
  assert.equal(evt.selected_set_hash, 'ssh-def456', 'selected_set_hash persisted from composition');
});

test('record(): when composition lacks the 4 fields, event columns are null', (t) => {
  const db = setupDb(t);
  const ledger = createCompositionLedger(db);

  const composition = {
    fingerprint: 'fp-null-fields',
    owner_states: [],
    item_edges: [],
    composer_version: '0.1.0',
    policy_version: '0.1.0',
  };

  const id = ledger.record(composition, makeOpts({ runId: 'run-null-fields' }));
  assert.ok(id);

  const evt = db.prepare('SELECT retrieval_query_hash, token_budget, owner_vector_hash, selected_set_hash FROM memory_composition_events WHERE id = ?').get(id);
  assert.equal(evt.retrieval_query_hash, null, 'retrieval_query_hash null when absent from composition');
  assert.equal(evt.token_budget, null, 'token_budget null when absent from composition');
  assert.equal(evt.owner_vector_hash, null, 'owner_vector_hash null when absent from composition');
  assert.equal(evt.selected_set_hash, null, 'selected_set_hash null when absent from composition');
});

test('shouldCompose(null) never-throws and returns compose:true', (t) => {
  const db = setupDb(t);
  const ledger = createCompositionLedger(db);

  let result;
  assert.doesNotThrow(() => {
    result = ledger.shouldCompose(null);
  }, 'shouldCompose(null) must not throw');
  assert.equal(result.compose, true, 'null arg degrades to compose:true');
});

test('shouldCompose(undefined) never-throws and returns compose:true', (t) => {
  const db = setupDb(t);
  const ledger = createCompositionLedger(db);

  let result;
  assert.doesNotThrow(() => {
    result = ledger.shouldCompose(undefined);
  });
  assert.equal(result.compose, true);
});

test('shouldCompose(42) never-throws and returns compose:true', (t) => {
  const db = setupDb(t);
  const ledger = createCompositionLedger(db);

  let result;
  assert.doesNotThrow(() => {
    result = ledger.shouldCompose(42);
  }, 'shouldCompose(42) must not throw');
  assert.equal(result.compose, true);
});
