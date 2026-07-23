/**
 * Provider registry unit tests.
 *
 * These pin the dispatch table, parallel execution, fixed ordering, alias
 * dedupe, and fallback semantics without reading host auth state or invoking
 * provider CLIs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderRegistry } = require('../services/providers');

const UPDATED_AT = '2026-01-01T00:00:00.000Z';

function provider(id, name, remainingPct = 50, extra = {}) {
  return {
    id,
    name,
    limits: [{ label: 'usage', remainingPct, resetAt: null }],
    updatedAt: UPDATED_AT,
    ...extra,
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function makeRegistry({
  codexImpl = async () => provider('codex', 'codex', 80),
  claudeImpl = async () => provider('anthropic', 'claude', 70),
  geminiImpl = async () => provider('google', 'gemini', 60),
} = {}) {
  return createProviderRegistry({
    codexService: { getProviderStatus: codexImpl },
    fetchClaudeCodeUsageFn: claudeImpl,
    fetchGeminiUsageFn: geminiImpl,
  });
}

test('fetchAllKnown always attempts every known provider without external auth state', async () => {
  const calls = [];
  const registry = makeRegistry({
    codexImpl: async () => { calls.push('codex'); return provider('codex', 'codex'); },
    claudeImpl: async () => { calls.push('claude'); return provider('anthropic', 'claude'); },
    geminiImpl: async () => { calls.push('gemini'); return provider('google', 'gemini'); },
  });

  const result = await registry.fetchAllKnown();

  assert.deepEqual(calls.sort(), ['claude', 'codex', 'gemini']);
  assert.deepEqual(result.map((entry) => entry.id), ['codex', 'anthropic', 'google']);
});

test('fetchAllKnown starts provider handlers in parallel', async () => {
  const gate = createDeferred();
  const started = [];
  const waitForGate = (name, result) => async () => {
    started.push(name);
    await gate.promise;
    return result;
  };
  const registry = makeRegistry({
    codexImpl: waitForGate('codex', provider('codex', 'codex')),
    claudeImpl: waitForGate('claude', provider('anthropic', 'claude')),
    geminiImpl: waitForGate('gemini', provider('google', 'gemini')),
  });

  const pending = registry.fetchAllKnown();
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.deepEqual(started.sort(), ['claude', 'codex', 'gemini']);
  } finally {
    gate.resolve();
  }
  await pending;
});

test('fetchAllKnown preserves fixed display order regardless of completion order', async () => {
  const gates = {
    codex: createDeferred(),
    claude: createDeferred(),
    gemini: createDeferred(),
  };
  const completed = [];
  const afterGate = (name, result) => async () => {
    await gates[name].promise;
    completed.push(name);
    return result;
  };
  const registry = makeRegistry({
    codexImpl: afterGate('codex', provider('codex', 'codex')),
    claudeImpl: afterGate('claude', provider('anthropic', 'claude')),
    geminiImpl: afterGate('gemini', provider('google', 'gemini')),
  });

  const pending = registry.fetchAllKnown();
  gates.gemini.resolve();
  await Promise.resolve();
  gates.claude.resolve();
  await Promise.resolve();
  gates.codex.resolve();

  const result = await pending;
  assert.deepEqual(completed, ['gemini', 'claude', 'codex']);
  assert.deepEqual(result.map((entry) => entry.id), ['codex', 'anthropic', 'google']);
});

test('fetchAllKnown anthropic provider dispatches through injected Claude Code adapter', async () => {
  const claudeResult = provider('anthropic', 'claude', 41, {
    account: { email: 'claude@example.test', planType: 'max' },
  });
  let calls = 0;
  const registry = makeRegistry({
    claudeImpl: async () => {
      calls += 1;
      return claudeResult;
    },
  });

  const result = await registry.fetchAllKnown();

  assert.equal(calls, 1);
  assert.strictEqual(result[1], claudeResult);
  assert.equal(result[1].account.email, 'claude@example.test');
});

test('fetchAllKnown dedupes google and gemini aliases by handler identity', async () => {
  let geminiCalls = 0;
  const registry = makeRegistry({
    geminiImpl: async () => {
      geminiCalls += 1;
      return provider('google', 'gemini');
    },
  });

  const result = await registry.fetchAllKnown();

  assert.equal(geminiCalls, 1);
  assert.equal(result.length, 3);
  assert.deepEqual(result.map((entry) => entry.id), ['codex', 'anthropic', 'google']);
});

test('fetchAllKnown isolates thrown handlers and keeps canonical fallback ids', async () => {
  const registry = makeRegistry({
    codexImpl: async () => { throw new Error('codex unavailable'); },
  });

  const result = await registry.fetchAllKnown();

  assert.equal(result.length, 3);
  assert.equal(result[0].id, 'codex');
  assert.equal(result[0].name, 'codex');
  assert.match(result[0].limits[0].errorMessage, /codex unavailable/);
  assert.equal(result[1].id, 'anthropic');
  assert.equal(result[2].id, 'google');
});

test('fetchAllKnown converts a null result to a canonical fallback envelope', async () => {
  const registry = makeRegistry({ codexImpl: async () => null });

  const result = await registry.fetchAllKnown();

  assert.equal(result[0].id, 'codex');
  assert.equal(result[0].name, 'codex');
  assert.match(result[0].limits[0].errorMessage, /returned no data/i);
});

test('getUsageForAgent dispatches codex type to codexService', async () => {
  const registry = makeRegistry({
    codexImpl: async () => provider('codex', 'codex', 42),
  });

  const result = await registry.getUsageForAgent({ id: 'a1', type: 'codex', name: 'My Codex' });

  assert.equal(result.id, 'codex');
  assert.equal(result.limits[0].remainingPct, 42);
});

test('getUsageForAgent dispatches claude-code through the injected adapter', async () => {
  let calls = 0;
  const registry = makeRegistry({
    claudeImpl: async () => {
      calls += 1;
      return provider('anthropic', 'claude', 33);
    },
  });

  const result = await registry.getUsageForAgent({ id: 'a1', type: 'claude-code', name: 'Claude' });

  assert.equal(calls, 1);
  assert.equal(result.id, 'anthropic');
  assert.equal(result.limits[0].remainingPct, 33);
});

test('getUsageForAgent unknown type fallback preserves agent name', async () => {
  const registry = makeRegistry();
  const result = await registry.getUsageForAgent({ id: 'a1', type: 'opencode', name: 'My OpenCode' });

  assert.equal(result.id, 'opencode');
  assert.equal(result.name, 'My OpenCode');
  assert.match(result.limits[0].errorMessage, /No usage provider for type/);
});

test('getUsageForAgent unknown type without agent name falls back to id', async () => {
  const registry = makeRegistry();
  const result = await registry.getUsageForAgent({ id: 'a1', type: 'mystery' });

  assert.equal(result.id, 'mystery');
  assert.equal(result.name, 'mystery');
});

test('getUsageForAgent converts a thrown handler to a named fallback envelope', async () => {
  const registry = makeRegistry({
    codexImpl: async () => { throw new Error('codex unavailable'); },
  });

  const result = await registry.getUsageForAgent({ id: 'a1', type: 'codex', name: 'My Codex' });

  assert.equal(result.name, 'My Codex');
  assert.match(result.limits[0].errorMessage, /codex unavailable/);
});

test('parseOAuthUsageLimits keeps only entries with a utilization signal', () => {
  const { parseOAuthUsageLimits } = require('../services/providers/claude-code');
  const limits = parseOAuthUsageLimits({
    five_hour: { utilization: 25, resets_at: '2026-07-05T05:00:00Z' },
    extra_usage: { is_enabled: true },
    disabled_feature: { is_enabled: false },
    limits: { meta: true },
    spend: { currency: 'usd' },
    not_an_object: 42,
  });

  assert.deepEqual(limits.map((limit) => limit.label).sort(), ['5h limit', 'extra usage']);
});
