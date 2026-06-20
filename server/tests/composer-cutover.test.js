'use strict';

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

async function mkdb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-composer-cutover-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    try { close(); } catch { /* ignore */ }
    await fs.rm(dir, { recursive: true, force: true });
  });
  return db;
}

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

function makeEventBus() {
  const emitted = [];
  return {
    emitted,
    emit(channel, data) {
      emitted.push({ channel, data });
    },
    subscribe() {},
  };
}

function makeMemoryService({ revision = 5, getRevision } = {}) {
  return {
    getRevision(projectId) {
      return getRevision ? getRevision(projectId) : revision;
    },
  };
}

function makeMasterMemoryService({ revision = 3, getRevision } = {}) {
  return {
    getRevision(scope) {
      return getRevision ? getRevision(scope) : revision;
    },
  };
}

function makeComposition({ fingerprint, ownerType, ownerId, provenance, revision }) {
  return {
    fingerprint,
    owner_states: [{
      owner_type: ownerType,
      owner_id: ownerId,
      provenance,
      revision,
      selected_set_hash: `${fingerprint}:selected`,
      suppressed_set_hash: null,
      selected_count: 1,
      suppressed_count: 0,
      budget_limit: 1000000,
      budget_used: 10,
    }],
    item_edges: [],
    composer_version: '0.1.0',
    policy_version: '0.1.0',
    retrieval_query_hash: null,
    token_budget: 1000000,
    owner_vector_hash: `${fingerprint}:owners`,
    selected_set_hash: `${fingerprint}:set`,
  };
}

function makeComposer({
  block = '## Learned Memory\n- composer memory',
  composition,
  composeImpl,
  throws = false,
} = {}) {
  const calls = [];
  return {
    calls,
    compose(arg) {
      if (throws) throw new Error('compose error');
      calls.push(arg);
      if (composeImpl) return composeImpl(arg);
      return {
        block,
        composition: composition ?? makeComposition({
          fingerprint: 'fp-default',
          ownerType: arg.owners[0].owner_type,
          ownerId: arg.owners[0].owner_id,
          provenance: arg.owners[0].provenance ?? arg.owners[0].owner_id,
          revision: 5,
        }),
      };
    },
  };
}

function seedProject(db, projectId = 'proj1') {
  db.prepare('INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)').run(projectId, projectId);
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

function makeService({
  rs,
  registry,
  adapter,
  memoryService = null,
  masterMemoryService = null,
  memoryComposer = null,
  compositionLedger = null,
  eventBus = null,
}) {
  return createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(adapter),
    lifecycleService: { sendAgentInput: () => false },
    memoryService,
    masterMemoryService,
    memoryComposer,
    compositionLedger,
    eventBus,
    logger: () => {},
  });
}

function countAccepted(db, runId, slotKind) {
  return db.prepare(
    'SELECT COUNT(*) AS n FROM memory_composition_events WHERE run_id = ? AND slot_kind = ? AND status = ?'
  ).get(runId, slotKind, 'accepted').n;
}

test('composer path: PM prepends composer block and commits an accepted composition', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeAdapter();
  const pmAdapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, topAdapter);
  const pmRun = seedPmRun(rs, registry, pmAdapter, 'proj1', topRun.id, db);
  const block = '## Learned Memory\n- composer block content';
  const composer = makeComposer({
    block,
    composition: makeComposition({
      fingerprint: 'fp-pm-accepted',
      ownerType: 'workspace',
      ownerId: 'proj1',
      provenance: 'proj1',
      revision: 5,
    }),
  });
  const svc = makeService({
    rs,
    registry,
    adapter: pmAdapter,
    memoryService: makeMemoryService({ revision: 5 }),
    memoryComposer: composer,
    compositionLedger: createCompositionLedger(db),
  });

  svc.sendMessage('pm:proj1', { text: 'hello composer', projectId: 'proj1' });

  assert.equal(pmAdapter.calls.length, 1);
  assert.ok(pmAdapter.calls[0].payload.text.startsWith(block));
  assert.match(pmAdapter.calls[0].payload.text, /hello composer/);
  assert.deepEqual(composer.calls[0].owners, [{ owner_type: 'workspace', owner_id: 'proj1' }]);

  const row = db.prepare(
    "SELECT * FROM memory_composition_events WHERE run_id = ? AND slot_kind = 'pm' AND status = 'accepted'"
  ).get(pmRun.id);
  assert.ok(row);
  assert.equal(row.provenance_key, 'proj1');
  assert.equal(row.fingerprint, 'fp-pm-accepted');
});

test('composer path: PM gate cadence skips unchanged revision and reinjects after revision bump', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeAdapter();
  const pmAdapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, topAdapter);
  seedPmRun(rs, registry, pmAdapter, 'proj1', topRun.id, db);
  let currentRevision = 5;
  const composer = makeComposer({
    composeImpl: () => ({
      block: `## Learned Memory\n- revision ${currentRevision}`,
      composition: makeComposition({
        fingerprint: `fp-pm-${currentRevision}`,
        ownerType: 'workspace',
        ownerId: 'proj1',
        provenance: 'proj1',
        revision: currentRevision,
      }),
    }),
  });
  const svc = makeService({
    rs,
    registry,
    adapter: pmAdapter,
    memoryService: makeMemoryService({ getRevision: () => currentRevision }),
    memoryComposer: composer,
    compositionLedger: createCompositionLedger(db),
  });

  svc.sendMessage('pm:proj1', { text: 'first', projectId: 'proj1' });
  svc.sendMessage('pm:proj1', { text: 'second', projectId: 'proj1' });
  currentRevision = 6;
  svc.sendMessage('pm:proj1', { text: 'third', projectId: 'proj1' });

  assert.equal(composer.calls.length, 2);
  assert.match(pmAdapter.calls[0].payload.text, /revision 5/);
  assert.doesNotMatch(pmAdapter.calls[1].payload.text, /## Learned Memory/);
  assert.match(pmAdapter.calls[2].payload.text, /revision 6/);
});

test('composer path: PM null block does not commit ledger rows and null composition emits failure', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeAdapter();
  const pmAdapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, topAdapter);
  const pmRun = seedPmRun(rs, registry, pmAdapter, 'proj1', topRun.id, db);
  const eventBus = makeEventBus();
  const composer = makeComposer({ composeImpl: () => ({ block: null, composition: null }) });
  const svc = makeService({
    rs,
    registry,
    adapter: pmAdapter,
    memoryService: makeMemoryService({ revision: 1 }),
    memoryComposer: composer,
    compositionLedger: createCompositionLedger(db),
    eventBus,
  });

  svc.sendMessage('pm:proj1', { text: 'empty memory', projectId: 'proj1' });

  assert.equal(pmAdapter.calls.length, 1);
  assert.equal(pmAdapter.calls[0].payload.text, 'empty memory');
  assert.equal(countAccepted(db, pmRun.id, 'pm'), 0);
  const failed = eventBus.emitted.filter((e) => e.channel === 'memory:composer_failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].data.slotKind, 'pm');
});

test('composer path: parent notice order stays memory block, notices, original text', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeAdapter();
  const pmAdapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, topAdapter);
  const pmRun = seedPmRun(rs, registry, pmAdapter, 'proj1', topRun.id, db);
  const block = '## Learned Memory\n- keep notices inside memory';
  const svc = makeService({
    rs,
    registry,
    adapter: pmAdapter,
    memoryService: makeMemoryService({ revision: 2 }),
    memoryComposer: makeComposer({
      block,
      composition: makeComposition({
        fingerprint: 'fp-order',
        ownerType: 'workspace',
        ownerId: 'proj1',
        provenance: 'proj1',
        revision: 2,
      }),
    }),
    compositionLedger: createCompositionLedger(db),
  });
  svc.queueParentNotice(pmRun.id, '[system notice]\nworker changed state');

  svc.sendMessage('pm:proj1', { text: 'continue plan', projectId: 'proj1' });

  const sent = pmAdapter.calls[0].payload.text;
  assert.ok(sent.indexOf(block) < sent.indexOf('[system notice]'));
  assert.ok(sent.indexOf('[system notice]') < sent.indexOf('continue plan'));
});

test('composer path: composer and commit failures degrade after delivery', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeAdapter();
  const pmAdapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, topAdapter);
  seedPmRun(rs, registry, pmAdapter, 'proj1', topRun.id, db);

  const throwingComposerSvc = makeService({
    rs,
    registry,
    adapter: pmAdapter,
    memoryService: makeMemoryService({ revision: 1 }),
    memoryComposer: makeComposer({ throws: true }),
    compositionLedger: createCompositionLedger(db),
  });
  assert.doesNotThrow(() => throwingComposerSvc.sendMessage('pm:proj1', { text: 'composer fails', projectId: 'proj1' }));
  assert.equal(pmAdapter.calls[0].payload.text, 'composer fails');

  const commitThrowsLedger = {
    shouldCompose: () => ({ compose: true, reason: 'changed' }),
    commitAccepted: () => { throw new Error('commit failed'); },
  };
  const commitFailSvc = makeService({
    rs,
    registry,
    adapter: pmAdapter,
    memoryService: makeMemoryService({ revision: 2 }),
    memoryComposer: makeComposer({
      block: '## Learned Memory\n- commit still delivers',
      composition: makeComposition({
        fingerprint: 'fp-commit-fail',
        ownerType: 'workspace',
        ownerId: 'proj1',
        provenance: 'proj1',
        revision: 2,
      }),
    }),
    compositionLedger: commitThrowsLedger,
  });
  assert.doesNotThrow(() => commitFailSvc.sendMessage('pm:proj1', { text: 'commit fails', projectId: 'proj1' }));
  assert.match(pmAdapter.calls[1].payload.text, /commit still delivers/);
});

test('composer path: Top prepends user composer block and commits top composition', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, topAdapter);
  const block = '## User Memory\n- top composer memory';
  const composer = makeComposer({
    block,
    composition: makeComposition({
      fingerprint: 'fp-top-accepted',
      ownerType: 'user',
      ownerId: 'user',
      provenance: 'user',
      revision: 7,
    }),
  });
  const svc = makeService({
    rs,
    registry,
    adapter: topAdapter,
    masterMemoryService: makeMasterMemoryService({ revision: 7 }),
    memoryComposer: composer,
    compositionLedger: createCompositionLedger(db),
  });

  svc.sendMessage('top', { text: 'hello top' });

  assert.equal(topAdapter.calls.length, 1);
  assert.ok(topAdapter.calls[0].payload.text.startsWith(block));
  assert.deepEqual(composer.calls[0].owners, [{ owner_type: 'user', owner_id: 'user', provenance: 'user' }]);
  const row = db.prepare(
    "SELECT * FROM memory_composition_events WHERE run_id = ? AND slot_kind = 'top' AND status = 'accepted'"
  ).get(topRun.id);
  assert.ok(row);
  assert.equal(row.provenance_key, 'user');
  assert.equal(row.fingerprint, 'fp-top-accepted');
});

test('composer path: Top gate cadence skips unchanged revision and reinjects after revision bump', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeAdapter();
  seedTopRun(rs, registry, topAdapter);
  let currentRevision = 4;
  const composer = makeComposer({
    composeImpl: () => ({
      block: `## User Memory\n- revision ${currentRevision}`,
      composition: makeComposition({
        fingerprint: `fp-top-${currentRevision}`,
        ownerType: 'user',
        ownerId: 'user',
        provenance: 'user',
        revision: currentRevision,
      }),
    }),
  });
  const svc = makeService({
    rs,
    registry,
    adapter: topAdapter,
    masterMemoryService: makeMasterMemoryService({ getRevision: () => currentRevision }),
    memoryComposer: composer,
    compositionLedger: createCompositionLedger(db),
  });

  svc.sendMessage('top', { text: 'first top' });
  svc.sendMessage('top', { text: 'second top' });
  currentRevision = 5;
  svc.sendMessage('top', { text: 'third top' });

  assert.equal(composer.calls.length, 2);
  assert.match(topAdapter.calls[0].payload.text, /revision 4/);
  assert.doesNotMatch(topAdapter.calls[1].payload.text, /## User Memory/);
  assert.match(topAdapter.calls[2].payload.text, /revision 5/);
});

test('composer path: PM and Top use distinct owner vectors', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, { subscribe: () => {}, emit: () => {} });
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeAdapter();
  const pmAdapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, topAdapter);
  const pmRun = seedPmRun(rs, registry, pmAdapter, 'proj1', topRun.id, db);
  const composer = makeComposer({
    composeImpl: (arg) => {
      const owner = arg.owners[0];
      const provenance = owner.provenance ?? owner.owner_id;
      return {
        block: `## ${owner.owner_type} Memory\n- item`,
        composition: makeComposition({
          fingerprint: `fp-${owner.owner_type}`,
          ownerType: owner.owner_type,
          ownerId: owner.owner_id,
          provenance,
          revision: 1,
        }),
      };
    },
  });
  const svc = makeService({
    rs,
    registry,
    adapter: topAdapter,
    memoryService: makeMemoryService({ revision: 1 }),
    masterMemoryService: makeMasterMemoryService({ revision: 1 }),
    memoryComposer: composer,
    compositionLedger: createCompositionLedger(db),
  });

  svc.sendMessage('top', { text: 'top request' });
  svc.sendMessage('pm:proj1', { text: 'pm request', projectId: 'proj1' });

  assert.deepEqual(composer.calls[0].owners, [{ owner_type: 'user', owner_id: 'user', provenance: 'user' }]);
  assert.deepEqual(composer.calls[1].owners, [{ owner_type: 'workspace', owner_id: 'proj1' }]);
  assert.equal(countAccepted(db, topRun.id, 'top'), 1);
  assert.equal(countAccepted(db, pmRun.id, 'pm'), 1);
});
