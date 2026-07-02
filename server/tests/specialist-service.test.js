'use strict';

// Operator P-B2c-2 — specialist spawn service (orchestration; zero-LLM/zero-network).
// Fake backend/composer/trace. Proves: origin-run validation first, ephemeral
// discipline (narrow trace), fixed safety preamble, User-only Composer injection
// as user-payload, lengths-only trace events, error path, flag-gated DI.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const {
  createSpecialistService,
  buildSpecialistSystemPrompt,
  SPECIALIST_SYSTEM_PREAMBLE,
} = require('../services/specialistService');
const { CAPABILITIES } = require('../utils/capability');
const { createApp } = require('../app');

// ── fakes ──
function fakeTrace({ runs } = {}) {
  const events = [];
  const known = runs || { 'run-top': { id: 'run-top', conversation_id: 'top' } };
  return {
    events,
    getRun: (id) => {
      if (!known[id]) { const e = new Error(`run not found: ${id}`); e.name = 'NotFoundError'; throw e; }
      return known[id];
    },
    addRunEvent: (runId, type, payload) => { events.push({ runId, type, payload: JSON.parse(payload) }); },
  };
}
function fakeBackend(result = { text: 'answer', toolCallCount: 0, iterations: 1 }) {
  const calls = [];
  return { calls, runSpecialistTurn: async (args) => { calls.push(args); if (result instanceof Error) throw result; return result; } };
}
function fakeComposer(out = { block: 'USER MEMORY BLOCK', composition: { fingerprint: 'fp1' } }) {
  const calls = [];
  return { calls, compose: (args) => { calls.push(args); if (typeof out === 'function') return out(args); return out; } };
}

const BASE = { profileId: 'researcher', userText: 'analyze this', originRunId: 'run-top' };

// ── constructor ──
test('createSpecialistService: requires backend + trace', () => {
  assert.throws(() => createSpecialistService({}), /specialistBackend/);
  assert.throws(() => createSpecialistService({ specialistBackend: fakeBackend() }), /trace/);
  assert.doesNotThrow(() => createSpecialistService({ specialistBackend: fakeBackend(), trace: fakeTrace() }));
});

// ── buildSpecialistSystemPrompt ──
test('buildSpecialistSystemPrompt: fixed preamble always present; persona appended', () => {
  const sp = buildSpecialistSystemPrompt({ persona: 'You are a security reviewer.' });
  assert.ok(sp.startsWith(SPECIALIST_SYSTEM_PREAMBLE));
  assert.match(sp, /UNTRUSTED DATA/);
  assert.match(sp, /## Persona\nYou are a security reviewer\./);
  // no persona → preamble only
  assert.equal(buildSpecialistSystemPrompt({}), SPECIALIST_SYSTEM_PREAMBLE);
});

// ── validation order: origin run checked first ──
test('invokeSpecialist: missing originRunId / userText throws before backend', async () => {
  const backend = fakeBackend();
  const svc = createSpecialistService({ specialistBackend: backend, trace: fakeTrace() });
  await assert.rejects(() => svc.invokeSpecialist({ ...BASE, originRunId: '' }), /originRunId is required/);
  await assert.rejects(() => svc.invokeSpecialist({ ...BASE, userText: '   ' }), /userText is required/);
  assert.equal(backend.calls.length, 0);
});

test('invokeSpecialist: unknown origin run propagates (validated before backend)', async () => {
  const backend = fakeBackend();
  const svc = createSpecialistService({ specialistBackend: backend, trace: fakeTrace() });
  await assert.rejects(() => svc.invokeSpecialist({ ...BASE, originRunId: 'nope' }), /run not found/);
  assert.equal(backend.calls.length, 0);
});

test('invokeSpecialist: originConversationId conflict fails closed; omitted → derived from run', async () => {
  const trace = fakeTrace();
  const backend = fakeBackend();
  const svc = createSpecialistService({ specialistBackend: backend, trace });
  await assert.rejects(() => svc.invokeSpecialist({ ...BASE, originConversationId: 'operator:other' }), /conflicts with origin run/);
  // omitted → derived 'top' surfaces in the invoked event
  await svc.invokeSpecialist({ ...BASE });
  const invoked = trace.events.find((e) => e.type === 'specialist:invoked');
  assert.equal(invoked.payload.originConversationId, 'top');
});

// ── context / capabilities ──
test('invokeSpecialist: capabilities flow to context; unknown cap fails closed', async () => {
  const svc = createSpecialistService({ specialistBackend: fakeBackend(), trace: fakeTrace() });
  await assert.rejects(() => svc.invokeSpecialist({ ...BASE, capabilities: ['bogus'] }), /unknown capability/);
  await assert.rejects(() => svc.invokeSpecialist({ ...BASE, profileId: '' }), /profileId must be a non-empty string/);
});

// ── system prompt + persona reach the backend ──
test('invokeSpecialist: backend receives a specialist context + preamble systemPrompt', async () => {
  const backend = fakeBackend();
  const svc = createSpecialistService({ specialistBackend: backend, trace: fakeTrace() });
  await svc.invokeSpecialist({ ...BASE, persona: 'sec persona' });
  const call = backend.calls[0];
  assert.equal(call.operatorContext.kind, 'specialist');
  assert.equal(call.operatorContext.workspaceBinding, 'none');
  assert.ok(call.systemPrompt.startsWith(SPECIALIST_SYSTEM_PREAMBLE));
  assert.match(call.systemPrompt, /## Persona\nsec persona/);
});

// ── Composer User-slot injection (user-payload) ──
test('invokeSpecialist: User + Profile compose (R4c stateful), block prepended as user-payload', async () => {
  const composer = fakeComposer();
  const backend = fakeBackend();
  const svc = createSpecialistService({ specialistBackend: backend, memoryComposer: composer, trace: fakeTrace() });
  await svc.invokeSpecialist({ ...BASE });
  // R4c: User owner + the profile's own memory owner (owner_id=profileId), both budget 1500
  assert.deepEqual(composer.calls[0].owners, [
    { owner_type: 'user', owner_id: 'user', provenance: 'user', budget: 1500 },
    { owner_type: 'profile', owner_id: 'researcher', provenance: 'profile', budget: 1500 },
  ]);
  assert.equal(composer.calls[0].taskContext, 'analyze this');
  // block prepended to userText with the canonical delimiter; systemPrompt untouched (no bake)
  assert.equal(backend.calls[0].userText, 'USER MEMORY BLOCK\n\n---\n\nanalyze this');
  assert.ok(!backend.calls[0].systemPrompt.includes('USER MEMORY BLOCK'));
});

test('invokeSpecialist: no composer / null block / composer throw → graceful skip (raw userText)', async () => {
  // no composer
  let backend = fakeBackend();
  let svc = createSpecialistService({ specialistBackend: backend, trace: fakeTrace() });
  await svc.invokeSpecialist({ ...BASE });
  assert.equal(backend.calls[0].userText, 'analyze this');
  // null block
  backend = fakeBackend();
  svc = createSpecialistService({ specialistBackend: backend, memoryComposer: fakeComposer({ block: null, composition: null }), trace: fakeTrace() });
  await svc.invokeSpecialist({ ...BASE });
  assert.equal(backend.calls[0].userText, 'analyze this');
  // composer throws
  backend = fakeBackend();
  svc = createSpecialistService({ specialistBackend: backend, memoryComposer: { compose: () => { throw new Error('boom'); } }, trace: fakeTrace() });
  await svc.invokeSpecialist({ ...BASE });
  assert.equal(backend.calls[0].userText, 'analyze this');
});

// ── trace events: lengths only, no raw content ──
test('invokeSpecialist: invoked/result events carry lengths + ids only (no raw content)', async () => {
  const trace = fakeTrace();
  const composer = fakeComposer();
  const svc = createSpecialistService({ specialistBackend: fakeBackend({ text: 'the answer', toolCallCount: 1, iterations: 2 }), memoryComposer: composer, trace });
  const out = await svc.invokeSpecialist({ ...BASE, persona: 'p' });
  const invoked = trace.events.find((e) => e.type === 'specialist:invoked').payload;
  const result = trace.events.find((e) => e.type === 'specialist:result').payload;
  assert.equal(invoked.invocationId, out.invocationId);
  assert.deepEqual(invoked.capabilities, ['registry_metadata_search']);
  assert.equal(invoked.memoryInjected, true);
  assert.equal(invoked.memoryBlockLength, 'USER MEMORY BLOCK'.length);
  assert.equal(invoked.memoryFingerprint, 'fp1');
  assert.equal(result.textLength, 'the answer'.length);
  assert.equal(result.toolCallCount, 1);
  assert.equal(result.iterations, 2);
  assert.equal(typeof result.durationMs, 'number');
  // no raw payloads leaked
  const all = JSON.stringify(trace.events);
  assert.ok(!all.includes('the answer') && !all.includes('USER MEMORY BLOCK') && !all.includes('analyze this'));
});

// ── error path ──
test('invokeSpecialist: backend error emits specialist:error + rethrows', async () => {
  const trace = fakeTrace();
  const err = Object.assign(new Error('boom detail'), { code: 'specialist:max_iterations' });
  const svc = createSpecialistService({ specialistBackend: fakeBackend(err), trace });
  await assert.rejects(() => svc.invokeSpecialist({ ...BASE }), /boom detail/);
  const ev = trace.events.find((e) => e.type === 'specialist:error').payload;
  assert.equal(ev.code, 'specialist:max_iterations');
  assert.equal(ev.message, 'boom detail');
  assert.equal(typeof ev.durationMs, 'number');
  assert.ok(!trace.events.some((e) => e.type === 'specialist:result'));
});

// ── stop ──
test('invokeSpecialist: stop() rejects further invocations', async () => {
  const svc = createSpecialistService({ specialistBackend: fakeBackend(), trace: fakeTrace() });
  svc.stop();
  await assert.rejects(() => svc.invokeSpecialist({ ...BASE }), /stopped/);
});

test('invokeSpecialist: returns { invocationId, text, toolCallCount, iterations }', async () => {
  const svc = createSpecialistService({ specialistBackend: fakeBackend({ text: 'R', toolCallCount: 0, iterations: 1 }), trace: fakeTrace() });
  const out = await svc.invokeSpecialist({ ...BASE });
  assert.equal(out.text, 'R');
  assert.ok(typeof out.invocationId === 'string' && out.invocationId.length > 0);
  assert.equal(out.iterations, 1);
});

// ── app.js DI: flag-gated, unrouted ──
async function makeApp(t, options) {
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

test('app DI: flag OFF → app.services.specialistService is null (behavior-identical)', async (t) => {
  const app = await makeApp(t, { operatorSpecialistEnabled: false });
  assert.equal(app.services.specialistService, null);
});

test('app DI: flag ON + injected backend → specialistService constructed (unrouted)', async (t) => {
  const backend = fakeBackend();
  const app = await makeApp(t, { operatorSpecialistEnabled: true, specialistBackend: backend });
  assert.ok(app.services.specialistService);
  assert.equal(typeof app.services.specialistService.invokeSpecialist, 'function');
  assert.equal(typeof app.services.specialistService.stop, 'function');
});
