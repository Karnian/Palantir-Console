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
const { createEventBus } = require('../services/eventBus');

async function mkdb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-gate-parity-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    try { close(); } catch { /* ignore */ }
    await fs.rm(dir, { recursive: true, force: true });
  });
  return db;
}

function makeAdapter() {
  return {
    calls: [],
    isSessionAlive: () => true,
    detectExitCode: () => null,
    emitSessionEndedIfNeeded: () => {},
    runTurn(runId, payload) {
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
  return { getAdapter: () => adapter, createAdapter: () => adapter };
}

function makeLifecycle() {
  return { sendAgentInput: () => false };
}

function seedProject(db, projectId) {
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

test('gate parity: PM COMPOSER-on path emits memory:gate_parity with agree result', async (t) => {
  const db = await mkdb(t);
  const eventBus = createEventBus();
  const gateEvents = [];
  eventBus.subscribe((event) => {
    if (event.channel === 'memory:gate_parity') gateEvents.push(event.data);
  });

  const rs = createRunService(db, eventBus);
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeAdapter();
  const topRun = seedTopRun(rs, registry, topAdapter);
  const pmAdapter = makeAdapter();
  const projectId = 'proj-gate-parity';
  const pmRun = seedPmRun(rs, registry, pmAdapter, projectId, topRun.id, db);

  const memoryService = {
    getRevision: () => 5,
    shouldInject: () => ({ inject: true, revision: 5 }),
    retrieveForProject: () => [],
    buildInjectionBlock: () => null,
    recordInjection: () => {},
  };
  const compositionLedger = {
    shouldCompose: () => ({ compose: true, reason: 'test' }),
    commitAccepted: () => {
      throw new Error('commitAccepted should not be called for a null block');
    },
  };
  const memoryComposer = {
    compose: () => ({
      block: null,
      composition: {
        fingerprint: 'fp-gate-parity',
        owner_states: [{ owner_type: 'workspace', owner_id: projectId, revision: 5, provenance: projectId }],
        item_edges: [],
        composer_version: '0.1.0',
        policy_version: '0.1.0',
      },
    }),
  };

  const svc = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: makeAdapterFactory(pmAdapter),
    lifecycleService: makeLifecycle(),
    memoryService,
    memoryComposer,
    compositionLedger,
    memoryComposerEnabled: true,
    eventBus,
  });

  const result = svc.sendMessage(`pm:${projectId}`, { text: 'hello', projectId });
  assert.equal(result.status, 'sent');

  assert.equal(gateEvents.length, 1);
  assert.deepEqual(gateEvents[0], {
    runId: pmRun.id,
    conversationId: `pm:${projectId}`,
    slotKind: 'pm',
    provenanceKey: projectId,
    newCompose: true,
    oldInject: true,
    agree: true,
  });
});
