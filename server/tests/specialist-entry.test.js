'use strict';

// Operator P-B2c-3 — specialist entry route (POST /api/operator/specialist).
// HTTP-level via supertest; the LLM backend is faked (zero network/LLM). Proves
// request validation, origin-run gating (exists + manager + active), flag-gated
// mount, and the happy path returning the service result.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');
const { createApp } = require('../app');

function fakeBackend(result = { text: 'specialist answer', toolCallCount: 0, iterations: 1 }) {
  return { runSpecialistTurn: async () => result };
}

async function makeApp(t, options = {}) {
  const mk = (p) => fs.mkdtemp(path.join(os.tmpdir(), p));
  const storageRoot = await mk('pal-s-'); const fsRoot = await mk('pal-f-'); const dbDir = await mk('pal-d-');
  const app = createApp({ storageRoot, fsRoot, opencodeBin: 'opencode', dbPath: path.join(dbDir, 'test.db'), authToken: null, ...options });
  t.after(async () => {
    if (app.shutdown) app.shutdown();
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
    await fs.rm(dbDir, { recursive: true, force: true });
  });
  return app;
}

// A live (running) manager run to serve as the trace anchor.
function makeManagerRun(app, { status = 'running' } = {}) {
  const run = app.services.runService.createRun({
    is_manager: true, manager_layer: 'top', conversation_id: 'top', manager_adapter: 'codex', prompt: 'top',
  });
  if (status !== 'queued') app.services.runService.updateRunStatus(run.id, status, { force: true });
  return run;
}

async function enabledApp(t, backend = fakeBackend()) {
  return makeApp(t, { operatorSpecialistEnabled: true, specialistBackend: backend });
}

// ── happy path ──
test('POST /api/operator/specialist: valid call → 200 with service result', async (t) => {
  const app = await enabledApp(t);
  const run = makeManagerRun(app);
  const res = await request(app)
    .post('/api/operator/specialist')
    .send({ profileId: 'researcher', userText: 'find profiles matching hermes', originRunId: run.id });
  assert.equal(res.status, 200);
  assert.equal(res.body.text, 'specialist answer');
  assert.ok(typeof res.body.invocationId === 'string' && res.body.invocationId.length > 0);
  assert.equal(res.body.iterations, 1);
});

// ── request validation ──
test('POST: missing/blank required fields → 400', async (t) => {
  const app = await enabledApp(t);
  const run = makeManagerRun(app);
  const base = { profileId: 'p', userText: 'hi', originRunId: run.id };
  for (const patch of [{ userText: '' }, { userText: '   ' }, { profileId: '' }, { originRunId: '' }]) {
    const res = await request(app).post('/api/operator/specialist').send({ ...base, ...patch });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(patch)}`);
  }
});

test('POST: oversized userText / persona → 400', async (t) => {
  const app = await enabledApp(t);
  const run = makeManagerRun(app);
  const big = 'x'.repeat(8001);
  let res = await request(app).post('/api/operator/specialist').send({ profileId: 'p', userText: big, originRunId: run.id });
  assert.equal(res.status, 400);
  res = await request(app).post('/api/operator/specialist').send({ profileId: 'p', userText: 'hi', persona: 'y'.repeat(2001), originRunId: run.id });
  assert.equal(res.status, 400);
});

test('POST: bad capabilities (non-array / unknown) → 400', async (t) => {
  const app = await enabledApp(t);
  const run = makeManagerRun(app);
  let res = await request(app).post('/api/operator/specialist').send({ profileId: 'p', userText: 'hi', originRunId: run.id, capabilities: 'shell' });
  assert.equal(res.status, 400);
  res = await request(app).post('/api/operator/specialist').send({ profileId: 'p', userText: 'hi', originRunId: run.id, capabilities: ['bogus_cap'] });
  assert.equal(res.status, 400);
  assert.match(res.body.error || res.body.message || '', /unknown capability/i);
});

test('POST: a known capability is accepted', async (t) => {
  const app = await enabledApp(t);
  const run = makeManagerRun(app);
  const res = await request(app)
    .post('/api/operator/specialist')
    .send({ profileId: 'p', userText: 'hi', originRunId: run.id, capabilities: ['registry_metadata_search'] });
  assert.equal(res.status, 200);
});

// ── origin-run gate ──
test('POST: non-existent originRunId → 404', async (t) => {
  const app = await enabledApp(t);
  const res = await request(app).post('/api/operator/specialist').send({ profileId: 'p', userText: 'hi', originRunId: 'does-not-exist' });
  assert.equal(res.status, 404);
});

test('POST: worker (non-manager) origin run → 400', async (t) => {
  const app = await enabledApp(t);
  app.services._rawDb.prepare("INSERT INTO runs (id, status, is_manager, conversation_id) VALUES (?, 'running', 0, ?)")
    .run('worker-x', 'worker:worker-x');
  const res = await request(app).post('/api/operator/specialist').send({ profileId: 'p', userText: 'hi', originRunId: 'worker-x' });
  assert.equal(res.status, 400);
  assert.match(res.body.error || res.body.message || '', /manager run/i);
});

test('POST: non-active (queued / completed) manager run → 400', async (t) => {
  const app = await enabledApp(t);
  const queued = makeManagerRun(app, { status: 'queued' });
  let res = await request(app).post('/api/operator/specialist').send({ profileId: 'p', userText: 'hi', originRunId: queued.id });
  assert.equal(res.status, 400);
  const done = makeManagerRun(app);
  app.services.runService.updateRunStatus(done.id, 'completed', { force: true });
  res = await request(app).post('/api/operator/specialist').send({ profileId: 'p', userText: 'hi', originRunId: done.id });
  assert.equal(res.status, 400);
  assert.match(res.body.error || res.body.message || '', /active run/i);
});

// ── flag gate ──
test('POST: feature flag OFF → route is not mounted (404)', async (t) => {
  const app = await makeApp(t, { operatorSpecialistEnabled: false });
  assert.equal(app.services.specialistService, null);
  const res = await request(app).post('/api/operator/specialist').send({ profileId: 'p', userText: 'hi', originRunId: 'x' });
  assert.equal(res.status, 404);
});

// ── originConversationId conflict (Codex R2 SERIOUS: clean 400, not 500) ──
test('POST: originConversationId conflicting with the run → 400 (not 500)', async (t) => {
  const app = await enabledApp(t);
  const run = makeManagerRun(app); // conversation_id 'top'
  const res = await request(app)
    .post('/api/operator/specialist')
    .send({ profileId: 'p', userText: 'hi', originRunId: run.id, originConversationId: 'pm:other' });
  assert.equal(res.status, 400);
  assert.match(res.body.error || res.body.message || '', /originConversationId/i);
});

// ── route sits behind the global auth guard ──
test('POST: route is behind auth (token required when configured)', async (t) => {
  const app = await makeApp(t, { operatorSpecialistEnabled: true, specialistBackend: fakeBackend(), authToken: 'secret' });
  const run = makeManagerRun(app);
  const body = { profileId: 'p', userText: 'hi', originRunId: run.id };
  const noTok = await request(app).post('/api/operator/specialist').send(body);
  assert.ok([401, 403].includes(noTok.status), `expected 401/403, got ${noTok.status}`);
  const withTok = await request(app).post('/api/operator/specialist').set('Authorization', 'Bearer secret').send(body);
  assert.equal(withTok.status, 200);
});

// ── trace events land on the origin run ──
test('POST: emits specialist:invoked + specialist:result on the origin run', async (t) => {
  const app = await enabledApp(t);
  const run = makeManagerRun(app);
  await request(app).post('/api/operator/specialist').send({ profileId: 'p', userText: 'hi', originRunId: run.id });
  const events = app.services._rawDb.prepare('SELECT event_type FROM run_events WHERE run_id = ?').all(run.id).map((r) => r.event_type);
  assert.ok(events.includes('specialist:invoked'), `expected specialist:invoked, got ${events.join(',')}`);
  assert.ok(events.includes('specialist:result'));
});
