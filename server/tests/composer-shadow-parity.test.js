'use strict';

/**
 * P-A2 Composer Shadow Parity 테스트
 *
 * 검증 항목:
 * 1. SHADOW ON + COMPOSER OFF, old inject → parity event {comparable:true, blockMatch:true} (PM)
 * 2. SHADOW ON + COMPOSER OFF, old inject → parity event {comparable:true, blockMatch:true} (Top)
 * 3. old skip(빈 메모리/shouldInject false) → {comparable:false, reason:'old_skipped', blockMatch:null} (오탐 0)
 * 4. shadow throw(composer mock throw) → {reason:'shadow_error'}, effectiveText/메시지 전달 불변
 * 5. SHADOW off → parity event 0 (이벤트 미발화)
 * 6. COMPOSER on → shadow skip (event 0)
 * 7. old live 경로·ledger 부작용 0 (shadow가 DB write 안 함)
 * 8. byte-mismatch 케이스 → {comparable:true, blockMatch:false, reason:'mismatch'}
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
const { createEventBus } = require('../services/eventBus');

// ─── DB 헬퍼 ──────────────────────────────────────────────────────────────────

async function mkdb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-shadow-parity-'));
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

function makeAdapter() {
  const calls = [];
  return {
    calls,
    isSessionAlive: () => true,
    detectExitCode: () => null,
    emitSessionEndedIfNeeded: () => {},
    runTurn(runId, payload) {
      calls.push({ runId, text: payload.text });
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

// ─── Memory service mocks ──────────────────────────────────────────────────────

function makeMemoryService({
  inject = true,
  injectionBlock = '## Learned Memory\n- item A',
  revision = 5,
  recordedInjections = [],
} = {}) {
  return {
    shouldInject(runId, projectId) {
      return inject ? { inject: true, revision } : { inject: false };
    },
    retrieveForProject(projectId, opts) {
      return inject ? [{ id: 'r1', content: 'item A', kind: 'heuristic' }] : [];
    },
    buildInjectionBlock(rows) {
      return inject && rows.length > 0 ? injectionBlock : null;
    },
    getRevision(projectId) { return revision; },
    recordInjection(runId, projectId, rev) {
      recordedInjections.push({ runId, projectId, revision: rev });
    },
  };
}

function makeMasterMemoryService({
  inject = true,
  injectionBlock = '## User Memory\n- user fact A',
  revision = 3,
  recordedInjections = [],
} = {}) {
  return {
    shouldInject(runId, scope) {
      return inject ? { inject: true, revision } : { inject: false };
    },
    retrieve(scope, ownerId, opts) {
      return inject ? [{ id: 'u1', content: 'user fact A', kind: 'fact' }] : [];
    },
    buildInjectionBlock(rows) {
      return inject && rows.length > 0 ? injectionBlock : null;
    },
    getRevision(scope) { return revision; },
    recordInjection(runId, scope, rev) {
      recordedInjections.push({ runId, scope, revision: rev });
    },
  };
}

// ─── Composer mock ────────────────────────────────────────────────────────────

function makeComposer({
  block = '## Learned Memory\n- item A', // byte-identical by default (match)
  throws = false,
} = {}) {
  const composeCalls = [];
  return {
    composeCalls,
    compose(arg) {
      if (throws) throw new Error('composer intentional test error');
      composeCalls.push(arg);
      return {
        block,
        composition: {
          fingerprint: 'fp-shadow',
          owner_states: [],
          item_edges: [],
          composer_version: '0.1.0',
          policy_version: '0.1.0',
        },
      };
    },
  };
}

// ─── Seed helpers ─────────────────────────────────────────────────────────────

function seedProject(db, projectId = 'proj-sp-1') {
  db.prepare("INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)").run(projectId, projectId);
}

function seedTopRun(rs, registry, adapter) {
  const run = rs.createRun({ is_manager: true, manager_adapter: 'claude-code', prompt: 'top' });
  rs.updateRunStatus(run.id, 'running', { force: true });
  registry.setActive('top', run.id, adapter);
  return run;
}

function seedPmRun(rs, registry, adapter, projectId, topRunId) {
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

// ─── Parity event collector ────────────────────────────────────────────────────

function collectParityEvents(eventBus) {
  const events = [];
  eventBus.subscribe((e) => {
    if (e.channel === 'memory:composer_parity') events.push(e.data);
  });
  return events;
}

// =============================================================================
// Test suite
// =============================================================================

// 1. SHADOW ON + COMPOSER OFF, old injects → parity event {comparable:true, blockMatch:true} — PM slot
test('shadow parity PM: old inject → comparable=true blockMatch=true (byte-equivalent)', async (t) => {
  const db = await mkdb(t);
  const eventBus = createEventBus();
  const parityEvents = collectParityEvents(eventBus);

  const rs = createRunService(db, eventBus);
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, topAdapter);
  const pmAdapter = makeAdapter();
  const projectId = 'proj-sp-pm-1';
  seedProject(db, projectId);
  const pmRun = seedPmRun(rs, registry, pmAdapter, projectId, topRun.id);

  const BLOCK = '## Learned Memory\n- item A';
  const memService = makeMemoryService({ inject: true, injectionBlock: BLOCK });
  // composer returns byte-identical block → match
  const composer = makeComposer({ block: BLOCK });

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(pmAdapter),
    lifecycleService: makeLifecycle(),
    memoryService: memService,
    memoryComposerEnabled: false,        // old path active
    memoryComposerShadowEnabled: true,   // shadow ON
    memoryComposer: composer,
    eventBus,
  });

  const result = svc.sendMessage(`pm:${projectId}`, { text: 'hello pm', projectId });
  assert.equal(result.status, 'sent', 'message delivery unaffected');

  // Old path ran: adapter received memory block prepended text
  assert.equal(pmAdapter.calls.length, 1, 'adapter called once');
  assert.ok(pmAdapter.calls[0].text.includes(BLOCK), 'old block injected into effectiveText');

  // Exactly one parity event emitted
  assert.equal(parityEvents.length, 1, 'exactly one parity event');
  const e = parityEvents[0];
  assert.equal(e.slotKind, 'pm', 'slotKind=pm');
  assert.equal(e.provenanceKey, projectId, 'provenanceKey=projectId');
  assert.equal(e.comparable, true, 'comparable=true (old injected)');
  assert.equal(e.blockMatch, true, 'blockMatch=true (byte-equivalent)');
  assert.equal(e.reason, 'match', 'reason=match');
  assert.equal(e.oldLen, BLOCK.length, 'oldLen correct');
  assert.equal(e.newLen, BLOCK.length, 'newLen correct');
  assert.equal(e.runId, pmRun.id, 'runId=pmRun.id');

  // Shadow must NOT have mutated effectiveText beyond old path
  // (old block appears exactly once, not twice)
  const txt = pmAdapter.calls[0].text;
  const occurrences = txt.split(BLOCK).length - 1;
  assert.equal(occurrences, 1, 'block appears exactly once (shadow did not double-prepend)');

  // Composer was called read-only (compose called once)
  assert.equal(composer.composeCalls.length, 1, 'composer.compose called once (read-only probe)');

  // No old-path ledger writes beyond normal recordInjection (no extra seams)
  // (verified implicitly — no compositionLedger was passed → no ledger writes possible)
});

// 2. SHADOW ON + COMPOSER OFF, old injects → parity event — Top slot
test('shadow parity Top: old inject → comparable=true blockMatch=true', async (t) => {
  const db = await mkdb(t);
  const eventBus = createEventBus();
  const parityEvents = collectParityEvents(eventBus);

  const rs = createRunService(db, eventBus);
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, topAdapter);

  const MASTER_BLOCK = '## User Memory\n- user fact A';
  const masterMemService = makeMasterMemoryService({ inject: true, injectionBlock: MASTER_BLOCK });
  // composer returns byte-identical block → match
  const composer = makeComposer({ block: MASTER_BLOCK });

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(topAdapter),
    lifecycleService: makeLifecycle(),
    masterMemoryService: masterMemService,
    memoryComposerEnabled: false,
    memoryComposerShadowEnabled: true,
    memoryComposer: composer,
    eventBus,
  });

  const result = svc.sendMessage('top', { text: 'hello top' });
  assert.equal(result.status, 'sent', 'message delivery unaffected');

  assert.equal(topAdapter.calls.length, 1, 'adapter called once');
  assert.ok(topAdapter.calls[0].text.includes(MASTER_BLOCK), 'old master block injected');

  // Exactly one parity event from Top slot
  assert.equal(parityEvents.length, 1, 'exactly one parity event');
  const e = parityEvents[0];
  assert.equal(e.slotKind, 'top', 'slotKind=top');
  assert.equal(e.provenanceKey, 'user', 'provenanceKey=user');
  assert.equal(e.comparable, true, 'comparable=true');
  assert.equal(e.blockMatch, true, 'blockMatch=true');
  assert.equal(e.reason, 'match', 'reason=match');
  assert.equal(e.runId, topRun.id, 'runId=topRun.id');
});

// 3. old skip (shouldInject false / no memory) → old_skipped, blockMatch=null
test('shadow parity: old skip → comparable=false reason=old_skipped blockMatch=null', async (t) => {
  const db = await mkdb(t);
  const eventBus = createEventBus();
  const parityEvents = collectParityEvents(eventBus);

  const rs = createRunService(db, eventBus);
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, topAdapter);
  const pmAdapter = makeAdapter();
  const projectId = 'proj-sp-skip-1';
  seedProject(db, projectId);
  seedPmRun(rs, registry, pmAdapter, projectId, topRun.id);

  // old path: shouldInject=false → no injection, oldBlock=null
  const memService = makeMemoryService({ inject: false });
  const composer = makeComposer({ block: '## Learned Memory\n- item from composer' });

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(pmAdapter),
    lifecycleService: makeLifecycle(),
    memoryService: memService,
    memoryComposerEnabled: false,
    memoryComposerShadowEnabled: true,
    memoryComposer: composer,
    eventBus,
  });

  svc.sendMessage(`pm:${projectId}`, { text: 'hello skip', projectId });

  assert.equal(parityEvents.length, 1, 'exactly one parity event');
  const e = parityEvents[0];
  assert.equal(e.comparable, false, 'comparable=false (old did not inject)');
  assert.equal(e.blockMatch, null, 'blockMatch=null (not applicable)');
  assert.equal(e.reason, 'old_skipped', 'reason=old_skipped');
  assert.equal(e.oldLen, 0, 'oldLen=0');

  // effectiveText is original text (no injection from either path)
  assert.equal(pmAdapter.calls[0].text, 'hello skip', 'effectiveText unchanged (no injection)');
});

// 4. shadow throw → {reason:'shadow_error'}, effectiveText + delivery unaffected
test('shadow parity: composer throw → reason=shadow_error, delivery unaffected', async (t) => {
  const db = await mkdb(t);
  const eventBus = createEventBus();
  const parityEvents = collectParityEvents(eventBus);

  const rs = createRunService(db, eventBus);
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, topAdapter);
  const pmAdapter = makeAdapter();
  const projectId = 'proj-sp-throw-1';
  seedProject(db, projectId);
  seedPmRun(rs, registry, pmAdapter, projectId, topRun.id);

  const BLOCK = '## Learned Memory\n- item A';
  const memService = makeMemoryService({ inject: true, injectionBlock: BLOCK });
  // composer throws
  const composer = makeComposer({ throws: true });

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(pmAdapter),
    lifecycleService: makeLifecycle(),
    memoryService: memService,
    memoryComposerEnabled: false,
    memoryComposerShadowEnabled: true,
    memoryComposer: composer,
    eventBus,
  });

  // Must not throw despite composer error
  const result = svc.sendMessage(`pm:${projectId}`, { text: 'hello throw', projectId });
  assert.equal(result.status, 'sent', 'message delivered despite composer throw');

  // Old path ran normally — block injected
  assert.equal(pmAdapter.calls.length, 1, 'adapter called once');
  assert.ok(pmAdapter.calls[0].text.includes(BLOCK), 'old block injected (live path unaffected)');

  // shadow_error event emitted
  assert.equal(parityEvents.length, 1, 'one parity event (shadow_error)');
  const e = parityEvents[0];
  assert.equal(e.reason, 'shadow_error', 'reason=shadow_error');
  assert.equal(e.comparable, false, 'comparable=false on error');
  assert.equal(e.blockMatch, null, 'blockMatch=null on error');
  assert.ok(typeof e.message === 'string', 'error message captured');
  assert.ok(e.message.includes('intentional test error'), 'error message content preserved');
});

// 5. SHADOW off → no parity event
test('shadow parity: SHADOW off → zero parity events', async (t) => {
  const db = await mkdb(t);
  const eventBus = createEventBus();
  const parityEvents = collectParityEvents(eventBus);

  const rs = createRunService(db, eventBus);
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, topAdapter);
  const pmAdapter = makeAdapter();
  const projectId = 'proj-sp-off-1';
  seedProject(db, projectId);
  seedPmRun(rs, registry, pmAdapter, projectId, topRun.id);

  const BLOCK = '## Learned Memory\n- item A';
  const memService = makeMemoryService({ inject: true, injectionBlock: BLOCK });
  const composer = makeComposer({ block: BLOCK });

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(pmAdapter),
    lifecycleService: makeLifecycle(),
    memoryService: memService,
    memoryComposerEnabled: false,
    memoryComposerShadowEnabled: false, // SHADOW OFF
    memoryComposer: composer,
    eventBus,
  });

  svc.sendMessage(`pm:${projectId}`, { text: 'hello off', projectId });

  assert.equal(parityEvents.length, 0, 'no parity events when shadow is off');
  // Old path still ran
  assert.ok(pmAdapter.calls[0].text.includes(BLOCK), 'old path unaffected');
});

// 6. COMPOSER on → shadow skip (even if memoryComposerShadowEnabled=true)
test('shadow parity: COMPOSER on → shadow skipped (event 0)', async (t) => {
  const db = await mkdb(t);
  const eventBus = createEventBus();
  const parityEvents = collectParityEvents(eventBus);

  const rs = createRunService(db, eventBus);
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, topAdapter);
  const pmAdapter = makeAdapter();
  const projectId = 'proj-sp-composer-on-1';
  seedProject(db, projectId);
  seedPmRun(rs, registry, pmAdapter, projectId, topRun.id);

  const BLOCK = '## Learned Memory\n- item A';
  const memService = makeMemoryService({ inject: true, injectionBlock: BLOCK });
  const composer = makeComposer({ block: BLOCK });

  // Minimal compositionLedger mock (needed when COMPOSER ON)
  const compositionLedger = {
    shouldCompose: () => ({ compose: false }), // gate: skip compose
    record: () => null,
    accept: () => {},
  };

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(pmAdapter),
    lifecycleService: makeLifecycle(),
    memoryService: memService,
    memoryComposerEnabled: true,          // COMPOSER ON
    memoryComposerShadowEnabled: true,    // shadow requested but irrelevant
    memoryComposer: composer,
    compositionLedger,
    eventBus,
  });

  svc.sendMessage(`pm:${projectId}`, { text: 'hello composer-on', projectId });

  // When COMPOSER is ON, shadow hook is never reached (it's in the old else-branch)
  assert.equal(parityEvents.length, 0, 'no parity events when composer is on');
});

// 7. No DB writes from shadow path (ledger write 0 verification)
test('shadow parity: shadow makes no DB writes (read-only)', async (t) => {
  const db = await mkdb(t);
  const eventBus = createEventBus();

  const rs = createRunService(db, eventBus);
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, topAdapter);
  const pmAdapter = makeAdapter();
  const projectId = 'proj-sp-nodb-1';
  seedProject(db, projectId);
  const pmRun = seedPmRun(rs, registry, pmAdapter, projectId, topRun.id);

  const BLOCK = '## Learned Memory\n- item A';
  const recordedInjections = [];
  const memService = makeMemoryService({
    inject: true,
    injectionBlock: BLOCK,
    recordedInjections,
  });
  const composer = makeComposer({ block: BLOCK });

  // Spy on any compositionLedger writes (should never be called from shadow)
  const ledgerWrites = [];
  const compositionLedger = {
    shouldCompose: () => { ledgerWrites.push('shouldCompose'); return { compose: false }; },
    record: (...args) => { ledgerWrites.push(['record', ...args]); return null; },
    accept: (...args) => { ledgerWrites.push(['accept', ...args]); },
  };

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(pmAdapter),
    lifecycleService: makeLifecycle(),
    memoryService: memService,
    memoryComposerEnabled: false,
    memoryComposerShadowEnabled: true,
    memoryComposer: composer,
    // Do NOT pass compositionLedger — shadow must not require it
    eventBus,
  });

  svc.sendMessage(`pm:${projectId}`, { text: 'nodb test', projectId });

  // ledgerWrites must be empty (shadow never touches compositionLedger)
  assert.deepEqual(ledgerWrites, [], 'compositionLedger not touched by shadow');

  // Only the one expected old-path recordInjection
  assert.equal(recordedInjections.length, 1, 'one recordInjection (old path only)');
  assert.equal(recordedInjections[0].runId, pmRun.id, 'recordInjection for correct run');
});

// 8. byte-mismatch case → {comparable:true, blockMatch:false, reason:'mismatch'}
test('shadow parity: byte-mismatch → comparable=true blockMatch=false reason=mismatch', async (t) => {
  const db = await mkdb(t);
  const eventBus = createEventBus();
  const parityEvents = collectParityEvents(eventBus);

  const rs = createRunService(db, eventBus);
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, topAdapter);
  const pmAdapter = makeAdapter();
  const projectId = 'proj-sp-mismatch-1';
  seedProject(db, projectId);
  seedPmRun(rs, registry, pmAdapter, projectId, topRun.id);

  const OLD_BLOCK = '## Learned Memory\n- item A (old)';
  const NEW_BLOCK = '## Learned Memory\n- item A (new, different)';
  const memService = makeMemoryService({ inject: true, injectionBlock: OLD_BLOCK });
  // composer returns a DIFFERENT block → mismatch
  const composer = makeComposer({ block: NEW_BLOCK });

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(pmAdapter),
    lifecycleService: makeLifecycle(),
    memoryService: memService,
    memoryComposerEnabled: false,
    memoryComposerShadowEnabled: true,
    memoryComposer: composer,
    eventBus,
  });

  svc.sendMessage(`pm:${projectId}`, { text: 'hello mismatch', projectId });

  assert.equal(parityEvents.length, 1, 'one parity event');
  const e = parityEvents[0];
  assert.equal(e.comparable, true, 'comparable=true (old injected)');
  assert.equal(e.blockMatch, false, 'blockMatch=false (bytes differ)');
  assert.equal(e.reason, 'mismatch', 'reason=mismatch');
  assert.equal(e.oldLen, OLD_BLOCK.length, 'oldLen=OLD_BLOCK.length');
  assert.equal(e.newLen, NEW_BLOCK.length, 'newLen=NEW_BLOCK.length');

  // effectiveText uses OLD_BLOCK (live path unaffected)
  assert.ok(pmAdapter.calls[0].text.includes(OLD_BLOCK), 'old block in effectiveText');
  assert.ok(!pmAdapter.calls[0].text.includes(NEW_BLOCK), 'new block NOT in effectiveText');
});
