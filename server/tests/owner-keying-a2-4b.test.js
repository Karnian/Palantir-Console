'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

// Re-register the slice2b kill-tests here so this A2-4b file also exercises
// the scope-keyed revision regression suite when run directly.
require('./owner-keying-slice2b.test.js');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createManagerRegistry } = require('../services/managerRegistry');
const { createConversationService } = require('../services/conversationService');
const { createMemoryService } = require('../services/memoryService');
const { createMasterMemoryService } = require('../services/masterMemoryService');
const { createCompositionLedger } = require('../services/compositionLedger');
const {
  createMemoryComposer,
  buildWorkspaceAdapter,
  buildUserAdapter,
} = require('../services/memoryComposer');
const { runSlice2aMerge } = require('../services/ownerMergeSlice2a');

const migrationsDir = path.join(__dirname, '../db/migrations');

function sha256(text) {
  return crypto.createHash('sha256').update(String(text ?? '')).digest('hex');
}

function applyMigrationFile(db, version) {
  const prefix = String(version).padStart(3, '0');
  const file = fs.readdirSync(migrationsDir)
    .filter((name) => name.startsWith(`${prefix}_`) && name.endsWith('.sql'))
    .sort()[0];
  if (!file) throw new Error(`migration ${version} not found`);
  const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
  db.transaction(() => {
    if (version === 34) runSlice2aMerge(db);
    db.exec(sql);
    db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(version);
  })();
}

function applyMigrationsThrough(db, maxVersion) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);
  const files = fs.readdirSync(migrationsDir)
    .filter((file) => /^\d+.*\.sql$/.test(file))
    .sort();
  for (const file of files) {
    const version = Number.parseInt(file.split('_')[0], 10);
    if (version > maxVersion) break;
    applyMigrationFile(db, version);
  }
}

function setupManualDb(t, maxVersion = 41) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-a24b-manual-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  applyMigrationsThrough(db, maxVersion);
  t.after(() => {
    try { db.close(); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

function setupDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-a24b-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 'test.db'));
  migrate();
  t.after(() => {
    try { close(); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

function makeComposition({
  fingerprint = `fp-${crypto.randomUUID()}`,
  ownerStates = [],
  selectedSetHash = 'selected-set',
} = {}) {
  return {
    fingerprint,
    owner_states: ownerStates,
    item_edges: [],
    composer_version: '0.1.0',
    policy_version: '0.1.0',
    retrieval_query_hash: null,
    token_budget: 2250,
    owner_vector_hash: `${fingerprint}:owners`,
    selected_set_hash: selectedSetHash,
  };
}

function topOwnerStates({ userRevision = 1, crossRevision = 1 } = {}) {
  return [
    {
      owner_type: 'user',
      owner_id: 'user',
      provenance: 'user',
      revision: userRevision,
      selected_set_hash: 'selected-user',
      suppressed_set_hash: null,
      selected_count: 1,
      suppressed_count: 0,
      budget_limit: 1500,
      budget_used: 10,
    },
    {
      owner_type: 'user',
      owner_id: 'user',
      provenance: 'cross_project',
      revision: crossRevision,
      selected_set_hash: 'selected-cross',
      suppressed_set_hash: null,
      selected_count: 1,
      suppressed_count: 0,
      budget_limit: 750,
      budget_used: 10,
    },
  ];
}

function commitTopAccepted(ledger, { runId = 'run-top-gate', userRevision = 1, crossRevision = 1 } = {}) {
  return ledger.commitAccepted(
    makeComposition({
      fingerprint: `fp-${runId}`,
      ownerStates: topOwnerStates({ userRevision, crossRevision }),
      selectedSetHash: `selected-${runId}`,
    }),
    {
      runId,
      conversationId: 'top',
      taskId: null,
      slotKind: 'top',
      provenanceKey: 'user',
    },
  );
}

function makeFakeCodexAdapter() {
  const calls = [];
  return {
    calls,
    runTurn(runId, payload) {
      calls.push({ runId, payload });
      return { accepted: true };
    },
    isSessionAlive: () => true,
    detectExitCode: () => null,
    emitSessionEndedIfNeeded: () => {},
    getUsage: () => null,
    getSessionId: () => null,
    getOutput: () => null,
    disposeSession: () => {},
  };
}

function seedTopRun(runService, registry, adapter) {
  const run = runService.createRun({ is_manager: true, manager_adapter: 'claude-code', prompt: 'top' });
  runService.updateRunStatus(run.id, 'running', { force: true });
  registry.setActive('top', run.id, adapter);
  return run;
}

function setupTopHarness(t, { memoryMultiOwner }) {
  const db = setupDb(t);
  const runService = createRunService(db, { subscribe() {}, emit() {} });
  const registry = createManagerRegistry({ runService });
  const memoryService = createMemoryService(db);
  const masterMemoryService = createMasterMemoryService(db);
  const compositionLedger = createCompositionLedger(db);
  const memoryComposer = createMemoryComposer({
    retrievers: {
      workspace: buildWorkspaceAdapter(memoryService),
      user: buildUserAdapter(masterMemoryService),
    },
  });
  const adapter = makeFakeCodexAdapter();
  const run = seedTopRun(runService, registry, adapter);
  const conversationService = createConversationService({
    runService,
    managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => adapter },
    lifecycleService: { sendAgentInput: () => true },
    memoryService,
    masterMemoryService,
    memoryMultiOwner,
    memoryComposer,
    compositionLedger,
    logger: () => {},
  });
  return { db, run, adapter, conversationService, masterMemoryService };
}

function countAcceptedTop(db, runId) {
  return db.prepare(`
    SELECT COUNT(*) AS n
    FROM memory_composition_events
    WHERE run_id = ? AND slot_kind = 'top' AND provenance_key = 'user' AND status = 'accepted'
  `).get(runId).n;
}

function countOccurrences(text, needle) {
  return (text || '').split(needle).length - 1;
}

test('migration 041 rebuilds owner_state PK with provenance_key and preserves legacy null provenance as empty string', (t) => {
  const db = setupManualDb(t, 40);

  db.prepare(`
    INSERT INTO memory_composition_events
      (id, run_id, slot_kind, provenance_key, composer_version, policy_version, fingerprint, status)
    VALUES ('evt-before-041', 'run-before-041', 'top', 'user', '0.1.0', '0.1.0', 'fp-before-041', 'accepted')
  `).run();
  db.prepare(`
    INSERT INTO memory_composition_owner_state
      (composition_id, owner_type, owner_id, provenance_key, revision)
    VALUES ('evt-before-041', 'user', 'user', NULL, 3)
  `).run();

  applyMigrationFile(db, 41);

  const pkColumns = db.prepare("PRAGMA table_info(memory_composition_owner_state)").all()
    .filter((row) => row.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((row) => row.name);
  assert.deepEqual(pkColumns, ['composition_id', 'owner_type', 'owner_id', 'provenance_key']);

  const survived = db.prepare(`
    SELECT owner_type, owner_id, provenance_key, revision
    FROM memory_composition_owner_state
    WHERE composition_id = 'evt-before-041'
  `).get();
  assert.deepEqual(survived, {
    owner_type: 'user',
    owner_id: 'user',
    provenance_key: '',
    revision: 3,
  });

  db.prepare(`
    INSERT INTO memory_composition_events
      (id, run_id, slot_kind, provenance_key, composer_version, policy_version, fingerprint, status)
    VALUES ('evt-after-041', 'run-after-041', 'top', 'user', '0.1.0', '0.1.0', 'fp-after-041', 'accepted')
  `).run();
  assert.doesNotThrow(() => {
    db.prepare(`
      INSERT INTO memory_composition_owner_state
        (composition_id, owner_type, owner_id, provenance_key, revision)
      VALUES
        ('evt-after-041', 'user', 'user', 'user', 1),
        ('evt-after-041', 'user', 'user', 'cross_project', 1)
    `).run();
  });
  const count = db.prepare(`
    SELECT COUNT(*) AS n
    FROM memory_composition_owner_state
    WHERE composition_id = 'evt-after-041' AND owner_type = 'user' AND owner_id = 'user'
  `).get().n;
  assert.equal(count, 2);
});

test('composition gate keys owner revisions by owner type/id/provenance and detects removed owners', (t) => {
  const db = setupDb(t);
  const ledger = createCompositionLedger(db);
  const runId = 'run-a24b-gate';
  commitTopAccepted(ledger, { runId, userRevision: 1, crossRevision: 1 });

  const crossBump = ledger.shouldCompose({
    runId,
    slotKind: 'top',
    provenanceKey: 'user',
    currentOwnerRevisions: [
      { owner_type: 'user', owner_id: 'user', provenance: 'user', revision: 1 },
      { owner_type: 'user', owner_id: 'user', provenance: 'cross_project', revision: 2 },
    ],
  });
  assert.equal(crossBump.compose, true);
  assert.match(crossBump.reason, /revision_increased:user:user:cross_project:1->2/);

  const userBump = ledger.shouldCompose({
    runId,
    slotKind: 'top',
    provenanceKey: 'user',
    currentOwnerRevisions: [
      { owner_type: 'user', owner_id: 'user', provenance: 'user', revision: 2 },
      { owner_type: 'user', owner_id: 'user', provenance: 'cross_project', revision: 1 },
    ],
  });
  assert.equal(userBump.compose, true);
  assert.match(userBump.reason, /revision_increased:user:user:user:1->2/);

  const removed = ledger.shouldCompose({
    runId,
    slotKind: 'top',
    provenanceKey: 'user',
    currentOwnerRevisions: [
      { owner_type: 'user', owner_id: 'user', provenance: 'user', revision: 1 },
    ],
  });
  assert.equal(removed.compose, true);
  assert.equal(removed.reason, 'removed_owner:user:user:cross_project');
});

test('master memory revisions remain scope-keyed: cross_project write does not bump user revision', (t) => {
  const db = setupDb(t);
  const svc = createMasterMemoryService(db);
  svc.createMemoryItem({ scope: 'user', kind: 'preference', content: 'a2-4b user revision row', origin: 'human' });
  const userRev = svc.getRevision('user');
  const crossRev = svc.getRevision('cross_project');

  svc.createMemoryItem({
    scope: 'cross_project',
    kind: 'pattern',
    content: 'a2-4b cross project revision row',
    origin: 'deterministic',
  });

  assert.equal(svc.getRevision('user'), userRev);
  assert.equal(svc.getRevision('cross_project'), crossRev + 1);
});

test('composer owner_vector_hash and revision snapshots include provenance', () => {
  const revisionScopes = [];
  const masterSvcFake = {
    retrieve: (_ownerType, _ownerId, _opts) => [],
    buildInjectionBlock: () => null,
    getRevision(scope) {
      revisionScopes.push(scope);
      return scope === 'cross_project' ? 22 : 11;
    },
  };
  const composer = createMemoryComposer({ retrievers: { user: buildUserAdapter(masterSvcFake) } });

  const userOnly = composer.compose({
    owners: [{ owner_type: 'user', owner_id: 'user', provenance: 'user' }],
    taskContext: 'ctx',
  }).composition;
  const crossOnly = composer.compose({
    owners: [{ owner_type: 'user', owner_id: 'user', provenance: 'cross_project' }],
    taskContext: 'ctx',
  }).composition;
  const both = composer.compose({
    owners: [
      { owner_type: 'user', owner_id: 'user', provenance: 'user' },
      { owner_type: 'user', owner_id: 'user', provenance: 'cross_project' },
    ],
    taskContext: 'ctx',
  }).composition;

  assert.notEqual(userOnly.owner_vector_hash, crossOnly.owner_vector_hash);
  assert.deepEqual(both.owner_states.map((row) => row.revision), [11, 22]);
  assert.ok(revisionScopes.includes('user'));
  assert.ok(revisionScopes.includes('cross_project'));
});

test('composer applies cross_project provenance budget of 750 instead of user budget 1500', () => {
  const longCrossRow = {
    id: 'cross-long',
    kind: 'pattern',
    content: `cross row ${'x'.repeat(3990)}`,
    content_hash: sha256(`cross row ${'x'.repeat(3990)}`),
    fact_key: null,
    revision: 1,
  };
  const adapter = {
    retrieve: (_ownerId, opts = {}) => {
      if (opts.provenance === 'cross_project') return [longCrossRow];
      return [{
        id: 'user-short',
        kind: 'preference',
        content: 'short user row',
        content_hash: 'user-short-hash',
        fact_key: null,
        revision: 1,
      }];
    },
    buildBlock: (rows, opts = {}) => rows.length
      ? `${opts.provenance === 'cross_project' ? '## Cross-Project Memory' : '## User Memory'}\n${rows.map((r) => r.content).join('\n')}`
      : null,
    getRevision: () => 1,
  };
  const composer = createMemoryComposer({ retrievers: { user: adapter } });
  const { composition } = composer.compose({
    owners: [
      { owner_type: 'user', owner_id: 'user', provenance: 'user' },
      { owner_type: 'user', owner_id: 'user', provenance: 'cross_project' },
    ],
    taskContext: 'ctx',
  });

  const crossState = composition.owner_states.find((row) => row.provenance === 'cross_project');
  assert.equal(crossState.budget_limit, 750);
  assert.equal(crossState.selected_count, 0);
  assert.equal(crossState.suppressed_count, 1);
  const crossEdge = composition.item_edges.find((edge) => edge.item_id === 'cross-long');
  assert.equal(crossEdge.decision, 'budget_exceeded');
  assert.match(crossEdge.reason, /budget_limit=750/);
});

test('composer emits distinct User and Cross-Project headers without duplicate User Memory blocks', (t) => {
  const db = setupDb(t);
  const masterMemoryService = createMasterMemoryService(db);
  masterMemoryService.createMemoryItem({
    scope: 'user',
    kind: 'preference',
    content: 'a2-4b user header memory',
    origin: 'human',
  });
  masterMemoryService.createMemoryItem({
    scope: 'cross_project',
    kind: 'pattern',
    content: 'a2-4b cross header memory',
    origin: 'deterministic',
  });
  const composer = createMemoryComposer({
    retrievers: { user: buildUserAdapter(masterMemoryService) },
  });

  const { block } = composer.compose({
    owners: [
      { owner_type: 'user', owner_id: 'user', provenance: 'user' },
      { owner_type: 'user', owner_id: 'user', provenance: 'cross_project' },
    ],
    taskContext: '',
  });

  assert.match(block, /## User Memory/);
  assert.match(block, /## Cross-Project Memory/);
  assert.equal(countOccurrences(block, '## User Memory'), 1);
  assert.match(block, /a2-4b user header memory/);
  assert.match(block, /a2-4b cross header memory/);
});

test('Top flag ON injects user and cross_project blocks, then selected-set skip suppresses unchanged second injection', (t) => {
  const { db, run, adapter, conversationService, masterMemoryService } = setupTopHarness(t, { memoryMultiOwner: true });
  masterMemoryService.createMemoryItem({
    scope: 'user',
    kind: 'constraint',
    content: 'a2-4b top user block row',
    origin: 'human',
  });
  const cross = masterMemoryService.createMemoryItem({
    scope: 'cross_project',
    kind: 'pattern',
    content: 'a2-4b top cross block row',
    origin: 'deterministic',
  });

  conversationService.sendMessage('top', { text: 'first top turn' });
  const first = adapter.calls[0].payload.text;
  assert.match(first, /## User Memory/);
  assert.match(first, /## Cross-Project Memory/);
  assert.match(first, /a2-4b top user block row/);
  assert.match(first, /a2-4b top cross block row/);
  assert.equal(countAcceptedTop(db, run.id), 1);

  masterMemoryService.updateMemory(cross.id, { importance: 9 });
  conversationService.sendMessage('top', { text: 'second top turn' });
  const second = adapter.calls[1].payload.text;
  assert.doesNotMatch(second, /## User Memory/);
  assert.doesNotMatch(second, /## Cross-Project Memory/);
  // Selection unchanged → no re-injection, but the composition IS recorded to
  // advance the gate baseline (Codex A2-4b SERIOUS: without the record, the bumped
  // cross_project revision would recompose every turn forever).
  assert.equal(countAcceptedTop(db, run.id), 2, 'skip suppresses re-injection but records to advance the gate');

  // Third turn with NO memory change → the gate has converged (revision unchanged)
  // → shouldCompose returns false → no compose, no injection, no new record.
  conversationService.sendMessage('top', { text: 'third top turn' });
  const third = adapter.calls[2].payload.text;
  assert.doesNotMatch(third, /## User Memory/);
  assert.doesNotMatch(third, /## Cross-Project Memory/);
  assert.equal(countAcceptedTop(db, run.id), 2, 'gate converged: no recompose when revision is unchanged');
});

test('Top flag OFF remains single user-provenance block and excludes cross_project memory', (t) => {
  const { db, run, adapter, conversationService, masterMemoryService } = setupTopHarness(t, { memoryMultiOwner: false });
  masterMemoryService.createMemoryItem({
    scope: 'user',
    kind: 'constraint',
    content: 'a2-4b flag off user block row',
    origin: 'human',
  });
  masterMemoryService.createMemoryItem({
    scope: 'cross_project',
    kind: 'pattern',
    content: 'a2-4b flag off cross block row',
    origin: 'deterministic',
  });

  conversationService.sendMessage('top', { text: 'flag off top turn' });
  const first = adapter.calls[0].payload.text;
  assert.match(first, /## User Memory/);
  assert.match(first, /a2-4b flag off user block row/);
  assert.doesNotMatch(first, /## Cross-Project Memory/);
  assert.doesNotMatch(first, /a2-4b flag off cross block row/);

  const ownerRows = db.prepare(`
    SELECT os.owner_type, os.owner_id, os.provenance_key
    FROM memory_composition_owner_state os
    JOIN memory_composition_events e ON e.id = os.composition_id
    WHERE e.run_id = ? AND e.slot_kind = 'top' AND e.provenance_key = 'user'
    ORDER BY os.owner_type, os.owner_id, os.provenance_key
  `).all(run.id);
  assert.deepEqual(ownerRows, [
    { owner_type: 'user', owner_id: 'user', provenance_key: 'user' },
  ]);
});
