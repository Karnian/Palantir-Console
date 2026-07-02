'use strict';

// Operator specialist entry route (POST /api/operator/specialist) — Contract A:
// profileId references a stored operator profile that supplies persona +
// capabilities; request-level persona/capabilities are rejected (400); unknown
// profileId → 404. HTTP-level via supertest; the LLM backend is faked.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');
const { createApp } = require('../app');

function fakeBackend(result = { text: 'specialist answer', toolCallCount: 0, iterations: 1 }) {
  const calls = [];
  return { calls, runSpecialistTurn: async (args) => { calls.push(args); return result; } };
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
async function enabledApp(t, backend = fakeBackend(), extra = {}) {
  return makeApp(t, { operatorSpecialistEnabled: true, specialistBackend: backend, ...extra });
}
function makeManagerRun(app, { status = 'running' } = {}) {
  const run = app.services.runService.createRun({
    is_manager: true, manager_layer: 'top', conversation_id: 'top', manager_adapter: 'codex', prompt: 'top',
  });
  if (status !== 'queued') app.services.runService.updateRunStatus(run.id, status, { force: true });
  return run;
}
function makeProfile(app, { name, persona = null, capabilities = [] }) {
  return app.services.operatorProfileService.createProfile({ name, persona, capabilities }).id;
}
const B = '/api/operator/specialist';

// ── happy path (Contract A: profileId must reference a stored profile) ──
test('POST: valid profileId + run → 200 with service result', async (t) => {
  const app = await enabledApp(t);
  const pid = makeProfile(app, { name: 'researcher', persona: 'You research.', capabilities: ['registry_metadata_search'] });
  const run = makeManagerRun(app);
  const res = await request(app).post(B).send({ profileId: pid, userText: 'analyze', originRunId: run.id });
  assert.equal(res.status, 200);
  assert.equal(res.body.text, 'specialist answer');
  assert.ok(typeof res.body.invocationId === 'string' && res.body.invocationId.length > 0);
});

// ── Contract A: profile is authoritative for persona + capabilities ──
test('POST: profile persona + capabilities flow to the backend', async (t) => {
  const backend = fakeBackend();
  const app = await enabledApp(t, backend);
  const pid = makeProfile(app, { name: 'sec', persona: 'You review security.', capabilities: ['registry_metadata_search'] });
  const run = makeManagerRun(app);
  await request(app).post(B).send({ profileId: pid, userText: 'hi', originRunId: run.id });
  const call = backend.calls[0];
  assert.match(call.systemPrompt, /You review security\./); // persona from profile
  assert.deepEqual(call.operatorContext.capabilityGrant.caps, ['registry_metadata_search']); // caps from profile
});

test('POST: request-level persona or capabilities → 400 (Contract A rejects ambiguity)', async (t) => {
  const app = await enabledApp(t);
  const pid = makeProfile(app, { name: 'p' });
  const run = makeManagerRun(app);
  const base = { profileId: pid, userText: 'hi', originRunId: run.id };
  assert.equal((await request(app).post(B).send({ ...base, persona: 'inline' })).status, 400);
  assert.equal((await request(app).post(B).send({ ...base, capabilities: ['registry_metadata_search'] })).status, 400);
  // explicit null must also be rejected (JSON sends null, not undefined — Codex R2)
  assert.equal((await request(app).post(B).send({ ...base, persona: null })).status, 400);
  assert.equal((await request(app).post(B).send({ ...base, capabilities: null })).status, 400);
});

test('POST: unknown profileId (valid run) → 404', async (t) => {
  const app = await enabledApp(t);
  const run = makeManagerRun(app);
  const res = await request(app).post(B).send({ profileId: 'op_nope', userText: 'hi', originRunId: run.id });
  assert.equal(res.status, 404);
});

// ── request validation (fail before profile/origin resolution) ──
test('POST: missing/blank required fields → 400', async (t) => {
  const app = await enabledApp(t);
  const pid = makeProfile(app, { name: 'p' });
  const run = makeManagerRun(app);
  const base = { profileId: pid, userText: 'hi', originRunId: run.id };
  for (const patch of [{ userText: '' }, { userText: '   ' }, { profileId: '' }, { originRunId: '' }]) {
    assert.equal((await request(app).post(B).send({ ...base, ...patch })).status, 400, JSON.stringify(patch));
  }
});

test('POST: oversized userText → 400', async (t) => {
  const app = await enabledApp(t);
  const pid = makeProfile(app, { name: 'p' });
  const run = makeManagerRun(app);
  const res = await request(app).post(B).send({ profileId: pid, userText: 'x'.repeat(8001), originRunId: run.id });
  assert.equal(res.status, 400);
});

// ── origin-run gate ──
test('POST: non-existent originRunId → 404', async (t) => {
  const app = await enabledApp(t);
  const pid = makeProfile(app, { name: 'p' });
  assert.equal((await request(app).post(B).send({ profileId: pid, userText: 'hi', originRunId: 'does-not-exist' })).status, 404);
});

test('POST: worker (non-manager) origin run → 400', async (t) => {
  const app = await enabledApp(t);
  const pid = makeProfile(app, { name: 'p' });
  app.services._rawDb.prepare("INSERT INTO runs (id, status, is_manager, conversation_id) VALUES ('worker-x', 'running', 0, 'worker:worker-x')").run();
  const res = await request(app).post(B).send({ profileId: pid, userText: 'hi', originRunId: 'worker-x' });
  assert.equal(res.status, 400);
});

test('POST: non-active manager run → 400', async (t) => {
  const app = await enabledApp(t);
  const pid = makeProfile(app, { name: 'p' });
  const queued = makeManagerRun(app, { status: 'queued' });
  assert.equal((await request(app).post(B).send({ profileId: pid, userText: 'hi', originRunId: queued.id })).status, 400);
});

test('POST: originConversationId conflict → 400', async (t) => {
  const app = await enabledApp(t);
  const pid = makeProfile(app, { name: 'p' });
  const run = makeManagerRun(app);
  const res = await request(app).post(B).send({ profileId: pid, userText: 'hi', originRunId: run.id, originConversationId: 'operator:other' });
  assert.equal(res.status, 400);
});

// ── flag gate + auth ──
test('POST: feature flag OFF → route not mounted (404)', async (t) => {
  const app = await makeApp(t, { operatorSpecialistEnabled: false });
  assert.equal(app.services.specialistService, null);
  assert.equal((await request(app).post(B).send({ profileId: 'x', userText: 'hi', originRunId: 'y' })).status, 404);
});

test('POST: route is behind auth (token required when configured)', async (t) => {
  const app = await enabledApp(t, fakeBackend(), { authToken: 'secret' });
  const pid = makeProfile(app, { name: 'p' });
  const run = makeManagerRun(app);
  const body = { profileId: pid, userText: 'hi', originRunId: run.id };
  const noTok = await request(app).post(B).send(body);
  assert.ok([401, 403].includes(noTok.status), `expected 401/403, got ${noTok.status}`);
  const withTok = await request(app).post(B).set('Authorization', 'Bearer secret').send(body);
  assert.equal(withTok.status, 200);
});

// ── trace events on the origin run ──
test('POST: emits specialist:invoked + specialist:result on the origin run', async (t) => {
  const app = await enabledApp(t);
  const pid = makeProfile(app, { name: 'p' });
  const run = makeManagerRun(app);
  await request(app).post(B).send({ profileId: pid, userText: 'hi', originRunId: run.id });
  const events = app.services._rawDb.prepare('SELECT event_type FROM run_events WHERE run_id = ?').all(run.id).map((r) => r.event_type);
  assert.ok(events.includes('specialist:invoked') && events.includes('specialist:result'), events.join(','));
});

// ── MD-3: timeout contract (specialist:timeout → 504) ──
test('POST: backend deadline (specialist:timeout) → 504, not 500', async (t) => {
  const timeoutBackend = { runSpecialistTurn: async () => { const e = new Error('deadline'); e.code = 'specialist:timeout'; throw e; } };
  const app = await enabledApp(t, timeoutBackend);
  const pid = makeProfile(app, { name: 'p' });
  const run = makeManagerRun(app);
  const res = await request(app).post(B).send({ profileId: pid, userText: 'hi', originRunId: run.id });
  assert.equal(res.status, 504);
  assert.equal(res.body.error, 'specialist_timeout');
});

test('POST: non-timeout backend error → 500 (distinct from 504)', async (t) => {
  const errBackend = { runSpecialistTurn: async () => { throw new Error('boom'); } };
  const app = await enabledApp(t, errBackend);
  const pid = makeProfile(app, { name: 'p' });
  const run = makeManagerRun(app);
  const res = await request(app).post(B).send({ profileId: pid, userText: 'hi', originRunId: run.id });
  assert.equal(res.status, 500);
});

// ── MD-3: self-reference is NOT enforced (accepted trace-integrity debt, single-tenant) ──
// Locks the current behavior so a future multi-tenant per-run-token change is conscious.
// Harm is trace-attribution only (events land on the named run) — no content leak.
test('POST: any active manager run is accepted as originRunId (self-ref NOT enforced — accepted debt)', async (t) => {
  const app = await enabledApp(t);
  const pid = makeProfile(app, { name: 'p' });
  makeManagerRun(app);                 // run A (a caller could be this one)
  const runB = makeManagerRun(app);    // a DIFFERENT active manager run
  // Naming run B is accepted today (200); the specialist trace lands on run B.
  const res = await request(app).post(B).send({ profileId: pid, userText: 'hi', originRunId: runB.id });
  assert.equal(res.status, 200);
  const evtsB = app.services._rawDb.prepare('SELECT event_type FROM run_events WHERE run_id = ?').all(runB.id).map((r) => r.event_type);
  assert.ok(evtsB.includes('specialist:invoked'), 'trace attaches to the named run (documents the debt)');
});
