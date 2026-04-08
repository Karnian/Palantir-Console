// v3 Phase 1.5 — conversation identity + parent notice router.
//
// These tests exercise conversationService + managerRegistry + runService
// directly. The HTTP surface is covered by a smaller route-level test at
// the bottom (for /api/conversations resolve + 404 cases). The parent
// notice router cannot be exercised through a real Claude/Codex subprocess
// in CI, so we inject a fake adapter that captures runTurn calls.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createManagerRegistry } = require('../services/managerRegistry');
const { createConversationService } = require('../services/conversationService');
const { createApp } = require('../app');

async function mkdb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-conv-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return db;
}

function makeFakeAdapter() {
  const calls = [];
  return {
    calls,
    isSessionAlive: () => true,
    detectExitCode: () => null,
    emitSessionEndedIfNeeded: () => {},
    runTurn: (runId, payload) => {
      calls.push({ runId, payload });
      return { accepted: true };
    },
    getUsage: () => null,
    getSessionId: () => null,
    getOutput: () => null,
    disposeSession: () => {},
  };
}

function makeFakeLifecycle() {
  const delivered = [];
  return {
    delivered,
    sendAgentInput: (runId, text) => {
      delivered.push({ runId, text });
      return true;
    },
  };
}

// --- Migration 009 / runService defaults ---

test('createRun defaults conversation_id for top manager', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const run = rs.createRun({ is_manager: true, prompt: 'hello' });
  assert.equal(run.manager_layer, 'top');
  assert.equal(run.conversation_id, 'top');
});

test('createRun defaults conversation_id for worker', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  // Need a task + profile row for worker; insert raw.
  db.prepare(`INSERT INTO projects (id, name) VALUES ('p1','Proj')`).run();
  db.prepare(`INSERT INTO tasks (id, project_id, title, status) VALUES ('t1','p1','T','backlog')`).run();
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command) VALUES ('a1','A','codex','codex')`).run();
  const run = rs.createRun({ task_id: 't1', agent_profile_id: 'a1', prompt: 'run' });
  assert.equal(run.manager_layer, null);
  assert.equal(run.conversation_id, `worker:${run.id}`);
});

test('getActiveManagers({ layer: top }) returns live top runs only', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const a = rs.createRun({ is_manager: true, prompt: 'a' });
  rs.updateRunStatus(a.id, 'running', { force: true });
  const b = rs.createRun({ is_manager: true, prompt: 'b' });
  rs.updateRunStatus(b.id, 'completed', { force: true });
  const tops = rs.getActiveManagers({ layer: 'top' });
  assert.equal(tops.length, 1);
  assert.equal(tops[0].id, a.id);
});

test('getRunByConversationId resolves worker and top', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const top = rs.createRun({ is_manager: true, prompt: 'top' });
  db.prepare(`INSERT INTO projects (id, name) VALUES ('p1','Proj')`).run();
  db.prepare(`INSERT INTO tasks (id, project_id, title, status) VALUES ('t1','p1','T','backlog')`).run();
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command) VALUES ('a1','A','codex','codex')`).run();
  const worker = rs.createRun({ task_id: 't1', agent_profile_id: 'a1', prompt: 'w', parent_run_id: top.id });
  assert.equal(rs.getRunByConversationId('top').id, top.id);
  assert.equal(rs.getRunByConversationId(`worker:${worker.id}`).id, worker.id);
  assert.equal(rs.getRunByConversationId('pm:nope'), null);
});

// --- conversationService: parent notice core behavior ---

test('worker direct message queues parent notice and delivers to worker', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const fakeAdapter = makeFakeAdapter();
  const fakeLifecycle = makeFakeLifecycle();
  const conv = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => fakeAdapter },
    lifecycleService: fakeLifecycle,
  });

  // Seed a live Top manager
  const top = rs.createRun({ is_manager: true, prompt: 'top', manager_adapter: 'claude-code' });
  rs.updateRunStatus(top.id, 'running', { force: true });
  registry.setActive('top', top.id, fakeAdapter);

  // Seed a worker whose parent is that Top
  db.prepare(`INSERT INTO projects (id, name) VALUES ('p1','Proj')`).run();
  db.prepare(`INSERT INTO tasks (id, project_id, title, status) VALUES ('t1','p1','T','backlog')`).run();
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command) VALUES ('a1','A','codex','codex')`).run();
  const worker = rs.createRun({
    task_id: 't1', agent_profile_id: 'a1', prompt: 'w', parent_run_id: top.id,
  });
  rs.updateRunStatus(worker.id, 'running', { force: true });

  // Act: send direct message to worker
  const result = conv.sendMessage(`worker:${worker.id}`, { text: '방향 바꿔, X 말고 Y로' });
  assert.equal(result.status, 'sent');
  assert.equal(result.target.kind, 'worker');

  // Worker delivery happened
  assert.equal(fakeLifecycle.delivered.length, 1);
  assert.equal(fakeLifecycle.delivered[0].runId, worker.id);

  // Top has NOT been called yet — notice is only drained on next top send
  assert.equal(fakeAdapter.calls.length, 0);

  // Now the user sends to Top; the notice should prepend
  conv.sendMessage('top', { text: '다음 계획 알려줘' });
  assert.equal(fakeAdapter.calls.length, 1);
  const topPayload = fakeAdapter.calls[0].payload.text;
  assert.match(topPayload, /\[system notice\]/);
  assert.match(topPayload, new RegExp(`worker:${worker.id}`));
  assert.match(topPayload, /방향 바꿔, X 말고 Y로/);
  assert.match(topPayload, /다음 계획 알려줘/);
});

test('parent notice is NOT applied on a subsequent Top send (queue drained)', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const fakeAdapter = makeFakeAdapter();
  const fakeLifecycle = makeFakeLifecycle();
  const conv = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => fakeAdapter },
    lifecycleService: fakeLifecycle,
  });
  const top = rs.createRun({ is_manager: true });
  rs.updateRunStatus(top.id, 'running', { force: true });
  registry.setActive('top', top.id, fakeAdapter);
  db.prepare(`INSERT INTO projects (id, name) VALUES ('p1','Proj')`).run();
  db.prepare(`INSERT INTO tasks (id, project_id, title, status) VALUES ('t1','p1','T','backlog')`).run();
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command) VALUES ('a1','A','codex','codex')`).run();
  const worker = rs.createRun({ task_id: 't1', agent_profile_id: 'a1', parent_run_id: top.id });
  rs.updateRunStatus(worker.id, 'running', { force: true });

  conv.sendMessage(`worker:${worker.id}`, { text: 'hey' });
  conv.sendMessage('top', { text: 'first' });
  conv.sendMessage('top', { text: 'second' });
  assert.equal(fakeAdapter.calls.length, 2);
  assert.match(fakeAdapter.calls[0].payload.text, /\[system notice\]/);
  assert.doesNotMatch(fakeAdapter.calls[1].payload.text, /\[system notice\]/);
});

test('multiple worker messages before top turn flush together', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const fakeAdapter = makeFakeAdapter();
  const fakeLifecycle = makeFakeLifecycle();
  const conv = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => fakeAdapter },
    lifecycleService: fakeLifecycle,
  });
  const top = rs.createRun({ is_manager: true });
  rs.updateRunStatus(top.id, 'running', { force: true });
  registry.setActive('top', top.id, fakeAdapter);
  db.prepare(`INSERT INTO projects (id, name) VALUES ('p1','Proj')`).run();
  db.prepare(`INSERT INTO tasks (id, project_id, title, status) VALUES ('t1','p1','T','backlog')`).run();
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command) VALUES ('a1','A','codex','codex')`).run();
  const w1 = rs.createRun({ task_id: 't1', agent_profile_id: 'a1', parent_run_id: top.id, prompt: 'w1' });
  const w2 = rs.createRun({ task_id: 't1', agent_profile_id: 'a1', parent_run_id: top.id, prompt: 'w2' });
  rs.updateRunStatus(w1.id, 'running', { force: true });
  rs.updateRunStatus(w2.id, 'running', { force: true });

  conv.sendMessage(`worker:${w1.id}`, { text: 'AAA' });
  conv.sendMessage(`worker:${w2.id}`, { text: 'BBB' });
  conv.sendMessage('top', { text: 'check' });
  assert.equal(fakeAdapter.calls.length, 1);
  const payload = fakeAdapter.calls[0].payload.text;
  // Both worker notices were drained into the single top send
  assert.match(payload, /AAA/);
  assert.match(payload, /BBB/);
  assert.match(payload, /check/);
});

test('worker with stale parent_run_id (not active top) drops notice silently', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const fakeAdapter = makeFakeAdapter();
  const fakeLifecycle = makeFakeLifecycle();
  const conv = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => fakeAdapter },
    lifecycleService: fakeLifecycle,
    logger: () => {},
  });
  // Historical top (no longer active)
  const oldTop = rs.createRun({ is_manager: true });
  rs.updateRunStatus(oldTop.id, 'completed', { force: true });
  // New active top with a different run id
  const newTop = rs.createRun({ is_manager: true });
  rs.updateRunStatus(newTop.id, 'running', { force: true });
  registry.setActive('top', newTop.id, fakeAdapter);

  db.prepare(`INSERT INTO projects (id, name) VALUES ('p1','Proj')`).run();
  db.prepare(`INSERT INTO tasks (id, project_id, title, status) VALUES ('t1','p1','T','backlog')`).run();
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command) VALUES ('a1','A','codex','codex')`).run();
  const worker = rs.createRun({
    task_id: 't1', agent_profile_id: 'a1', parent_run_id: oldTop.id, prompt: 'stale',
  });
  rs.updateRunStatus(worker.id, 'running', { force: true });

  conv.sendMessage(`worker:${worker.id}`, { text: 'direct' });
  // Worker delivery still happened
  assert.equal(fakeLifecycle.delivered.length, 1);

  // Top send should NOT receive a notice because the worker's parent
  // is not the currently active top run.
  conv.sendMessage('top', { text: 'status?' });
  assert.equal(fakeAdapter.calls.length, 1);
  assert.doesNotMatch(fakeAdapter.calls[0].payload.text, /\[system notice\]/);
});

test('parseConversationId rejects malformed ids', () => {
  const conv = createConversationService({
    runService: { getRun: () => null, getRunByConversationId: () => null },
    managerRegistry: { probeActive: () => null, getActiveRunId: () => null, getActiveAdapter: () => null },
    managerAdapterFactory: { getAdapter: () => makeFakeAdapter() },
    lifecycleService: makeFakeLifecycle(),
  });
  assert.equal(conv.parseConversationId('')?.kind, undefined);
  assert.equal(conv.parseConversationId(''), null);
  assert.equal(conv.parseConversationId('worker:'), null);
  assert.equal(conv.parseConversationId('pm:'), null);
  assert.equal(conv.parseConversationId('bogus'), null);
  assert.deepEqual(conv.parseConversationId('top'), { kind: 'top' });
  assert.deepEqual(conv.parseConversationId('pm:alpha'), { kind: 'pm', projectId: 'alpha' });
  assert.deepEqual(conv.parseConversationId('worker:abc'), { kind: 'worker', runId: 'abc' });
});

test('sendMessage to worker without text is rejected', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const fakeAdapter = makeFakeAdapter();
  const conv = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => fakeAdapter },
    lifecycleService: makeFakeLifecycle(),
  });
  db.prepare(`INSERT INTO projects (id, name) VALUES ('p1','Proj')`).run();
  db.prepare(`INSERT INTO tasks (id, project_id, title, status) VALUES ('t1','p1','T','backlog')`).run();
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command) VALUES ('a1','A','codex','codex')`).run();
  const worker = rs.createRun({ task_id: 't1', agent_profile_id: 'a1', prompt: 'w' });
  assert.throws(
    () => conv.sendMessage(`worker:${worker.id}`, { images: [{ data: 'x', media_type: 'image/png' }] }),
    /worker conversations accept text only/
  );
});

// --- HTTP surface ---

async function createTestApp(t) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-conv-storage-'));
  const fsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-conv-fs-'));
  // Per-test SQLite — unset dbPath falls back to server/palantir.db (dev DB),
  // so explicit isolation is required. The v3 Phase 1.5 cleanup had to
  // remove dozens of fixture rows leaked from this exact oversight.
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-conv-db-'));
  const dbPath = path.join(dbDir, 'test.db');
  const app = createApp({ storageRoot, fsRoot, dbPath });
  t.after(async () => {
    if (app.shutdown) app.shutdown();
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
    await fs.rm(dbDir, { recursive: true, force: true });
  });
  return app;
}

test('GET /api/conversations/:id returns 400 for malformed id', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/api/conversations/bogus');
  assert.equal(res.status, 400);
});

test('GET /api/conversations/top returns null run when no top session', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/api/conversations/top');
  assert.equal(res.status, 200);
  assert.equal(res.body.conversation.kind, 'top');
  assert.equal(res.body.conversation.run, null);
});

test('POST /api/conversations/top/message returns 404 when no top session', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app)
    .post('/api/conversations/top/message')
    .send({ text: 'hi' });
  assert.equal(res.status, 404);
});

// --- codex review round 1 regression guards ---

test('parent notice is NOT drained if Top send is rejected by adapter', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  // Adapter that fails the first runTurn call, then accepts the second.
  let callIdx = 0;
  const flakyAdapter = {
    isSessionAlive: () => true,
    detectExitCode: () => null,
    emitSessionEndedIfNeeded: () => {},
    runTurn: (runId, payload) => {
      callIdx += 1;
      if (callIdx === 1) return { accepted: false };
      return { accepted: true, captured: payload.text };
    },
    getUsage: () => null, getSessionId: () => null, getOutput: () => null, disposeSession: () => {},
  };
  flakyAdapter.calls = [];
  const origRunTurn = flakyAdapter.runTurn;
  flakyAdapter.runTurn = (runId, payload) => {
    const result = origRunTurn(runId, payload);
    flakyAdapter.calls.push({ runId, payload });
    return result;
  };
  const fakeLifecycle = makeFakeLifecycle();
  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => flakyAdapter },
    lifecycleService: fakeLifecycle,
  });
  const top = rs.createRun({ is_manager: true });
  rs.updateRunStatus(top.id, 'running', { force: true });
  registry.setActive('top', top.id, flakyAdapter);
  db.prepare(`INSERT INTO projects (id, name) VALUES ('p1','Proj')`).run();
  db.prepare(`INSERT INTO tasks (id, project_id, title, status) VALUES ('t1','p1','T','backlog')`).run();
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command) VALUES ('a1','A','codex','codex')`).run();
  const worker = rs.createRun({ task_id: 't1', agent_profile_id: 'a1', parent_run_id: top.id });
  rs.updateRunStatus(worker.id, 'running', { force: true });

  conv.sendMessage(`worker:${worker.id}`, { text: 'AAA' });
  // First top send fails → notice should NOT be drained
  assert.throws(() => conv.sendMessage('top', { text: 'first' }), /Failed to deliver/);
  // Second top send succeeds → notice MUST be delivered
  conv.sendMessage('top', { text: 'second' });
  // Find the successful accepted call (2nd)
  const acceptedPayload = flakyAdapter.calls[1].payload.text;
  assert.match(acceptedPayload, /\[system notice\]/);
  assert.match(acceptedPayload, /AAA/);
  assert.match(acceptedPayload, /second/);
});

test('parent notice is NOT queued if worker delivery fails', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const fakeAdapter = makeFakeAdapter();
  // Lifecycle that refuses to deliver
  const rejectLifecycle = { sendAgentInput: () => false };
  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => fakeAdapter },
    lifecycleService: rejectLifecycle,
  });
  const top = rs.createRun({ is_manager: true });
  rs.updateRunStatus(top.id, 'running', { force: true });
  registry.setActive('top', top.id, fakeAdapter);
  db.prepare(`INSERT INTO projects (id, name) VALUES ('p1','Proj')`).run();
  db.prepare(`INSERT INTO tasks (id, project_id, title, status) VALUES ('t1','p1','T','backlog')`).run();
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command) VALUES ('a1','A','codex','codex')`).run();
  const worker = rs.createRun({ task_id: 't1', agent_profile_id: 'a1', parent_run_id: top.id });
  rs.updateRunStatus(worker.id, 'running', { force: true });

  assert.throws(
    () => conv.sendMessage(`worker:${worker.id}`, { text: 'nope' }),
    /failed to deliver input to worker/
  );
  // Top send — notice queue should be empty
  conv.sendMessage('top', { text: 'check' });
  assert.equal(fakeAdapter.calls.length, 1);
  assert.doesNotMatch(fakeAdapter.calls[0].payload.text, /\[system notice\]/);
  assert.doesNotMatch(fakeAdapter.calls[0].payload.text, /nope/);
});

test('POST /api/runs/:id/input preserves legacy { status: "ok" } response shape', async (t) => {
  // Codex round-2 regression: the initial alias spread {status:'sent'}
  // over the 'ok' key and would have broken existing UI. Drive the runs
  // router directly with a stub conversationService that always succeeds.
  const express = require('express');
  const { createRunsRouter } = require('../routes/runs');
  const stubConv = {
    sendMessage: () => ({ status: 'sent', target: { kind: 'worker', runId: 'x' } }),
  };
  const app = express();
  app.use(express.json());
  app.use('/api/runs', createRunsRouter({
    runService: { getRun: () => ({ id: 'x', status: 'running' }), deleteRun: () => {} },
    lifecycleService: null,
    executionEngine: null,
    streamJsonEngine: null,
    conversationService: stubConv,
  }));
  const res = await request(app).post('/api/runs/x/input').send({ text: 'hi' });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok', 'legacy top-level status must stay "ok"');
  assert.ok(res.body.delivery, 'new delivery detail should be nested');
  assert.equal(res.body.delivery.status, 'sent');
});

test('POST /api/runs/:id/input routes through conversationService (parent notice router)', async (t) => {
  // This regression test guards Principle 9: the legacy worker-input route
  // must trigger the parent-notice router, not bypass it. We cannot run a
  // real worker in CI, so we drive the app and assert the HTTP alias
  // resolves to conversationService (it will 404 because no worker exists,
  // but the error shape comes from conversationService — proving the alias
  // is wired).
  const app = await createTestApp(t);
  const res = await request(app)
    .post('/api/runs/nonexistent_run/input')
    .send({ text: 'hi' });
  // conversationService wraps runService.getRun failure into httpStatus=404
  // with a message referencing the conversation id prefix.
  assert.equal(res.status, 404);
  assert.match(res.body.error, /worker run not found/);
});

test('GET /api/manager/status returns layer-aware shape (top+pms)', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/api/manager/status');
  assert.equal(res.status, 200);
  assert.equal(res.body.active, false);
  assert.ok('top' in res.body);
  assert.ok(Array.isArray(res.body.pms));
  assert.equal(res.body.pms.length, 0);
});

// ---------------------------------------------------------------------------
// v3 Phase 2 — multi-slot PM runtime + worker→PM and PM→Top notice routing
// ---------------------------------------------------------------------------

// Helper: seed a PM run in the registry under 'pm:<projectId>'. Phase 2 does
// not spawn real PM adapters (that lives in Phase 3a); tests use a fake
// adapter identical to the Top fake.
function seedPmRun({ rs, registry, adapter, projectId, parentTopRunId }) {
  const run = rs.createRun({
    is_manager: true,
    manager_adapter: 'codex',
    manager_layer: 'pm',
    conversation_id: `pm:${projectId}`,
    parent_run_id: parentTopRunId || null,
    prompt: `pm ${projectId}`,
  });
  rs.updateRunStatus(run.id, 'running', { force: true });
  registry.setActive(`pm:${projectId}`, run.id, adapter);
  return run;
}

test('Phase 2: PM send when no active PM returns 404', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const conv = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => makeFakeAdapter() },
    lifecycleService: makeFakeLifecycle(),
  });
  assert.throws(
    () => conv.sendMessage('pm:alpha', { text: 'hi' }),
    /No active PM manager session/
  );
});

test('Phase 2: worker→PM queues notice and PM send drains it', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeFakeAdapter();
  const pmAdapter = makeFakeAdapter();
  const fakeLifecycle = makeFakeLifecycle();
  const conv = createConversationService({
    runService: rs,
    managerRegistry: registry,
    // getAdapter is layer-agnostic for the fake — the registry already
    // hands out the correct adapter instance per slot.
    managerAdapterFactory: { getAdapter: () => pmAdapter },
    lifecycleService: fakeLifecycle,
  });

  // Live Top
  const top = rs.createRun({ is_manager: true, prompt: 'top', manager_adapter: 'claude-code' });
  rs.updateRunStatus(top.id, 'running', { force: true });
  registry.setActive('top', top.id, topAdapter);

  // Live PM with parent = Top
  const pm = seedPmRun({ rs, registry, adapter: pmAdapter, projectId: 'alpha', parentTopRunId: top.id });

  // Worker whose parent is the PM (not the Top)
  db.prepare(`INSERT INTO projects (id, name) VALUES ('p1','Proj')`).run();
  db.prepare(`INSERT INTO tasks (id, project_id, title, status) VALUES ('t1','p1','T','backlog')`).run();
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command) VALUES ('a1','A','codex','codex')`).run();
  const worker = rs.createRun({ task_id: 't1', agent_profile_id: 'a1', parent_run_id: pm.id, prompt: 'w' });
  rs.updateRunStatus(worker.id, 'running', { force: true });

  // Direct message to worker → notice queued against PM run, not Top run
  conv.sendMessage(`worker:${worker.id}`, { text: '경로 변경해줘' });
  assert.equal(fakeLifecycle.delivered.length, 1);
  assert.equal(topAdapter.calls.length, 0);
  assert.equal(pmAdapter.calls.length, 0);

  // PM send drains and prepends
  conv.sendMessage('pm:alpha', { text: '요약 보내' });
  assert.equal(pmAdapter.calls.length, 1);
  const pmPayload = pmAdapter.calls[0].payload.text;
  assert.match(pmPayload, /\[system notice\]/);
  assert.match(pmPayload, new RegExp(`worker:${worker.id}`));
  assert.match(pmPayload, /경로 변경해줘/);
  assert.match(pmPayload, /요약 보내/);

  // Top has received nothing — the worker's parent is PM, not Top.
  assert.equal(topAdapter.calls.length, 0);
});

test('Phase 2: PM send emits PM→Top notice drained on next Top turn', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeFakeAdapter();
  const pmAdapter = makeFakeAdapter();
  const conv = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => pmAdapter },
    lifecycleService: makeFakeLifecycle(),
  });

  const top = rs.createRun({ is_manager: true, prompt: 'top' });
  rs.updateRunStatus(top.id, 'running', { force: true });
  registry.setActive('top', top.id, topAdapter);

  seedPmRun({ rs, registry, adapter: pmAdapter, projectId: 'alpha', parentTopRunId: top.id });

  // User talks directly to PM → this alone must mark Top stale
  conv.sendMessage('pm:alpha', { text: '새 방향으로 가자' });
  assert.equal(pmAdapter.calls.length, 1);
  assert.doesNotMatch(pmAdapter.calls[0].payload.text, /\[system notice\]/);

  // Next Top turn should see the PM→Top staleness notice prepended.
  conv.sendMessage('top', { text: '현재 계획 공유' });
  assert.equal(topAdapter.calls.length, 1);
  const topPayload = topAdapter.calls[0].payload.text;
  assert.match(topPayload, /\[system notice\]/);
  assert.match(topPayload, /pm:alpha/);
  assert.match(topPayload, /새 방향으로 가자/);
  assert.match(topPayload, /현재 계획 공유/);

  // And the queue was drained — a follow-up Top turn has no notice.
  conv.sendMessage('top', { text: '다음 단계' });
  assert.equal(topAdapter.calls.length, 2);
  assert.doesNotMatch(topAdapter.calls[1].payload.text, /\[system notice\]/);
});

test('Phase 2: PM→Top notice drops if PM parent is not the active Top', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeFakeAdapter();
  const pmAdapter = makeFakeAdapter();
  const conv = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => pmAdapter },
    lifecycleService: makeFakeLifecycle(),
    logger: () => {},
  });

  // Historical top — not registered
  const oldTop = rs.createRun({ is_manager: true });
  rs.updateRunStatus(oldTop.id, 'completed', { force: true });

  // New active top (different run id) is registered
  const newTop = rs.createRun({ is_manager: true });
  rs.updateRunStatus(newTop.id, 'running', { force: true });
  registry.setActive('top', newTop.id, topAdapter);

  // PM still carries the OLD top as its parent
  seedPmRun({ rs, registry, adapter: pmAdapter, projectId: 'alpha', parentTopRunId: oldTop.id });

  conv.sendMessage('pm:alpha', { text: '바꿔' });
  assert.equal(pmAdapter.calls.length, 1);

  // Next Top turn must not carry a notice — the PM's parent is stale.
  conv.sendMessage('top', { text: 'status?' });
  assert.equal(topAdapter.calls.length, 1);
  assert.doesNotMatch(topAdapter.calls[0].payload.text, /\[system notice\]/);
});

test('Phase 2: worker→PM drops notice if the PM parent is not the registered PM', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeFakeAdapter();
  const pmAdapter = makeFakeAdapter();
  const fakeLifecycle = makeFakeLifecycle();
  const conv = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => pmAdapter },
    lifecycleService: fakeLifecycle,
    logger: () => {},
  });

  const top = rs.createRun({ is_manager: true });
  rs.updateRunStatus(top.id, 'running', { force: true });
  registry.setActive('top', top.id, topAdapter);

  // Stale PM run (exists in DB but NOT registered as the live pm:alpha)
  const stalePm = rs.createRun({
    is_manager: true, manager_layer: 'pm', conversation_id: 'pm:alpha',
    parent_run_id: top.id, manager_adapter: 'codex',
  });
  rs.updateRunStatus(stalePm.id, 'completed', { force: true });

  db.prepare(`INSERT INTO projects (id, name) VALUES ('p1','Proj')`).run();
  db.prepare(`INSERT INTO tasks (id, project_id, title, status) VALUES ('t1','p1','T','backlog')`).run();
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command) VALUES ('a1','A','codex','codex')`).run();
  const worker = rs.createRun({ task_id: 't1', agent_profile_id: 'a1', parent_run_id: stalePm.id });
  rs.updateRunStatus(worker.id, 'running', { force: true });

  conv.sendMessage(`worker:${worker.id}`, { text: 'hi' });
  assert.equal(fakeLifecycle.delivered.length, 1);

  // Neither PM nor Top should have received a notice.
  conv.sendMessage('top', { text: 'status?' });
  assert.equal(topAdapter.calls.length, 1);
  assert.doesNotMatch(topAdapter.calls[0].payload.text, /\[system notice\]/);
});

test('Phase 2: worker→Top path unchanged (Phase 1.5 regression guard)', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeFakeAdapter();
  const fakeLifecycle = makeFakeLifecycle();
  const conv = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => topAdapter },
    lifecycleService: fakeLifecycle,
  });
  const top = rs.createRun({ is_manager: true });
  rs.updateRunStatus(top.id, 'running', { force: true });
  registry.setActive('top', top.id, topAdapter);

  db.prepare(`INSERT INTO projects (id, name) VALUES ('p1','Proj')`).run();
  db.prepare(`INSERT INTO tasks (id, project_id, title, status) VALUES ('t1','p1','T','backlog')`).run();
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command) VALUES ('a1','A','codex','codex')`).run();
  const worker = rs.createRun({ task_id: 't1', agent_profile_id: 'a1', parent_run_id: top.id });
  rs.updateRunStatus(worker.id, 'running', { force: true });

  conv.sendMessage(`worker:${worker.id}`, { text: 'direct' });
  conv.sendMessage('top', { text: 'ping' });
  assert.equal(topAdapter.calls.length, 1);
  assert.match(topAdapter.calls[0].payload.text, /\[system notice\]/);
  assert.match(topAdapter.calls[0].payload.text, /direct/);
});

test('Phase 2: PM send drain is NOT committed when adapter rejects', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeFakeAdapter();
  let callIdx = 0;
  const flakyPm = {
    calls: [],
    isSessionAlive: () => true, detectExitCode: () => null,
    emitSessionEndedIfNeeded: () => {},
    getUsage: () => null, getSessionId: () => null, getOutput: () => null, disposeSession: () => {},
    runTurn: (runId, payload) => {
      callIdx += 1;
      flakyPm.calls.push({ runId, payload });
      if (callIdx === 1) return { accepted: false };
      return { accepted: true };
    },
  };
  const conv = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => flakyPm },
    lifecycleService: makeFakeLifecycle(),
  });
  const top = rs.createRun({ is_manager: true });
  rs.updateRunStatus(top.id, 'running', { force: true });
  registry.setActive('top', top.id, topAdapter);
  const pm = seedPmRun({ rs, registry, adapter: flakyPm, projectId: 'alpha', parentTopRunId: top.id });

  // Pre-queue a notice manually on the PM run (simulating a worker→PM)
  db.prepare(`INSERT INTO projects (id, name) VALUES ('p1','Proj')`).run();
  db.prepare(`INSERT INTO tasks (id, project_id, title, status) VALUES ('t1','p1','T','backlog')`).run();
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command) VALUES ('a1','A','codex','codex')`).run();
  const worker = rs.createRun({ task_id: 't1', agent_profile_id: 'a1', parent_run_id: pm.id });
  rs.updateRunStatus(worker.id, 'running', { force: true });
  conv.sendMessage(`worker:${worker.id}`, { text: 'WNOTE' });

  // First PM send fails → queue must survive
  assert.throws(() => conv.sendMessage('pm:alpha', { text: 'first' }), /Failed to deliver/);
  // Second PM send succeeds → notice delivered
  conv.sendMessage('pm:alpha', { text: 'second' });
  // Accepted call is index 1 (first was rejected but still appended)
  const acceptedPayload = flakyPm.calls[1].payload.text;
  assert.match(acceptedPayload, /\[system notice\]/);
  assert.match(acceptedPayload, /WNOTE/);
  assert.match(acceptedPayload, /second/);
});

test('Phase 2: POST /api/manager/pm/:projectId/message returns 404 when project missing', async (t) => {
  // v3 Phase 3a delta: conversationService now delegates PM misses to
  // pmSpawnService (lazy spawn). When the project itself doesn't exist,
  // the spawn service throws with httpStatus=404 and the error message
  // changes shape accordingly. The original Phase 2 expectation (no PM
  // → 404) still holds — just the error text moved from the registry
  // path into the spawn path.
  const app = await createTestApp(t);
  const res = await request(app)
    .post('/api/manager/pm/alpha/message')
    .send({ text: 'hi' });
  assert.equal(res.status, 404);
  assert.match(res.body.error, /project not found/);
});

test('Phase 2: race-safe drain — notices queued mid-turn survive commit', async (t) => {
  // Codex R1 blocker regression: if a worker→parent notice lands between
  // peek and commit, the old "delete entire key" drain wiped it out.
  // The fix removes exactly the count that was peeked via splice().
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const fakeLifecycle = makeFakeLifecycle();

  // This adapter calls a hook during runTurn so we can simulate another
  // worker send queuing a fresh notice while the parent turn is in flight.
  let midTurnHook = null;
  const raceAdapter = {
    calls: [],
    isSessionAlive: () => true, detectExitCode: () => null,
    emitSessionEndedIfNeeded: () => {},
    getUsage: () => null, getSessionId: () => null, getOutput: () => null, disposeSession: () => {},
    runTurn: (runId, payload) => {
      raceAdapter.calls.push({ runId, payload });
      if (midTurnHook) { const h = midTurnHook; midTurnHook = null; h(); }
      return { accepted: true };
    },
  };
  const conv = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => raceAdapter },
    lifecycleService: fakeLifecycle,
  });
  const top = rs.createRun({ is_manager: true });
  rs.updateRunStatus(top.id, 'running', { force: true });
  registry.setActive('top', top.id, raceAdapter);

  db.prepare(`INSERT INTO projects (id, name) VALUES ('p1','Proj')`).run();
  db.prepare(`INSERT INTO tasks (id, project_id, title, status) VALUES ('t1','p1','T','backlog')`).run();
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command) VALUES ('a1','A','codex','codex')`).run();
  const worker = rs.createRun({ task_id: 't1', agent_profile_id: 'a1', parent_run_id: top.id });
  rs.updateRunStatus(worker.id, 'running', { force: true });

  // Pre-seed first notice
  conv.sendMessage(`worker:${worker.id}`, { text: 'FIRST' });
  // Schedule a second worker send to fire while Top's runTurn is in flight
  midTurnHook = () => { conv.sendMessage(`worker:${worker.id}`, { text: 'MID' }); };

  // Top send consumes FIRST but MID arrives mid-turn (only runTurn goes
  // through raceAdapter — worker sends go through lifecycleService).
  conv.sendMessage('top', { text: 'ping' });
  assert.equal(raceAdapter.calls.length, 1, 'top runTurn fires once');
  const topPayload = raceAdapter.calls[0].payload.text;
  assert.match(topPayload, /FIRST/);
  assert.doesNotMatch(topPayload, /MID/, 'MID arrived after peek, must NOT be in this turn');

  // Next Top turn MUST still see MID — the race-safe drain kept it queued.
  conv.sendMessage('top', { text: 'next' });
  assert.equal(raceAdapter.calls.length, 2);
  const secondTop = raceAdapter.calls[1].payload.text;
  assert.match(secondTop, /MID/, 'MID must carry over to the next Top turn');
  assert.match(secondTop, /next/);
});

test('Phase 2: PM slot cleared → lingering notices are dropped', async (t) => {
  // Codex R1 blocker regression: PM death/rotation used to strand worker
  // notices keyed by the old PM run id. The managerRegistry onSlotCleared
  // hook now drops them. This test uses the dying-probe path.
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeFakeAdapter();
  // PM adapter that reports dead on the second probeActive call — the
  // first probe (during sendMessage('pm:alpha') below) still reports alive.
  let pmAlive = true;
  const dyingPm = {
    calls: [],
    isSessionAlive: () => pmAlive,
    detectExitCode: () => 0,
    emitSessionEndedIfNeeded: () => {},
    getUsage: () => null, getSessionId: () => null, getOutput: () => null, disposeSession: () => {},
    runTurn: (runId, payload) => { dyingPm.calls.push({ runId, payload }); return { accepted: true }; },
  };
  const conv = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => dyingPm },
    lifecycleService: makeFakeLifecycle(),
    logger: () => {},
  });
  // Wire the production slot-clear hook explicitly (test harness).
  registry.onSlotCleared(({ runId }) => { conv.clearParentNotices(runId); });

  const top = rs.createRun({ is_manager: true });
  rs.updateRunStatus(top.id, 'running', { force: true });
  registry.setActive('top', top.id, topAdapter);

  const pm = seedPmRun({ rs, registry, adapter: dyingPm, projectId: 'alpha', parentTopRunId: top.id });

  // Queue a worker→PM notice against the PM
  db.prepare(`INSERT INTO projects (id, name) VALUES ('p1','Proj')`).run();
  db.prepare(`INSERT INTO tasks (id, project_id, title, status) VALUES ('t1','p1','T','backlog')`).run();
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command) VALUES ('a1','A','codex','codex')`).run();
  const worker = rs.createRun({ task_id: 't1', agent_profile_id: 'a1', parent_run_id: pm.id });
  rs.updateRunStatus(worker.id, 'running', { force: true });
  conv.sendMessage(`worker:${worker.id}`, { text: 'stranded' });

  // Simulate PM death via probeActive — registry slot clears, listener fires
  pmAlive = false;
  const probed = registry.probeActive('pm:alpha');
  assert.equal(probed, null);

  // A brand-new PM run takes over the same slot. If the queue had
  // survived, the new PM would see the old notice on its first turn.
  pmAlive = true;
  const newPm = seedPmRun({ rs, registry, adapter: dyingPm, projectId: 'alpha', parentTopRunId: top.id });
  assert.notEqual(newPm.id, pm.id);
  conv.sendMessage('pm:alpha', { text: 'fresh' });
  const firstFresh = dyingPm.calls[0].payload.text;
  assert.doesNotMatch(firstFresh, /stranded/, 'old PM notice must be dropped on slot clear');
  assert.match(firstFresh, /fresh/);
});

test('Phase 2: setActive rotation clears notices for replaced run id', async (t) => {
  // Direct slot replacement (setActive without intermediate clearActive)
  // also scrubs the old run's notice queue.
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const pmAdapter = makeFakeAdapter();
  const conv = createConversationService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => pmAdapter },
    lifecycleService: makeFakeLifecycle(),
    logger: () => {},
  });
  registry.onSlotCleared(({ runId }) => { conv.clearParentNotices(runId); });

  const top = rs.createRun({ is_manager: true });
  rs.updateRunStatus(top.id, 'running', { force: true });
  registry.setActive('top', top.id, pmAdapter);
  const oldPm = seedPmRun({ rs, registry, adapter: pmAdapter, projectId: 'alpha', parentTopRunId: top.id });

  db.prepare(`INSERT INTO projects (id, name) VALUES ('p1','Proj')`).run();
  db.prepare(`INSERT INTO tasks (id, project_id, title, status) VALUES ('t1','p1','T','backlog')`).run();
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command) VALUES ('a1','A','codex','codex')`).run();
  const worker = rs.createRun({ task_id: 't1', agent_profile_id: 'a1', parent_run_id: oldPm.id });
  rs.updateRunStatus(worker.id, 'running', { force: true });
  conv.sendMessage(`worker:${worker.id}`, { text: 'old' });

  // Rotate: new PM takes the slot directly
  const newPm = rs.createRun({
    is_manager: true, manager_layer: 'pm', conversation_id: 'pm:alpha',
    parent_run_id: top.id, manager_adapter: 'codex',
  });
  rs.updateRunStatus(newPm.id, 'running', { force: true });
  registry.setActive('pm:alpha', newPm.id, pmAdapter);

  conv.sendMessage('pm:alpha', { text: 'new' });
  assert.equal(pmAdapter.calls.length, 1);
  assert.doesNotMatch(pmAdapter.calls[0].payload.text, /old/);
  assert.match(pmAdapter.calls[0].payload.text, /new/);
});

test('Phase 2: POST /api/conversations/pm:alpha returns null run when no PM', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/api/conversations/pm:alpha');
  assert.equal(res.status, 200);
  assert.equal(res.body.conversation.kind, 'pm');
  assert.equal(res.body.conversation.projectId, 'alpha');
  assert.equal(res.body.conversation.run, null);
});
