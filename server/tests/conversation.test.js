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
  const app = createApp({ storageRoot, fsRoot });
  t.after(async () => {
    if (app.shutdown) app.shutdown();
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
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
