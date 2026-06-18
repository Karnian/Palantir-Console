// L2 Master Memory P1c Slice 4 — close the cross-project loop end-to-end.
// scan -> XPROJECT candidate -> cookie promote -> user-scope active -> Top injection.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createConversationService } = require('../services/conversationService');
const { createApp } = require('../app');
const { invokeApp } = require('./helpers/invokeApp');

const COOKIE = { Cookie: 'palantir_token=secret-token' };

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function makeFakeCodexAdapter() {
  const sessions = new Map();
  const runTurnCalls = [];
  return {
    type: 'codex',
    capabilities: { persistentProcess: false, supportsResume: true },
    startSession(runId, opts) {
      sessions.set(runId, {
        systemPrompt: opts.systemPrompt,
        threadId: opts.resumeThreadId || null,
        ended: false,
      });
      return { sessionRef: {} };
    },
    runTurn(runId, payload) {
      const session = sessions.get(runId);
      if (!session || session.ended) return { accepted: false };
      runTurnCalls.push({ runId, payload });
      if (!session.threadId) session.threadId = `thread_${runId}`;
      return { accepted: true };
    },
    isSessionAlive(runId) {
      const session = sessions.get(runId);
      return !!session && !session.ended;
    },
    detectExitCode() { return null; },
    emitSessionEndedIfNeeded() {},
    getUsage() { return null; },
    getSessionId(runId) { return sessions.get(runId)?.threadId || null; },
    getOutput() { return null; },
    disposeSession(runId) {
      const session = sessions.get(runId);
      if (session) session.ended = true;
    },
    buildGuardrailsSection() { return ''; },
    _sessions: sessions,
    _runTurnCalls: runTurnCalls,
  };
}

function wireFactory(adapter) {
  return { getAdapter: () => adapter };
}

function seedTop({ rs, registry, adapter }) {
  const run = rs.createRun({ is_manager: true, manager_adapter: 'claude-code', prompt: 'top' });
  rs.updateRunStatus(run.id, 'running', { force: true });
  adapter.startSession(run.id, { systemPrompt: 'top', cwd: process.cwd() });
  registry.setActive('top', run.id, adapter);
  return run;
}

function wireStack(app) {
  const topAdapter = makeFakeCodexAdapter();
  const conv = createConversationService({
    runService: app.services.runService,
    managerRegistry: app.managerRegistry,
    managerAdapterFactory: wireFactory(topAdapter),
    lifecycleService: { sendAgentInput: () => true },
    memoryService: app.services.memoryService,
    masterMemoryService: app.services.masterMemoryService,
  });
  return {
    rs: app.services.runService,
    registry: app.managerRegistry,
    memoryService: app.services.memoryService,
    masterMemoryService: app.services.masterMemoryService,
    topAdapter,
    conv,
  };
}

async function createTestApp(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-mm-e2e-'));
  const app = createApp({
    storageRoot: tmp,
    fsRoot: tmp,
    dbPath: path.join(tmp, 'test.db'),
    authResolverOpts: { hasKeychain: () => false },
    authToken: 'secret-token',
    masterMemoryXprojectScanEnabled: false,
  });
  t.after(async () => {
    try { await app.shutdown(); } catch { /* */ }
    await fs.rm(tmp, { recursive: true, force: true });
  });
  return app;
}

test('E2E: cross-project candidate promotes to user memory and injects into Top only after promotion', async (t) => {
  const app = await createTestApp(t);
  const { projectService, memoryService, masterMemoryService } = app.services;
  const content = 'Keep migration files additive and monotonic.';
  const contentHash = sha256(content);
  const query = 'Should we keep sqlite migration files additive and monotonic?';

  const alpha = projectService.createProject({ name: 'alpha' });
  const beta = projectService.createProject({ name: 'beta' });
  assert.notEqual(alpha.id, beta.id);

  memoryService.createMemoryItem({ projectId: alpha.id, kind: 'heuristic', content, origin: 'human' });
  memoryService.createMemoryItem({ projectId: beta.id, kind: 'heuristic', content, origin: 'human' });

  const summary = masterMemoryService.scanCrossProjectCandidates();
  assert.deepEqual(summary, { created: 1, skipped: 0, scanned: 1 });

  const candidates = masterMemoryService.listCandidates('cross_project');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].scope, 'cross_project');
  assert.equal(candidates[0].rule, 'XPROJECT');
  assert.equal(candidates[0].dedup_key, contentHash);

  const stack = wireStack(app);
  seedTop({ rs: stack.rs, registry: stack.registry, adapter: stack.topAdapter });

  stack.conv.sendMessage('top', { text: query });
  const beforePromotion = stack.topAdapter._runTurnCalls[0].payload.text;
  assert.doesNotMatch(beforePromotion, /## User Memory/);
  assert.doesNotMatch(beforePromotion, new RegExp(content.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(beforePromotion, new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const promoted = await invokeApp(app, {
    method: 'POST',
    path: `/api/master-memory/candidates/${candidates[0].id}/promote`,
    headers: COOKIE,
  });
  assert.equal(promoted.status, 200);
  assert.equal(promoted.body.memory.scope, 'user');
  assert.equal(promoted.body.memory.status, 'active');
  assert.equal(promoted.body.memory.origin, 'deterministic');
  assert.equal(promoted.body.memory.kind, 'pattern');
  assert.equal(promoted.body.memory.content, content);

  const activeUserRows = masterMemoryService.listForScope('user');
  assert.equal(activeUserRows.length, 1);
  assert.equal(activeUserRows[0].content, content);
  assert.equal(activeUserRows[0].origin, 'deterministic');
  assert.equal(activeUserRows[0].kind, 'pattern');

  stack.conv.sendMessage('top', { text: query });
  const afterPromotion = stack.topAdapter._runTurnCalls[1].payload.text;
  assert.match(afterPromotion, /## User Memory/);
  assert.match(afterPromotion, new RegExp(content.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(afterPromotion.indexOf('## User Memory') < afterPromotion.indexOf(query));
});
