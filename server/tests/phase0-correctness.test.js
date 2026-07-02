'use strict';

/**
 * Phase 0 correctness tests
 *
 * 0a — commitAccepted API correctness: transaction failure → full rollback (no orphan rows)
 * 0b — composer failure observability: compose() returning null emits memory:composer_failed
 * 0c — binding assert: mismatched run.conversation_id → 502 before any getRevision
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createManagerRegistry } = require('../services/managerRegistry');
const { createConversationService } = require('../services/conversationService');
const { createCompositionLedger } = require('../services/compositionLedger');

// ─── DB helper ───────────────────────────────────────────────────────────────

async function mkdb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-phase0-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    try { close(); } catch { /* ignore */ }
    await fs.rm(dir, { recursive: true, force: true });
  });
  return db;
}

// ─── Stubs ───────────────────────────────────────────────────────────────────

function makeAdapter({ rejectTurn = false } = {}) {
  return {
    calls: [],
    isSessionAlive: () => true,
    detectExitCode: () => null,
    emitSessionEndedIfNeeded: () => {},
    runTurn(runId, payload) {
      if (rejectTurn) return { accepted: false };
      this.calls.push({ runId, payload });
      return { accepted: true };
    },
    getUsage: () => null,
    getSessionId: () => null,
    getOutput: () => null,
    disposeSession: () => {},
  };
}

function makeAdapterFactory(adapter) {
  return { getAdapter: () => adapter };
}

function makeEventBus() {
  const listeners = [];
  const emitted = [];
  return {
    emitted,
    subscribe(fn) { listeners.push(fn); },
    emit(channel, data) {
      emitted.push({ channel, data });
      for (const fn of listeners) {
        try { fn({ channel, data }); } catch { /* ignore */ }
      }
    },
  };
}

  function makeMemoryService({ revision = 5, recordedInjections = [], getRevisionCalled = [] } = {}) {
    return {
      getRevision(projectId) {
        getRevisionCalled.push(projectId);
        return revision;
      },
    };
  }

  function makeMasterMemoryService({ revision = 3, recordedInjections = [], getRevisionCalled = [] } = {}) {
    return {
      getRevision(scope) {
        getRevisionCalled.push(scope);
        return revision;
      },
    };
  }

function makeComposer({ block = '## Learned Memory\n- item', composition = null, returnsNullComposition = false } = {}) {
  const defaultComposition = composition ?? {
    fingerprint: 'fp-test',
    owner_states: [{ owner_type: 'workspace', owner_id: 'proj1', revision: 5, provenance: 'proj1' }],
    item_edges: [],
    composer_version: '0.1.0',
    policy_version: '0.1.0',
  };
  return {
    compose() {
      if (returnsNullComposition) return { block: null, composition: null };
      return { block, composition: defaultComposition };
    },
  };
}

function seedProject(db, projectId = 'proj1') {
  db.prepare("INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)").run(projectId, projectId);
}

function seedTopRun(rs, registry, adapter) {
  const run = rs.createRun({ is_manager: true, manager_adapter: 'claude-code', prompt: 'top' });
  rs.updateRunStatus(run.id, 'running', { force: true });
  registry.setActive('top', run.id, adapter);
  return run;
}

function seedPmRun(rs, registry, adapter, projectId, topRunId, db) {
  seedProject(db, projectId);
  const run = rs.createRun({
    is_manager: true,
    manager_adapter: 'claude-code',
    manager_layer: 'operator',
    conversation_id: `operator:${projectId}`,
    project_id: projectId,
    parent_run_id: topRunId,
    prompt: 'pm',
  });
  rs.updateRunStatus(run.id, 'running', { force: true });
  registry.setActive(`operator:${projectId}`, run.id, adapter);
  return run;
}

// ─────────────────────────────────────────────────────────────────────────────
  // Phase 0a: commitAccepted API correctness
// ─────────────────────────────────────────────────────────────────────────────

test('0a: commitAccepted — success path writes event+owner_state+edges atomically', async (t) => {
  const db = await mkdb(t);
  const ledger = createCompositionLedger(db);

  const composition = {
    fingerprint: 'fp-atomic-ok',
    owner_states: [{ owner_type: 'workspace', owner_id: 'proj1', revision: 5, provenance: 'proj1' }],
    item_edges: [{ item_table: 'memory_items', item_id: null, decision: 'included', provenance: 'proj1' }],
    composer_version: '1.0.0',
    policy_version: '1.0.0',
  };

  const id = ledger.commitAccepted(composition, {
    runId: 'run-atomic-ok',
    conversationId: 'operator:proj1',
    taskId: null,
    slotKind: 'operator',
    provenanceKey: 'proj1',
  });

  assert.ok(id, 'should return a compositionId');

  // event row should be accepted directly
  const eventRow = db.prepare('SELECT status, accepted_at FROM memory_composition_events WHERE id = ?').get(id);
  assert.equal(eventRow.status, 'accepted', 'event status should be accepted');
  assert.ok(eventRow.accepted_at, 'accepted_at should be set');

  // owner_state row
  const ownerRow = db.prepare('SELECT * FROM memory_composition_owner_state WHERE composition_id = ?').get(id);
  assert.ok(ownerRow, 'owner_state row should exist');
  assert.equal(ownerRow.owner_type, 'workspace');
  assert.equal(ownerRow.revision, 5);

  // edge row
  const edgeRow = db.prepare('SELECT * FROM memory_composition_item_edges WHERE composition_id = ?').get(id);
  assert.ok(edgeRow, 'item_edges row should exist');
  assert.equal(edgeRow.decision, 'included');
});

test('0a: commitAccepted — transaction failure causes full rollback (no orphan event row)', async (t) => {
  const db = await mkdb(t);
  const ledger = createCompositionLedger(db);

  const composition = {
    fingerprint: null,
    owner_states: [{ owner_type: 'workspace', owner_id: 'proj1', revision: 7, provenance: 'proj1' }],
    item_edges: [],
    composer_version: '1.0.0',
    policy_version: '1.0.0',
  };

  let threwOuter = false;
  try {
      ledger.commitAccepted(composition, {
        runId: 'run-atomic-fail',
        conversationId: 'operator:proj1',
        taskId: null,
        slotKind: 'operator',
        provenanceKey: 'proj1',
      });
    } catch (err) {
      threwOuter = true;
    assert.match(err.message, /fingerprint|NOT NULL/i);
    }

    assert.ok(threwOuter, 'commitAccepted should throw when a ledger write fails');

  // No orphan event row
  const eventRow = db.prepare(
    "SELECT * FROM memory_composition_events WHERE run_id = 'run-atomic-fail'"
  ).get();
  assert.equal(eventRow, undefined, 'no orphan memory_composition_events row after rollback');

  // No orphan owner_state row
  const count = db.prepare('SELECT COUNT(*) AS c FROM memory_composition_owner_state').get();
  assert.equal(count.c, 0, 'no orphan owner_state rows after rollback');
});

test('0a: old record()/accept() API still works (back-compat)', async (t) => {
  const db = await mkdb(t);
  const ledger = createCompositionLedger(db);

  const composition = {
    fingerprint: 'fp-compat',
    owner_states: [],
    item_edges: [],
    composer_version: '1.0.0',
    policy_version: '1.0.0',
  };

  const id = ledger.record(composition, {
    runId: 'run-compat',
    slotKind: 'operator',
    provenanceKey: 'proj1',
  });
  assert.ok(id, 'record() should return an id');

  const rowPending = db.prepare('SELECT status FROM memory_composition_events WHERE id = ?').get(id);
  assert.equal(rowPending.status, 'pending', 'record() creates pending row');

  const accepted = ledger.accept(id);
  assert.ok(accepted, 'accept() should return true');

  const rowAccepted = db.prepare('SELECT status FROM memory_composition_events WHERE id = ?').get(id);
  assert.equal(rowAccepted.status, 'accepted', 'accept() transitions to accepted');
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 0b: composer failure observability
// ─────────────────────────────────────────────────────────────────────────────

test('0b: compose() returning {block:null,composition:null} emits memory:composer_failed (PM)', async (t) => {
  const db = await mkdb(t);
  const eventBus = makeEventBus();
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });

  const topAdapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, topAdapter);
  const pmAdapter = makeAdapter();
  const pmRun = seedPmRun(rs, registry, pmAdapter, 'proj1', topRun.id, db);

  // shouldCompose returns true (no prior accepted), then composer returns null
  const ledger = createCompositionLedger(db);
  const composer = makeComposer({ returnsNullComposition: true });
  const memSvc = makeMemoryService({ revision: 5 });

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(pmAdapter),
    lifecycleService: { sendAgentInput: () => false },
      memoryService: memSvc,
      masterMemoryService: null,
      memoryComposer: composer,
      compositionLedger: ledger,
      eventBus,
      logger: () => {},
    });

  svc.sendMessage(`operator:proj1`, { text: 'hello' });

  const failed = eventBus.emitted.filter(e => e.channel === 'memory:composer_failed');
  assert.equal(failed.length, 1, 'should emit exactly one memory:composer_failed');
  assert.equal(failed[0].data.slotKind, 'operator'); // Phase 2: producer flipped to operator
  assert.equal(failed[0].data.provenanceKey, 'proj1');
  assert.equal(failed[0].data.runId, pmRun.id);
});

test('0b: compose() returning {block:null,composition:<non-null>} does NOT emit composer_failed (normal empty memory)', async (t) => {
  const db = await mkdb(t);
  const eventBus = makeEventBus();
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });

  const topAdapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, topAdapter);
  const pmAdapter = makeAdapter();
  seedPmRun(rs, registry, pmAdapter, 'proj1', topRun.id, db);

  const ledger = createCompositionLedger(db);
  // non-null composition but null block = empty memory (NOT a failure)
  const emptyComposition = { fingerprint: 'fp-empty', owner_states: [], item_edges: [], composer_version: '0', policy_version: '0' };
  const composer = { compose: () => ({ block: null, composition: emptyComposition }) };

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(pmAdapter),
    lifecycleService: { sendAgentInput: () => false },
      memoryService: makeMemoryService({ revision: 5 }),
      masterMemoryService: null,
      memoryComposer: composer,
      compositionLedger: ledger,
      eventBus,
      logger: () => {},
    });

  svc.sendMessage('operator:proj1', { text: 'hello' });

  const failed = eventBus.emitted.filter(e => e.channel === 'memory:composer_failed');
  assert.equal(failed.length, 0, 'empty memory (composition non-null) must NOT emit composer_failed');
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 0c: binding assert
// ─────────────────────────────────────────────────────────────────────────────

test('0c: mismatched run.conversation_id → 502 before any getRevision (PM)', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });

  const topAdapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, topAdapter);

  // Seed a PM run for proj1 but register it under pm:proj2 (mismatched slot)
  seedProject(db, 'proj1');
  seedProject(db, 'proj2');
  const pmAdapter = makeAdapter();
  const pmRun = rs.createRun({
    is_manager: true,
    manager_adapter: 'claude-code',
    manager_layer: 'operator',
    conversation_id: 'operator:proj1',   // real conversation_id = proj1
    project_id: 'proj1',
    parent_run_id: topRun.id,
    prompt: 'pm',
  });
  rs.updateRunStatus(pmRun.id, 'running', { force: true });
  // Register under proj2 slot — mismatch: slot says proj2, run says proj1
  registry.setActive('operator:proj2', pmRun.id, pmAdapter);

  const getRevisionCalled = [];
  const memSvc = makeMemoryService({ getRevisionCalled });

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(pmAdapter),
    lifecycleService: { sendAgentInput: () => false },
      memoryService: memSvc,
      masterMemoryService: null,
      memoryComposer: makeComposer(),
      compositionLedger: createCompositionLedger(db),
      eventBus: makeEventBus(),
      logger: () => {},
    });

  let threw = false;
  try {
    svc.sendMessage('operator:proj2', { text: 'hello' });
  } catch (err) {
    threw = true;
    assert.equal(err.httpStatus, 502, 'should throw 502');
    assert.match(err.message, /binding mismatch/);
  }
  assert.ok(threw, 'should have thrown a binding mismatch error');
  assert.equal(getRevisionCalled.length, 0, 'getRevision must NOT be called before the binding check');
});

test('0c: correct binding passes without error (PM)', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });

  const topAdapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, topAdapter);
  const pmAdapter = makeAdapter();
  const pmRun = seedPmRun(rs, registry, pmAdapter, 'proj1', topRun.id, db);

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(pmAdapter),
    lifecycleService: { sendAgentInput: () => false },
      memoryService: makeMemoryService({ revision: 5 }),
      masterMemoryService: null,
      memoryComposer: makeComposer(),
      compositionLedger: createCompositionLedger(db),
      eventBus: makeEventBus(),
      logger: () => {},
    });

  // Should not throw
  const result = svc.sendMessage('operator:proj1', { text: 'hello' });
  assert.equal(result.status, 'sent');
});

test('0c: mismatched run.conversation_id → 502 before getRevision (Top)', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });

  // Seed a PM run but register it under 'top' slot (is_manager=true but wrong layer)
  seedProject(db, 'proj1');
  const wrongAdapter = makeAdapter();
  const pmRun = rs.createRun({
    is_manager: true,
    manager_adapter: 'claude-code',
    manager_layer: 'operator',         // layer='operator' but registered under 'top'
    conversation_id: 'operator:proj1', // conversation_id mismatch with 'top'
    project_id: 'proj1',
    prompt: 'pm',
  });
  rs.updateRunStatus(pmRun.id, 'running', { force: true });
  registry.setActive('top', pmRun.id, wrongAdapter);

  const getRevisionCalled = [];
  const masterSvc = makeMasterMemoryService({ getRevisionCalled });

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(wrongAdapter),
    lifecycleService: { sendAgentInput: () => false },
      memoryService: null,
      masterMemoryService: masterSvc,
      memoryComposer: makeComposer(),
      compositionLedger: createCompositionLedger(db),
      eventBus: makeEventBus(),
      logger: () => {},
    });

  let threw = false;
  try {
    svc.sendMessage('top', { text: 'hello' });
  } catch (err) {
    threw = true;
    assert.equal(err.httpStatus, 502, 'should throw 502');
    assert.match(err.message, /binding mismatch/);
  }
  assert.ok(threw, 'should have thrown a binding mismatch error for Top');
  assert.equal(getRevisionCalled.length, 0, 'masterMemoryService.getRevision must NOT be called');
});

test('0c: worker sends bypass the binding assert (is_manager=0)', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });

  seedProject(db, 'proj1');
  const topAdapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, topAdapter);

  // Seed task + agent_profile required for worker run creation
  db.prepare("INSERT INTO tasks (id, title, project_id, status) VALUES ('t1','task','proj1','todo')").run();
  db.prepare("INSERT INTO agent_profiles (id, name, type, command) VALUES ('a1','A','codex','codex')").run();

  const workerRun = rs.createRun({
    task_id: 't1',
    agent_profile_id: 'a1',
    parent_run_id: topRun.id,
    prompt: 'worker',
  });
  rs.updateRunStatus(workerRun.id, 'running', { force: true });

  const lifecycle = { sendAgentInput: (runId, text) => true };

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(topAdapter),
    lifecycleService: lifecycle,
      memoryService: null,
      masterMemoryService: null,
      memoryComposer: null,
      compositionLedger: null,
      eventBus: makeEventBus(),
      logger: () => {},
    });

  // Worker send must succeed (not hit binding assert)
  const result = svc.sendMessage(`worker:${workerRun.id}`, { text: 'hello from worker' });
  assert.equal(result.status, 'sent');
});
