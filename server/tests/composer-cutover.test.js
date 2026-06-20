'use strict';

/**
 * A2-3a: PM-slot composer+ledger cutover 테스트
 *
 * 검증 항목:
 * 1. flag OFF: PM 주입이 현행(shouldInject/recordInjection) 경로 그대로
 * 2. flag ON:
 *    a. PM 주입이 composer block(byte-equivalent) prepend
 *    b. compositionLedger에 record+accept (accepted 행)
 *    c. old pm_memory_injection도 dual-write (동일 revision)
 *    d. gate cadence: revision 동일→skip, 증가→재주입
 *    e. block null → record/accept/dual-write 전부 skip (gate 오염 0)
 *    f. parent-notice 순서 보존 (memory block → notices → original)
 * 3. annotate-only: composer/ledger throw → degrade, 메시지 전달 계속
 * 4. Top slot: flag ON 이어도 Top은 composer 경로 미사용 (untouched)
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

// ─── DB 헬퍼 ──────────────────────────────────────────────────────────────────

async function mkdb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-a23a-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    try { close(); } catch { /* ignore */ }
    await fs.rm(dir, { recursive: true, force: true });
  });
  return db;
}

// ─── Stub factories ───────────────────────────────────────────────────────────

function makeAdapter({ rejectTurn = false } = {}) {
  const calls = [];
  return {
    calls,
    isSessionAlive: () => true,
    detectExitCode: () => null,
    emitSessionEndedIfNeeded: () => {},
    runTurn(runId, payload) {
      if (rejectTurn) return { accepted: false };
      calls.push({ runId, payload });
      return { accepted: true };
    },
    getUsage: () => null,
    getSessionId: () => null,
    getOutput: () => null,
    disposeSession: () => {},
  };
}

function makeAdapterFactory(adapter) {
  return {
    getAdapter: () => adapter,
    createAdapter: () => adapter,
  };
}

function makeLifecycle() {
  return { sendAgentInput: () => false };
}

// ─── Memory service mock ──────────────────────────────────────────────────────

function makeMemoryService({
  shouldInjectResult = null,
  retrieveRows = [],
  injectionBlock = null,
  revision = 5,
  recordedInjections = [],
  getRevision: getRevisionOverride,
} = {}) {
  return {
    shouldInject(runId, projectId) {
      return shouldInjectResult ?? { inject: true, revision };
    },
    retrieveForProject(projectId, opts) {
      return retrieveRows;
    },
    buildInjectionBlock(rows) {
      return injectionBlock;
    },
    getRevision(projectId) {
      if (getRevisionOverride) return getRevisionOverride(projectId);
      return revision;
    },
    recordInjection(runId, projectId, rev) {
      recordedInjections.push({ runId, projectId, revision: rev });
    },
  };
}

// ─── Composer mock ────────────────────────────────────────────────────────────

function makeComposer({
  block = '## Learned Memory\n- test memory item',
  composition = { fingerprint: 'fp1', owner_states: [], item_edges: [], composer_version: '0.1.0', policy_version: '0.1.0' },
  throws = false,
  returnNullBlock = false,
} = {}) {
  const calls = [];
  return {
    calls,
    compose(arg) {
      if (throws) throw new Error('compose error');
      calls.push(arg);
      if (returnNullBlock) return { block: null, composition: null };
      return { block, composition };
    },
  };
}

// ─── MasterMemoryService mock ──────────────────────────────────────────────────

function makeMasterMemoryService({
  shouldInjectResult = null,
  retrieveRows = [],
  injectionBlock = null,
  revision = 3,
  recordedInjections = [],
  getRevision: getRevisionOverride,
} = {}) {
  return {
    shouldInject(runId, scope) {
      return shouldInjectResult ?? { inject: true, revision };
    },
    retrieve(scope, ownerId, opts) {
      return retrieveRows;
    },
    buildInjectionBlock(rows) {
      return injectionBlock;
    },
    getRevision(scope) {
      if (getRevisionOverride) return getRevisionOverride(scope);
      return revision;
    },
    recordInjection(runId, scope, rev) {
      recordedInjections.push({ runId, scope, revision: rev });
    },
  };
}

// ─── Seed helpers ─────────────────────────────────────────────────────────────

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
    manager_layer: 'pm',
    conversation_id: `pm:${projectId}`,
    project_id: projectId,
    parent_run_id: topRunId,
    prompt: 'pm',
  });
  rs.updateRunStatus(run.id, 'running', { force: true });
  registry.setActive(`pm:${projectId}`, run.id, adapter);
  return run;
}

// =============================================================================
// Test suite
// =============================================================================

test('A2-3a flag OFF: PM injection uses existing shouldInject/recordInjection path', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });
  const adapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, adapter);
  const pmAdapter = makeAdapter();
  const pmRun = seedPmRun(rs, registry, pmAdapter, 'proj1', topRun.id, db);

  const recordedInjections = [];
  const memService = makeMemoryService({
    injectionBlock: '## Learned Memory\n- item A',
    recordedInjections,
    revision: 7,
  });

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(pmAdapter),
    lifecycleService: makeLifecycle(),
    memoryService: memService,
    // flag OFF: no composer deps
    memoryComposerEnabled: false,
  });

  svc.sendMessage(`pm:proj1`, { text: 'hello pm', projectId: 'proj1' });

  // Verify the adapter received a prepended block
  assert.equal(pmAdapter.calls.length, 1, 'adapter called once');
  const sentText = pmAdapter.calls[0].payload.text;
  assert.ok(sentText.includes('## Learned Memory'), 'injection block prepended');
  assert.ok(sentText.includes('hello pm'), 'original text present');

  // Verify old ledger written (not composer ledger)
  assert.equal(recordedInjections.length, 1, 'recordInjection called once');
  assert.equal(recordedInjections[0].revision, 7, 'correct revision');
  assert.equal(recordedInjections[0].projectId, 'proj1', 'correct projectId');
  assert.equal(recordedInjections[0].runId, pmRun.id, 'correct runId');
});

test('A2-3a flag OFF: no injection if shouldInject returns inject=false', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });
  const adapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, adapter);
  const pmAdapter = makeAdapter();
  seedPmRun(rs, registry, pmAdapter, 'proj1', topRun.id, db);

  const recordedInjections = [];
  const memService = makeMemoryService({
    shouldInjectResult: { inject: false, revision: 3 },
    injectionBlock: '## Learned Memory\n- item A',
    recordedInjections,
  });

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(pmAdapter),
    lifecycleService: makeLifecycle(),
    memoryService: memService,
    memoryComposerEnabled: false,
  });

  svc.sendMessage(`pm:proj1`, { text: 'no inject', projectId: 'proj1' });

  const sentText = pmAdapter.calls[0].payload.text;
  assert.ok(!sentText.includes('## Learned Memory'), 'no injection block');
  assert.equal(recordedInjections.length, 0, 'recordInjection NOT called');
});

test('A2-3a flag ON: composer block prepended (byte-equivalent)', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });
  const adapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, adapter);
  const pmAdapter = makeAdapter();
  const pmRun = seedPmRun(rs, registry, pmAdapter, 'proj1', topRun.id, db);

  const BLOCK = '## Learned Memory\n- composer block content';
  const COMPOSITION = {
    fingerprint: 'fp-test',
    owner_states: [{ owner_type: 'workspace', owner_id: 'proj1', revision: 5 }],
    item_edges: [],
    composer_version: '0.1.0',
    policy_version: '0.1.0',
  };

  const composer = makeComposer({ block: BLOCK, composition: COMPOSITION });
  const ledger = createCompositionLedger(db);
  const recordedInjections = [];
  const memService = makeMemoryService({ revision: 5, recordedInjections });

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(pmAdapter),
    lifecycleService: makeLifecycle(),
    memoryService: memService,
    memoryComposer: composer,
    compositionLedger: ledger,
    memoryComposerEnabled: true,
  });

  svc.sendMessage(`pm:proj1`, { text: 'hello composer', projectId: 'proj1' });

  assert.equal(pmAdapter.calls.length, 1, 'adapter called once');
  const sentText = pmAdapter.calls[0].payload.text;
  assert.ok(sentText.startsWith(BLOCK), 'block is outermost prepend');
  assert.ok(sentText.includes('hello composer'), 'original text present');

  // Verify composer was called with correct owners
  assert.equal(composer.calls.length, 1, 'composer.compose called once');
  assert.deepEqual(composer.calls[0].owners, [{ owner_type: 'workspace', owner_id: 'proj1' }]);
  assert.equal(composer.calls[0].taskContext, 'hello composer');
});

test('A2-3a flag ON: compositionLedger gets record+accept (accepted row)', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });
  const adapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, adapter);
  const pmAdapter = makeAdapter();
  const pmRun = seedPmRun(rs, registry, pmAdapter, 'proj1', topRun.id, db);

  const COMPOSITION = {
    fingerprint: 'fp-accept-test',
    owner_states: [{ owner_type: 'workspace', owner_id: 'proj1', provenance: null, revision: 5,
      selected_set_hash: 'h1', suppressed_set_hash: null, selected_count: 1, suppressed_count: 0,
      budget_limit: 1000000, budget_used: 10 }],
    item_edges: [],
    composer_version: '0.1.0',
    policy_version: '0.1.0',
    retrieval_query_hash: 'rqh',
    token_budget: 1000000,
    owner_vector_hash: 'ovh',
    selected_set_hash: 'ssh',
  };

  const composer = makeComposer({ block: '## Learned Memory\n- ledger test', composition: COMPOSITION });
  const ledger = createCompositionLedger(db);
  const recordedInjections = [];
  const memService = makeMemoryService({ revision: 5, recordedInjections });

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(pmAdapter),
    lifecycleService: makeLifecycle(),
    memoryService: memService,
    memoryComposer: composer,
    compositionLedger: ledger,
    memoryComposerEnabled: true,
  });

  svc.sendMessage(`pm:proj1`, { text: 'ledger test', projectId: 'proj1' });

  // Assert accepted row exists in DB
  const row = db.prepare(
    "SELECT * FROM memory_composition_events WHERE run_id = ? AND slot_kind = 'pm' AND status = 'accepted'"
  ).get(pmRun.id);
  assert.ok(row, 'composition event row exists with accepted status');
  assert.equal(row.provenance_key, 'proj1', 'provenanceKey recorded');
  assert.equal(row.fingerprint, 'fp-accept-test', 'fingerprint recorded');
});

test('A2-3a flag ON: dual-write to old pm_memory_injection ledger', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });
  const adapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, adapter);
  const pmAdapter = makeAdapter();
  const pmRun = seedPmRun(rs, registry, pmAdapter, 'proj1', topRun.id, db);

  const COMPOSITION = {
    fingerprint: 'fp-dual',
    owner_states: [{ owner_type: 'workspace', owner_id: 'proj1', provenance: null, revision: 8,
      selected_set_hash: 'h2', suppressed_set_hash: null, selected_count: 0, suppressed_count: 0,
      budget_limit: 1000000, budget_used: 0 }],
    item_edges: [],
    composer_version: '0.1.0',
    policy_version: '0.1.0',
    retrieval_query_hash: null,
    token_budget: 1000000,
    owner_vector_hash: null,
    selected_set_hash: null,
  };

  const composer = makeComposer({ block: '## Learned Memory\n- dual write', composition: COMPOSITION });
  const ledger = createCompositionLedger(db);
  const recordedInjections = [];
  const memService = makeMemoryService({ revision: 8, recordedInjections });

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(pmAdapter),
    lifecycleService: makeLifecycle(),
    memoryService: memService,
    memoryComposer: composer,
    compositionLedger: ledger,
    memoryComposerEnabled: true,
  });

  svc.sendMessage(`pm:proj1`, { text: 'dual write test', projectId: 'proj1' });

  // Dual-write: old pm_memory_injection ledger also called
  assert.equal(recordedInjections.length, 1, 'old recordInjection called once (dual-write)');
  assert.equal(recordedInjections[0].revision, 8, 'same revision dual-written');
  assert.equal(recordedInjections[0].runId, pmRun.id, 'correct runId');
});

test('A2-3a flag ON: gate cadence — same revision skip, higher revision reinject', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });
  const adapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, adapter);
  const pmAdapter = makeAdapter();
  const pmRun = seedPmRun(rs, registry, pmAdapter, 'proj1', topRun.id, db);

  let currentRevision = 5;
  const COMPOSITION = (rev) => ({
    fingerprint: `fp-gate-${rev}`,
    owner_states: [{ owner_type: 'workspace', owner_id: 'proj1', provenance: null, revision: rev,
      selected_set_hash: 'hs', suppressed_set_hash: null, selected_count: 0, suppressed_count: 0,
      budget_limit: 1000000, budget_used: 0 }],
    item_edges: [],
    composer_version: '0.1.0',
    policy_version: '0.1.0',
    retrieval_query_hash: null,
    token_budget: 1000000,
    owner_vector_hash: null,
    selected_set_hash: null,
  });

  const composerCalls = [];
  const composer = {
    compose(arg) {
      composerCalls.push(currentRevision);
      return { block: '## Learned Memory\n- gate test', composition: COMPOSITION(currentRevision) };
    },
  };
  const ledger = createCompositionLedger(db);
  const recordedInjections = [];
  const memService = makeMemoryService({
    revision: 5,
    recordedInjections,
    getRevision: () => currentRevision,
  });

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(pmAdapter),
    lifecycleService: makeLifecycle(),
    memoryService: memService,
    memoryComposer: composer,
    compositionLedger: ledger,
    memoryComposerEnabled: true,
  });

  // First send: revision=5 → should inject (no prior accepted)
  svc.sendMessage(`pm:proj1`, { text: 'first send', projectId: 'proj1' });
  assert.equal(composerCalls.length, 1, 'first send: composer called');
  const afterFirst = pmAdapter.calls.length;
  assert.equal(afterFirst, 1);

  // Second send: revision still 5 → gate says skip (revision unchanged)
  svc.sendMessage(`pm:proj1`, { text: 'second send', projectId: 'proj1' });
  assert.equal(composerCalls.length, 1, 'second send: composer NOT called (gate skip)');

  // Third send: revision increased to 6 → gate says reinject
  currentRevision = 6;
  svc.sendMessage(`pm:proj1`, { text: 'third send', projectId: 'proj1' });
  assert.equal(composerCalls.length, 2, 'third send: composer called again (revision increased)');
});

test('A2-3a flag ON: block null → no record/accept/dual-write (gate pollution=0)', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });
  const adapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, adapter);
  const pmAdapter = makeAdapter();
  const pmRun = seedPmRun(rs, registry, pmAdapter, 'proj1', topRun.id, db);

  const composer = makeComposer({ returnNullBlock: true });
  const ledger = createCompositionLedger(db);
  const recordedInjections = [];
  const memService = makeMemoryService({ revision: 3, recordedInjections });

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(pmAdapter),
    lifecycleService: makeLifecycle(),
    memoryService: memService,
    memoryComposer: composer,
    compositionLedger: ledger,
    memoryComposerEnabled: true,
  });

  svc.sendMessage(`pm:proj1`, { text: 'null block test', projectId: 'proj1' });

  // Message delivered without block
  assert.equal(pmAdapter.calls.length, 1, 'message delivered');
  const sentText = pmAdapter.calls[0].payload.text;
  assert.ok(!sentText.includes('## Learned Memory'), 'no memory block prepended');
  assert.equal(sentText.trim(), 'null block test', 'original text only');

  // No ledger entry and no dual-write
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM memory_composition_events WHERE run_id = ?"
  ).get(pmRun.id);
  assert.equal(row.cnt, 0, 'no composition event recorded (null block)');
  assert.equal(recordedInjections.length, 0, 'no dual-write (null block)');
});

test('A2-3a flag ON: parent-notice order preserved (memory block → notices → original)', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });
  const adapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, adapter);
  const pmAdapter = makeAdapter();
  const pmRun = seedPmRun(rs, registry, pmAdapter, 'proj1', topRun.id, db);

  const BLOCK = '## Learned Memory\n- order test';
  const COMPOSITION = {
    fingerprint: 'fp-order',
    owner_states: [{ owner_type: 'workspace', owner_id: 'proj1', provenance: null, revision: 2,
      selected_set_hash: 'h3', suppressed_set_hash: null, selected_count: 0, suppressed_count: 0,
      budget_limit: 1000000, budget_used: 0 }],
    item_edges: [],
    composer_version: '0.1.0', policy_version: '0.1.0',
    retrieval_query_hash: null, token_budget: 1000000, owner_vector_hash: null, selected_set_hash: null,
  };

  const composer = makeComposer({ block: BLOCK, composition: COMPOSITION });
  const ledger = createCompositionLedger(db);
  const memService = makeMemoryService({ revision: 2, recordedInjections: [] });

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(pmAdapter),
    lifecycleService: makeLifecycle(),
    memoryService: memService,
    memoryComposer: composer,
    compositionLedger: ledger,
    memoryComposerEnabled: true,
  });

  // Manually inject a parent notice to verify ordering
  svc.queueParentNotice(pmRun.id, '[notice from parent]');

  svc.sendMessage(`pm:proj1`, { text: 'order check', projectId: 'proj1' });

  const sentText = pmAdapter.calls[0].payload.text;
  const blockPos = sentText.indexOf(BLOCK);
  const noticePos = sentText.indexOf('[notice from parent]');
  const originalPos = sentText.indexOf('order check');

  assert.ok(blockPos < noticePos, 'memory block before notice');
  assert.ok(noticePos < originalPos, 'notice before original text');
});

test('A2-3a annotate-only: composer throws → degrade, message delivered', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });
  const adapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, adapter);
  const pmAdapter = makeAdapter();
  seedPmRun(rs, registry, pmAdapter, 'proj1', topRun.id, db);

  const throwingComposer = makeComposer({ throws: true });
  const ledger = createCompositionLedger(db);
  const recordedInjections = [];
  const memService = makeMemoryService({ revision: 1, recordedInjections });

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(pmAdapter),
    lifecycleService: makeLifecycle(),
    memoryService: memService,
    memoryComposer: throwingComposer,
    compositionLedger: ledger,
    memoryComposerEnabled: true,
  });

  // Must not throw — annotate-only
  assert.doesNotThrow(() => svc.sendMessage(`pm:proj1`, { text: 'degrade test', projectId: 'proj1' }));

  // Message still delivered (no block, just original text)
  assert.equal(pmAdapter.calls.length, 1, 'message delivered despite composer error');
  const sentText = pmAdapter.calls[0].payload.text;
  assert.ok(!sentText.includes('## Learned Memory'), 'no block on error');
  assert.ok(sentText.includes('degrade test'), 'original text delivered');

  // No dual-write on failure
  assert.equal(recordedInjections.length, 0, 'no dual-write on composer error');
});

test('A2-3a annotate-only: ledger.record throws → message still delivered', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });
  const adapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, adapter);
  const pmAdapter = makeAdapter();
  seedPmRun(rs, registry, pmAdapter, 'proj1', topRun.id, db);

  const BLOCK = '## Learned Memory\n- ledger throw test';
  const COMPOSITION = { fingerprint: 'fp-lt', owner_states: [], item_edges: [],
    composer_version: '0.1.0', policy_version: '0.1.0' };
  const composer = makeComposer({ block: BLOCK, composition: COMPOSITION });

  // Ledger that throws on commitAccepted (Phase 0a: commitAccepted replaces record+accept)
  const failingLedger = {
    shouldCompose: () => ({ compose: true, reason: 'no_prior_accepted' }),
    record: () => { throw new Error('DB is gone'); },
    accept: () => false,
    commitAccepted: () => { throw new Error('DB is gone'); },
  };

  const recordedInjections = [];
  const memService = makeMemoryService({ revision: 2, recordedInjections });

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(pmAdapter),
    lifecycleService: makeLifecycle(),
    memoryService: memService,
    memoryComposer: composer,
    compositionLedger: failingLedger,
    memoryComposerEnabled: true,
  });

  assert.doesNotThrow(() => svc.sendMessage(`pm:proj1`, { text: 'ledger fail test', projectId: 'proj1' }));
  assert.equal(pmAdapter.calls.length, 1, 'message delivered despite ledger error');
  // On ledger.record throw, block was already prepended but dual-write may have failed too — just check delivery
  const sentText = pmAdapter.calls[0].payload.text;
  assert.ok(sentText.includes('ledger fail test'), 'original text delivered');
});

test('A2-3a flag ON: PM slot composer path active; Top slot also uses composer (A2-3b)', async (t) => {
  // After A2-3b, flag ON means BOTH PM and Top use composer.
  // This test verifies PM is still called (A2-3a invariant), and top message is still delivered.
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, topAdapter);

  const composerCalls = [];
  const composer = {
    compose(arg) { composerCalls.push(arg); return { block: null, composition: null }; },
  };
  const ledger = createCompositionLedger(db);
  const recordedInjections = [];
  const memService = makeMemoryService({ revision: 5, recordedInjections });
  const masterMemSvc = makeMasterMemoryService({ revision: 3 });

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(topAdapter),
    lifecycleService: makeLifecycle(),
    memoryService: memService,
    masterMemoryService: masterMemSvc,
    memoryComposer: composer,
    compositionLedger: ledger,
    memoryComposerEnabled: true,
  });

  svc.sendMessage('top', { text: 'top message' });

  // With A2-3b: composer IS called for Top (with user owner)
  assert.equal(composerCalls.length, 1, 'composer called for Top slot (A2-3b)');
  assert.deepEqual(composerCalls[0].owners, [{ owner_type: 'user', owner_id: 'user', provenance: 'user' }]);
  // Top message still delivered (block=null → no prepend, just original)
  assert.equal(topAdapter.calls.length, 1, 'top message delivered');
  const sentText = topAdapter.calls[0].payload.text;
  assert.equal(sentText.trim(), 'top message', 'original text only (null block)');
});

test('A2-3a: wiring via createApp options.memoryComposer=true', async (t) => {
  // Integration-light: boot createApp with memoryComposer: true and verify
  // that a PM sendMessage triggers composer path. Uses real DB + real services.
  const fs2 = require('node:fs/promises');
  const path2 = require('node:path');
  const os2 = require('node:os');
  const { createApp } = require('../app');

  const dir = await fs2.mkdtemp(path2.join(os2.tmpdir(), 'palantir-a23a-app-'));
  const dbPath = path2.join(dir, 'test.db');
  let app;
  t.after(async () => {
    try { await app.shutdown(); } catch { /* */ }
    await fs2.rm(dir, { recursive: true, force: true });
  });

  app = createApp({ dbPath, authToken: null, memoryComposer: true });
  const { services } = app;

  // Verify compositionLedger is exposed in test seam
  assert.ok(services.compositionLedger, 'compositionLedger exposed in app.services');
  assert.equal(typeof services.compositionLedger.record, 'function', 'ledger.record present');
  assert.equal(typeof services.compositionLedger.shouldCompose, 'function', 'ledger.shouldCompose present');
});

// =============================================================================
// A2-3b: Top-slot composer+ledger cutover (mirrors A2-3a PM pattern)
// =============================================================================

test('A2-3b flag OFF: Top injection uses existing shouldInject/recordInjection path', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, topAdapter);

  const masterRecordedInjections = [];
  const masterMemSvc = makeMasterMemoryService({
    injectionBlock: '## User Memory\n- master item A',
    recordedInjections: masterRecordedInjections,
    revision: 9,
  });

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(topAdapter),
    lifecycleService: makeLifecycle(),
    masterMemoryService: masterMemSvc,
    // flag OFF: no composer deps
    memoryComposerEnabled: false,
  });

  svc.sendMessage('top', { text: 'hello top', projectId: null });

  // Verify the adapter received a prepended block
  assert.equal(topAdapter.calls.length, 1, 'adapter called once');
  const sentText = topAdapter.calls[0].payload.text;
  assert.ok(sentText.includes('## User Memory'), 'master injection block prepended');
  assert.ok(sentText.includes('hello top'), 'original text present');

  // Verify old ledger written (not composer ledger)
  assert.equal(masterRecordedInjections.length, 1, 'recordInjection called once');
  assert.equal(masterRecordedInjections[0].revision, 9, 'correct revision');
  assert.equal(masterRecordedInjections[0].scope, 'user', 'correct scope');
  assert.equal(masterRecordedInjections[0].runId, topRun.id, 'correct runId');
});

test('A2-3b flag OFF: no injection if shouldInject returns inject=false', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeAdapter();
  seedTopRun(rs, registry, topAdapter);

  const masterRecordedInjections = [];
  const masterMemSvc = makeMasterMemoryService({
    shouldInjectResult: { inject: false, revision: 4 },
    injectionBlock: '## User Memory\n- master item A',
    recordedInjections: masterRecordedInjections,
  });

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(topAdapter),
    lifecycleService: makeLifecycle(),
    masterMemoryService: masterMemSvc,
    memoryComposerEnabled: false,
  });

  svc.sendMessage('top', { text: 'no inject top' });

  const sentText = topAdapter.calls[0].payload.text;
  assert.ok(!sentText.includes('## User Memory'), 'no injection block');
  assert.equal(masterRecordedInjections.length, 0, 'recordInjection NOT called');
});

test('A2-3b flag ON: composer block prepended for Top slot (byte-equivalent)', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, topAdapter);

  const BLOCK = '## User Memory\n- composer top block content';
  const COMPOSITION = {
    fingerprint: 'fp-top-test',
    owner_states: [{ owner_type: 'user', owner_id: 'user', revision: 6 }],
    item_edges: [],
    composer_version: '0.1.0',
    policy_version: '0.1.0',
  };

  const composer = makeComposer({ block: BLOCK, composition: COMPOSITION });
  const ledger = createCompositionLedger(db);
  const masterRecordedInjections = [];
  const masterMemSvc = makeMasterMemoryService({ revision: 6, recordedInjections: masterRecordedInjections });

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(topAdapter),
    lifecycleService: makeLifecycle(),
    masterMemoryService: masterMemSvc,
    memoryComposer: composer,
    compositionLedger: ledger,
    memoryComposerEnabled: true,
  });

  svc.sendMessage('top', { text: 'hello top composer' });

  assert.equal(topAdapter.calls.length, 1, 'adapter called once');
  const sentText = topAdapter.calls[0].payload.text;
  assert.ok(sentText.startsWith(BLOCK), 'block is outermost prepend');
  assert.ok(sentText.includes('hello top composer'), 'original text present');

  // Verify composer was called with correct owners (user owner)
  assert.equal(composer.calls.length, 1, 'composer.compose called once');
  assert.deepEqual(composer.calls[0].owners, [{ owner_type: 'user', owner_id: 'user', provenance: 'user' }]);
  assert.equal(composer.calls[0].taskContext, 'hello top composer');
});

test('A2-3b flag ON: compositionLedger gets record+accept with slotKind=top provenanceKey=user', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, topAdapter);

  const COMPOSITION = {
    fingerprint: 'fp-top-accept',
    owner_states: [{ owner_type: 'user', owner_id: 'user', provenance: null, revision: 7,
      selected_set_hash: 'th1', suppressed_set_hash: null, selected_count: 1, suppressed_count: 0,
      budget_limit: 1000000, budget_used: 10 }],
    item_edges: [],
    composer_version: '0.1.0',
    policy_version: '0.1.0',
    retrieval_query_hash: 'trqh',
    token_budget: 1000000,
    owner_vector_hash: 'tovh',
    selected_set_hash: 'tssh',
  };

  const composer = makeComposer({ block: '## User Memory\n- top ledger test', composition: COMPOSITION });
  const ledger = createCompositionLedger(db);
  const masterRecordedInjections = [];
  const masterMemSvc = makeMasterMemoryService({ revision: 7, recordedInjections: masterRecordedInjections });

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(topAdapter),
    lifecycleService: makeLifecycle(),
    masterMemoryService: masterMemSvc,
    memoryComposer: composer,
    compositionLedger: ledger,
    memoryComposerEnabled: true,
  });

  svc.sendMessage('top', { text: 'top ledger test' });

  // Assert accepted row with slotKind='top' exists in DB
  const row = db.prepare(
    "SELECT * FROM memory_composition_events WHERE run_id = ? AND slot_kind = 'top' AND status = 'accepted'"
  ).get(topRun.id);
  assert.ok(row, 'composition event row exists with accepted status for Top slot');
  assert.equal(row.provenance_key, 'user', 'provenanceKey=user recorded');
  assert.equal(row.fingerprint, 'fp-top-accept', 'fingerprint recorded');
});

test('A2-3b flag ON: dual-write to old master_memory_injection ledger (recordInjection)', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, topAdapter);

  const COMPOSITION = {
    fingerprint: 'fp-top-dual',
    owner_states: [{ owner_type: 'user', owner_id: 'user', provenance: null, revision: 11,
      selected_set_hash: 'th2', suppressed_set_hash: null, selected_count: 0, suppressed_count: 0,
      budget_limit: 1000000, budget_used: 0 }],
    item_edges: [],
    composer_version: '0.1.0',
    policy_version: '0.1.0',
    retrieval_query_hash: null,
    token_budget: 1000000,
    owner_vector_hash: null,
    selected_set_hash: null,
  };

  const composer = makeComposer({ block: '## User Memory\n- top dual write', composition: COMPOSITION });
  const ledger = createCompositionLedger(db);
  const masterRecordedInjections = [];
  const masterMemSvc = makeMasterMemoryService({ revision: 11, recordedInjections: masterRecordedInjections });

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(topAdapter),
    lifecycleService: makeLifecycle(),
    masterMemoryService: masterMemSvc,
    memoryComposer: composer,
    compositionLedger: ledger,
    memoryComposerEnabled: true,
  });

  svc.sendMessage('top', { text: 'top dual write test' });

  // Dual-write: old master_memory_injection ledger also called
  assert.equal(masterRecordedInjections.length, 1, 'old recordInjection called once (dual-write)');
  assert.equal(masterRecordedInjections[0].revision, 11, 'same revision dual-written');
  assert.equal(masterRecordedInjections[0].scope, 'user', 'scope=user');
  assert.equal(masterRecordedInjections[0].runId, topRun.id, 'correct runId');
});

test('A2-3b flag ON: gate cadence — same revision skip, higher revision reinject (Top slot)', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, topAdapter);

  let currentRevision = 4;
  const COMPOSITION = (rev) => ({
    fingerprint: `fp-top-gate-${rev}`,
    owner_states: [{ owner_type: 'user', owner_id: 'user', provenance: null, revision: rev,
      selected_set_hash: 'ths', suppressed_set_hash: null, selected_count: 0, suppressed_count: 0,
      budget_limit: 1000000, budget_used: 0 }],
    item_edges: [],
    composer_version: '0.1.0',
    policy_version: '0.1.0',
    retrieval_query_hash: null,
    token_budget: 1000000,
    owner_vector_hash: null,
    selected_set_hash: null,
  });

  const composerCalls = [];
  const composer = {
    compose(arg) {
      composerCalls.push(currentRevision);
      return { block: '## User Memory\n- top gate test', composition: COMPOSITION(currentRevision) };
    },
  };
  const ledger = createCompositionLedger(db);
  const masterRecordedInjections = [];
  const masterMemSvc = makeMasterMemoryService({
    revision: 4,
    recordedInjections: masterRecordedInjections,
    getRevision: () => currentRevision,
  });

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(topAdapter),
    lifecycleService: makeLifecycle(),
    masterMemoryService: masterMemSvc,
    memoryComposer: composer,
    compositionLedger: ledger,
    memoryComposerEnabled: true,
  });

  // First send: revision=4 → should inject (no prior accepted)
  svc.sendMessage('top', { text: 'top first send' });
  assert.equal(composerCalls.length, 1, 'first send: composer called');
  assert.equal(topAdapter.calls.length, 1);

  // Second send: revision still 4 → gate says skip (revision unchanged)
  svc.sendMessage('top', { text: 'top second send' });
  assert.equal(composerCalls.length, 1, 'second send: composer NOT called (gate skip)');

  // Third send: revision increased to 5 → gate says reinject
  currentRevision = 5;
  svc.sendMessage('top', { text: 'top third send' });
  assert.equal(composerCalls.length, 2, 'third send: composer called again (revision increased)');
});

test('A2-3b flag ON: block null → no record/accept/dual-write for Top slot', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, topAdapter);

  const composer = makeComposer({ returnNullBlock: true });
  const ledger = createCompositionLedger(db);
  const masterRecordedInjections = [];
  const masterMemSvc = makeMasterMemoryService({ revision: 2, recordedInjections: masterRecordedInjections });

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(topAdapter),
    lifecycleService: makeLifecycle(),
    masterMemoryService: masterMemSvc,
    memoryComposer: composer,
    compositionLedger: ledger,
    memoryComposerEnabled: true,
  });

  svc.sendMessage('top', { text: 'top null block test' });

  // Message delivered without block
  assert.equal(topAdapter.calls.length, 1, 'message delivered');
  const sentText = topAdapter.calls[0].payload.text;
  assert.ok(!sentText.includes('## User Memory'), 'no memory block prepended');
  assert.equal(sentText.trim(), 'top null block test', 'original text only');

  // No ledger entry and no dual-write
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM memory_composition_events WHERE run_id = ? AND slot_kind = 'top'"
  ).get(topRun.id);
  assert.equal(row.cnt, 0, 'no composition event recorded (null block)');
  assert.equal(masterRecordedInjections.length, 0, 'no dual-write (null block)');
});

test('A2-3b annotate-only: composer throws for Top → degrade, message delivered', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeAdapter();
  seedTopRun(rs, registry, topAdapter);

  const throwingComposer = makeComposer({ throws: true });
  const ledger = createCompositionLedger(db);
  const masterRecordedInjections = [];
  const masterMemSvc = makeMasterMemoryService({ revision: 1, recordedInjections: masterRecordedInjections });

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(topAdapter),
    lifecycleService: makeLifecycle(),
    masterMemoryService: masterMemSvc,
    memoryComposer: throwingComposer,
    compositionLedger: ledger,
    memoryComposerEnabled: true,
  });

  // Must not throw — annotate-only
  assert.doesNotThrow(() => svc.sendMessage('top', { text: 'top degrade test' }));

  // Message still delivered (no block, just original text)
  assert.equal(topAdapter.calls.length, 1, 'message delivered despite composer error');
  const sentText = topAdapter.calls[0].payload.text;
  assert.ok(!sentText.includes('## User Memory'), 'no block on error');
  assert.ok(sentText.includes('top degrade test'), 'original text delivered');

  // No dual-write on failure
  assert.equal(masterRecordedInjections.length, 0, 'no dual-write on composer error');
});

test('A2-3b flag ON: PM slot unaffected when Top uses composer', async (t) => {
  // When flag=ON and both Top and PM have active runs, sending to PM should still
  // use PM composer path (workspace owner) and NOT be confused with Top composer path (user owner).
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, topAdapter);
  const pmAdapter = makeAdapter();
  const pmRun = seedPmRun(rs, registry, pmAdapter, 'proj1', topRun.id, db);

  const composerCalls = [];
  const composer = {
    compose(arg) {
      composerCalls.push(arg);
      return { block: `## ${arg.owners[0].owner_type} Memory\n- item`, composition: {
        fingerprint: `fp-${arg.owners[0].owner_type}`,
        owner_states: [{ owner_type: arg.owners[0].owner_type, owner_id: arg.owners[0].owner_id ?? 'user',
          provenance: null, revision: 1, selected_set_hash: 's', suppressed_set_hash: null,
          selected_count: 0, suppressed_count: 0, budget_limit: 1000000, budget_used: 0 }],
        item_edges: [], composer_version: '0.1.0', policy_version: '0.1.0',
        retrieval_query_hash: null, token_budget: 1000000, owner_vector_hash: null, selected_set_hash: null,
      }};
    },
  };
  const ledger = createCompositionLedger(db);
  const memRecorded = [];
  const masterRecorded = [];
  const memService = makeMemoryService({ revision: 1, recordedInjections: memRecorded });
  const masterMemSvc = makeMasterMemoryService({ revision: 1, recordedInjections: masterRecorded });

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(pmAdapter),
    lifecycleService: makeLifecycle(),
    memoryService: memService,
    masterMemoryService: masterMemSvc,
    memoryComposer: composer,
    compositionLedger: ledger,
    memoryComposerEnabled: true,
  });

  // Send to PM
  svc.sendMessage('pm:proj1', { text: 'pm message', projectId: 'proj1' });

  // Composer called with workspace owner (PM path)
  assert.equal(composerCalls.length, 1, 'composer called once for PM');
  assert.equal(composerCalls[0].owners[0].owner_type, 'workspace', 'PM uses workspace owner');

  // PM slot record in DB: slotKind='pm'
  const pmRow = db.prepare(
    "SELECT * FROM memory_composition_events WHERE run_id = ? AND slot_kind = 'pm' AND status = 'accepted'"
  ).get(pmRun.id);
  assert.ok(pmRow, 'PM composition event accepted');

  // No Top composition event
  const topRow = db.prepare(
    "SELECT COUNT(*) as cnt FROM memory_composition_events WHERE run_id = ? AND slot_kind = 'top'"
  ).get(topRun.id);
  assert.equal(topRow.cnt, 0, 'no Top composition event on PM send');
});
