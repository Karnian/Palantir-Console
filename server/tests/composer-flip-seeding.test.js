'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createCompositionLedger } = require('../services/compositionLedger');

function setupDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-flip-seed-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(() => {
    try { close(); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

function seedProject(db, projectId) {
  db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run(projectId, projectId);
}

function insertPmLegacy(db, { runId, projectId, revision }) {
  seedProject(db, projectId);
  db.prepare(`
    INSERT INTO pm_memory_injection (pm_run_id, project_id, injected_revision, injected_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(runId, projectId, revision);
}

function insertTopLegacy(db, { runId, scope = 'user', revision }) {
  db.prepare(`
    INSERT INTO master_memory_injection (master_run_id, scope, injected_revision, injected_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(runId, scope, revision);
}

function getEvent(db, { runId, slotKind, provenanceKey }) {
  return db.prepare(`
    SELECT *
    FROM memory_composition_events
    WHERE run_id = ?
      AND slot_kind = ?
      AND provenance_key = ?
      AND status = 'accepted'
  `).get(runId, slotKind, provenanceKey);
}

function getOwnerState(db, compositionId) {
  return db.prepare(`
    SELECT *
    FROM memory_composition_owner_state
    WHERE composition_id = ?
  `).get(compositionId);
}

test('seeds PM workspace from pm_memory_injection', (t) => {
  const db = setupDb(t);
  const ledger = createCompositionLedger(db);

  insertPmLegacy(db, { runId: 'run-pm-1', projectId: 'proj-1', revision: 5 });

  const result = ledger.seedFromLegacyLedgers();

  assert.equal(result.pmSeeded, 1);
  assert.equal(result.topSeeded, 0);
  assert.equal(result.skipped, 0);

  const event = getEvent(db, { runId: 'run-pm-1', slotKind: 'pm', provenanceKey: 'proj-1' });
  assert.ok(event, 'accepted seed event exists');
  assert.equal(event.mode, 'seed');
  assert.equal(event.fingerprint, 'seed:run-pm-1:pm:proj-1');
  assert.ok(event.accepted_at, 'accepted_at is set');

  const ownerState = getOwnerState(db, event.id);
  assert.ok(ownerState, 'owner state exists');
  assert.equal(ownerState.owner_type, 'workspace');
  assert.equal(ownerState.owner_id, 'proj-1');
  assert.equal(ownerState.revision, 5);
});

test('seeds Top user from master_memory_injection scope=user', (t) => {
  const db = setupDb(t);
  const ledger = createCompositionLedger(db);

  insertTopLegacy(db, { runId: 'run-top-1', scope: 'user', revision: 10 });

  const result = ledger.seedFromLegacyLedgers();

  assert.equal(result.pmSeeded, 0);
  assert.equal(result.topSeeded, 1);
  assert.equal(result.skipped, 0);

  const event = getEvent(db, { runId: 'run-top-1', slotKind: 'top', provenanceKey: 'user' });
  assert.ok(event, 'accepted seed event exists');
  assert.equal(event.mode, 'seed');
  assert.equal(event.fingerprint, 'seed:run-top-1:top:user');
  assert.ok(event.accepted_at, 'accepted_at is set');

  const ownerState = getOwnerState(db, event.id);
  assert.ok(ownerState, 'owner state exists');
  assert.equal(ownerState.owner_type, 'user');
  assert.equal(ownerState.owner_id, 'user');
  assert.equal(ownerState.revision, 10);
});

test('KEY - after seeding, shouldCompose returns compose:false for same revision', (t) => {
  const db = setupDb(t);
  const ledger = createCompositionLedger(db);

  insertPmLegacy(db, { runId: 'run-pm-1', projectId: 'proj-1', revision: 5 });
  ledger.seedFromLegacyLedgers();

  const result = ledger.shouldCompose({
    runId: 'run-pm-1',
    slotKind: 'pm',
    provenanceKey: 'proj-1',
    currentOwnerRevisions: [{ owner_type: 'workspace', owner_id: 'proj-1', revision: 5 }],
  });

  assert.equal(result.compose, false);
  assert.equal(result.reason, 'unchanged');
});

test('KEY - shouldCompose returns compose:true when revision advanced', (t) => {
  const db = setupDb(t);
  const ledger = createCompositionLedger(db);

  insertPmLegacy(db, { runId: 'run-pm-1', projectId: 'proj-1', revision: 5 });
  ledger.seedFromLegacyLedgers();

  const result = ledger.shouldCompose({
    runId: 'run-pm-1',
    slotKind: 'pm',
    provenanceKey: 'proj-1',
    currentOwnerRevisions: [{ owner_type: 'workspace', owner_id: 'proj-1', revision: 6 }],
  });

  assert.equal(result.compose, true);
  assert.ok(result.reason.startsWith('revision_increased:'), `got reason ${result.reason}`);
});

test('idempotent - second seed returns pmSeeded:0 topSeeded:0', (t) => {
  const db = setupDb(t);
  const ledger = createCompositionLedger(db);

  insertPmLegacy(db, { runId: 'run-pm-1', projectId: 'proj-1', revision: 5 });
  insertTopLegacy(db, { runId: 'run-top-1', scope: 'user', revision: 10 });

  const first = ledger.seedFromLegacyLedgers();
  assert.equal(first.pmSeeded, 1);
  assert.equal(first.topSeeded, 1);

  const second = ledger.seedFromLegacyLedgers();
  assert.equal(second.pmSeeded, 0);
  assert.equal(second.topSeeded, 0);
  assert.equal(second.skipped, 2);
});

test('does NOT double-seed run with existing real accepted composition', (t) => {
  const db = setupDb(t);
  const ledger = createCompositionLedger(db);

  insertPmLegacy(db, { runId: 'run-pm-real', projectId: 'proj-real', revision: 5 });
  db.prepare(`
    INSERT INTO memory_composition_events
      (id, run_id, slot_kind, provenance_key, mode, composer_version, policy_version,
       fingerprint, status, accepted_at)
    VALUES
      ('real-comp-1', 'run-pm-real', 'pm', 'proj-real', 'live', '0.1.0', '0.1.0',
       'real:run-pm-real:pm:proj-real', 'accepted', datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO memory_composition_owner_state
      (composition_id, owner_type, owner_id, provenance_key, revision)
    VALUES
      ('real-comp-1', 'workspace', 'proj-real', 'proj-real', 5)
  `).run();

  const result = ledger.seedFromLegacyLedgers();

  assert.equal(result.pmSeeded, 0);
  assert.equal(result.topSeeded, 0);
  assert.equal(result.skipped, 1);

  const count = db.prepare(`
    SELECT COUNT(*) AS c
    FROM memory_composition_events
    WHERE run_id = 'run-pm-real'
      AND slot_kind = 'pm'
      AND provenance_key = 'proj-real'
      AND status = 'accepted'
  `).get();
  assert.equal(count.c, 1);
});

test('ignores scope=cross_project in master_memory_injection', (t) => {
  const db = setupDb(t);
  const ledger = createCompositionLedger(db);

  insertTopLegacy(db, { runId: 'run-top-cross-1', scope: 'cross_project', revision: 10 });

  const result = ledger.seedFromLegacyLedgers();

  assert.equal(result.pmSeeded, 0);
  assert.equal(result.topSeeded, 0);
  assert.equal(result.skipped, 0);

  const count = db.prepare(`
    SELECT COUNT(*) AS c
    FROM memory_composition_events
    WHERE run_id = 'run-top-cross-1'
  `).get();
  assert.equal(count.c, 0);
});
