/**
 * Provider registry unit tests.
 *
 * Sit one level above usage-contract.test.js: contract tests pin the wire
 * format end-to-end through the HTTP layer; these pin the dispatch table,
 * ordering rules, dedupe behavior, and fallback semantics inside the registry
 * factory itself. The point is to make refactors to providers/index.js cheap.
 *
 * What's intentionally NOT covered:
 *  - claude-code adapter direct invocation. It shells out to `claude auth status`
 *    + curl, which is non-deterministic in CI/test envs. Route-level fallback
 *    behavior is already covered by usage-contract.test.js.
 *  - anthropic / gemini real network paths. We force the fast-fail (env vars
 *    unset) so the adapters return their built-in fallback envelopes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createProviderRegistry } = require('../services/providers');

async function makeAuthFile(contents) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-providers-'));
  const filePath = path.join(dir, 'auth.json');
  if (contents !== null) {
    await fs.writeFile(filePath, typeof contents === 'string' ? contents : JSON.stringify(contents));
  }
  return { dir, filePath };
}

async function cleanup(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

// Stub codexService — registry only consumes getProviderStatus()
function makeCodexStub(impl) {
  return { getProviderStatus: impl };
}

function withClearedEnv(t) {
  // Both anthropic and gemini adapters short-circuit when their key env is empty.
  const prev = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

// ---- listRegistered ----

test('listRegistered: missing auth file returns []', async (t) => {
  const registry = createProviderRegistry({
    codexService: makeCodexStub(async () => null),
    opencodeAuthPath: '/nonexistent/palantir-test/auth.json',
  });
  const result = await registry.listRegistered();
  assert.deepEqual(result, []);
});

test('listRegistered: invalid JSON returns []', async (t) => {
  const { dir, filePath } = await makeAuthFile('{ this is not json');
  t.after(() => cleanup(dir));
  const registry = createProviderRegistry({
    codexService: makeCodexStub(async () => null),
    opencodeAuthPath: filePath,
  });
  assert.deepEqual(await registry.listRegistered(), []);
});

test('listRegistered: array JSON returns [] (rejects array, not just non-object)', async (t) => {
  // Without the Array.isArray guard, Object.keys([1,2,3]) would yield ["0","1","2"]
  // which would surface as three bogus "providers". Lock that out.
  const { dir, filePath } = await makeAuthFile([1, 2, 3]);
  t.after(() => cleanup(dir));
  const registry = createProviderRegistry({
    codexService: makeCodexStub(async () => null),
    opencodeAuthPath: filePath,
  });
  assert.deepEqual(await registry.listRegistered(), []);
});

test('listRegistered: normal object returns sorted keys', async (t) => {
  const { dir, filePath } = await makeAuthFile({ openai: {}, anthropic: {}, google: {} });
  t.after(() => cleanup(dir));
  const registry = createProviderRegistry({
    codexService: makeCodexStub(async () => null),
    opencodeAuthPath: filePath,
  });
  assert.deepEqual(await registry.listRegistered(), ['anthropic', 'google', 'openai']);
});

// ---- fetchAllRegistered ----

test('fetchAllRegistered: empty registered list yields empty providers', async (t) => {
  const registry = createProviderRegistry({
    codexService: makeCodexStub(async () => null),
    opencodeAuthPath: '/nonexistent/auth.json',
  });
  const result = await registry.fetchAllRegistered();
  assert.deepEqual(result, []);
});

test('fetchAllRegistered: openai dispatches to codexService and emits codex envelope', async (t) => {
  withClearedEnv(t);
  const { dir, filePath } = await makeAuthFile({ openai: {} });
  t.after(() => cleanup(dir));
  const registry = createProviderRegistry({
    codexService: makeCodexStub(async () => ({
      id: 'codex',
      name: 'codex',
      limits: [{ label: 'monthly', remainingPct: 80, resetAt: null }],
      updatedAt: '2026-01-01T00:00:00.000Z',
    })),
    opencodeAuthPath: filePath,
  });
  const result = await registry.fetchAllRegistered();
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'codex');
  assert.equal(result[0].name, 'codex');
  assert.equal(result[0].limits[0].remainingPct, 80);
});

test('fetchAllRegistered: anthropic without API_KEY returns fallback envelope', async (t) => {
  withClearedEnv(t);
  const { dir, filePath } = await makeAuthFile({ anthropic: {} });
  t.after(() => cleanup(dir));
  const registry = createProviderRegistry({
    codexService: makeCodexStub(async () => null),
    opencodeAuthPath: filePath,
  });
  const result = await registry.fetchAllRegistered();
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'anthropic');
  assert.equal(result[0].name, 'claude');
  assert.match(result[0].limits[0].errorMessage, /ANTHROPIC_API_KEY/);
});

test('fetchAllRegistered: google + gemini dedupe to one entry', async (t) => {
  withClearedEnv(t);
  const { dir, filePath } = await makeAuthFile({ google: {}, gemini: {} });
  t.after(() => cleanup(dir));
  const registry = createProviderRegistry({
    codexService: makeCodexStub(async () => null),
    opencodeAuthPath: filePath,
  });
  const result = await registry.fetchAllRegistered();
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'google');
  assert.equal(result[0].name, 'gemini');
});

test('fetchAllRegistered: known + unknown mixed → known only (legacy semantic)', async (t) => {
  withClearedEnv(t);
  const { dir, filePath } = await makeAuthFile({ openai: {}, mystery: {} });
  t.after(() => cleanup(dir));
  const registry = createProviderRegistry({
    codexService: makeCodexStub(async () => ({
      id: 'codex', name: 'codex', limits: [{ label: 'x', remainingPct: 50, resetAt: null }], updatedAt: '2026-01-01T00:00:00.000Z',
    })),
    opencodeAuthPath: filePath,
  });
  const result = await registry.fetchAllRegistered();
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'codex');
});

test('fetchAllRegistered: only-unknown providers emit fallback rows', async (t) => {
  withClearedEnv(t);
  const { dir, filePath } = await makeAuthFile({ mystery: {}, weird: {} });
  t.after(() => cleanup(dir));
  const registry = createProviderRegistry({
    codexService: makeCodexStub(async () => null),
    opencodeAuthPath: filePath,
  });
  const result = await registry.fetchAllRegistered();
  assert.equal(result.length, 2);
  for (const p of result) {
    assert.match(p.limits[0].errorMessage, /Usage provider not configured/);
  }
});

test('fetchAllRegistered: codex stub throws → error isolated, other providers still rendered', async (t) => {
  withClearedEnv(t);
  const { dir, filePath } = await makeAuthFile({ openai: {}, anthropic: {} });
  t.after(() => cleanup(dir));
  const registry = createProviderRegistry({
    codexService: makeCodexStub(async () => { throw new Error('boom'); }),
    opencodeAuthPath: filePath,
  });
  const result = await registry.fetchAllRegistered();
  assert.equal(result.length, 2);
  // openai (codex) → fallback envelope with the error message
  const codexEntry = result.find(r => r.id === 'openai' || r.id === 'codex');
  assert.ok(codexEntry, 'codex/openai entry rendered');
  assert.match(codexEntry.limits[0].errorMessage || '', /boom/);
  // anthropic → its own fallback (independent of codex failure)
  assert.ok(result.find(r => r.id === 'anthropic'));
});

test('fetchAllRegistered: codex stub returns null → "Provider returned no data" fallback', async (t) => {
  withClearedEnv(t);
  const { dir, filePath } = await makeAuthFile({ openai: {} });
  t.after(() => cleanup(dir));
  const registry = createProviderRegistry({
    codexService: makeCodexStub(async () => null),
    opencodeAuthPath: filePath,
  });
  const result = await registry.fetchAllRegistered();
  assert.equal(result.length, 1);
  assert.match(result[0].limits[0].errorMessage || '', /returned no data/i);
});

test('fetchAllRegistered: KNOWN_PROVIDER_ORDER preserved regardless of auth file order', async (t) => {
  withClearedEnv(t);
  // Sorted alphabetically by listRegistered: anthropic, google, openai.
  // Registry must still emit in fixed order: openai → anthropic → gemini.
  const { dir, filePath } = await makeAuthFile({ google: {}, openai: {}, anthropic: {} });
  t.after(() => cleanup(dir));
  const registry = createProviderRegistry({
    codexService: makeCodexStub(async () => ({
      id: 'codex', name: 'codex', limits: [{ label: 'x', remainingPct: 100, resetAt: null }], updatedAt: '2026-01-01T00:00:00.000Z',
    })),
    opencodeAuthPath: filePath,
  });
  const result = await registry.fetchAllRegistered();
  // Expect: codex (openai), anthropic, gemini (google) — in that order
  assert.equal(result.length, 3);
  assert.equal(result[0].id, 'codex');
  assert.equal(result[1].id, 'anthropic');
  assert.equal(result[2].id, 'google');
});

// ---- getUsageForAgent ----

test('getUsageForAgent: codex type dispatches to codexService stub', async (t) => {
  withClearedEnv(t);
  const registry = createProviderRegistry({
    codexService: makeCodexStub(async () => ({
      id: 'codex', name: 'codex', limits: [{ label: 'monthly', remainingPct: 42, resetAt: null }], updatedAt: '2026-01-01T00:00:00.000Z',
    })),
    opencodeAuthPath: '/nonexistent/auth.json',
  });
  const result = await registry.getUsageForAgent({ id: 'a1', type: 'codex', name: 'My Codex' });
  assert.equal(result.id, 'codex');
  assert.equal(result.limits[0].remainingPct, 42);
});

test('getUsageForAgent: unknown type → fallback preserves agent.name', async (t) => {
  const registry = createProviderRegistry({
    codexService: makeCodexStub(async () => null),
    opencodeAuthPath: '/nonexistent/auth.json',
  });
  const result = await registry.getUsageForAgent({ id: 'a1', type: 'opencode', name: 'My OpenCode' });
  assert.equal(result.id, 'opencode');
  assert.equal(result.name, 'My OpenCode'); // ← human label preserved
  assert.match(result.limits[0].errorMessage, /No usage provider for type/);
});

test('getUsageForAgent: unknown type without agent.name → fallback uses id', async (t) => {
  const registry = createProviderRegistry({
    codexService: makeCodexStub(async () => null),
    opencodeAuthPath: '/nonexistent/auth.json',
  });
  const result = await registry.getUsageForAgent({ id: 'a1', type: 'mystery' });
  assert.equal(result.id, 'mystery');
  assert.equal(result.name, 'mystery'); // ← falls back to id when no name
});

test('getUsageForAgent: codex stub throws → fallback envelope with error', async (t) => {
  const registry = createProviderRegistry({
    codexService: makeCodexStub(async () => { throw new Error('codex unavailable'); }),
    opencodeAuthPath: '/nonexistent/auth.json',
  });
  const result = await registry.getUsageForAgent({ id: 'a1', type: 'codex', name: 'Codex' });
  assert.equal(result.name, 'Codex');
  assert.match(result.limits[0].errorMessage || '', /codex unavailable/);
});

test('getUsageForAgent: codex stub returns null → "Provider returned no data"', async (t) => {
  const registry = createProviderRegistry({
    codexService: makeCodexStub(async () => null),
    opencodeAuthPath: '/nonexistent/auth.json',
  });
  const result = await registry.getUsageForAgent({ id: 'a1', type: 'codex', name: 'Codex' });
  assert.equal(result.name, 'Codex');
  assert.match(result.limits[0].errorMessage || '', /returned no data/i);
});
