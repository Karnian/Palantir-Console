const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveModelPolicy } = require('../services/modelPolicyResolver');

const policy = (scope_type, params) => ({ scope_type, params });

function resolve(overrides = {}) {
  return resolveModelPolicy({
    layer: 'operator',
    vendor: 'codex',
    scopedPolicies: [],
    env: {},
    ...overrides,
  });
}

test('F-1: worker forces standard and suppresses model/effort regardless of every override', () => {
  assert.deepEqual(resolve({
    layer: 'worker',
    source: undefined,
    scopedPolicies: [policy('codebase', {
      model: 'policy-model',
      reasoning_effort: 'high',
      tier: 'fast',
    })],
    instanceFastMode: 1,
    requestModel: 'request-model',
    env: { PALANTIR_CODEX_FAST: '1' },
  }), {
    model: null,
    effort: null,
    tier: 'standard',
    sources: { model: 'cli', effort: 'cli', tier: 'cli' },
  });
});

test('F-1: auto_review forces standard and suppresses model/effort for top and operator', () => {
  for (const layer of ['top', 'operator']) {
    assert.deepEqual(resolve({
      layer,
      source: 'auto_review',
      scopedPolicies: [policy(layer === 'top' ? 'layer:top' : 'codebase', {
        model: 'policy-model',
        reasoning_effort: 'high',
        tier: 'fast',
      })],
      instanceFastMode: 1,
      requestModel: 'request-model',
      env: { PALANTIR_CODEX_FAST: '1' },
    }), {
      model: null,
      effort: null,
      tier: 'standard',
      sources: { model: 'cli', effort: 'cli', tier: 'cli' },
    }, layer);
  }
});

test('F-1: non-codex worker and auto_review have no applicable tier', () => {
  for (const input of [
    { layer: 'worker' },
    { layer: 'top', source: 'auto_review' },
  ]) {
    assert.deepEqual(resolve({
      ...input,
      vendor: 'claude',
      scopedPolicies: [policy('global', { model: 'm1', tier: 'fast' })],
      env: { PALANTIR_CODEX_FAST: '1' },
    }), {
      model: null,
      effort: null,
      tier: null,
      sources: { model: 'cli', effort: 'cli', tier: 'cli' },
    });
  }
});

test('fields resolve independently: a model-only row does not block tier env fallback', () => {
  assert.deepEqual(resolve({
    scopedPolicies: [policy('global', { model: 'm1' })],
    env: { PALANTIR_CODEX_FAST: '1' },
  }), {
    model: 'm1',
    effort: null,
    tier: 'fast',
    sources: { model: 'global', effort: 'cli', tier: 'env' },
  });
});

test('model tri-state: a more-specific explicit value wins', () => {
  const result = resolve({
    scopedPolicies: [
      policy('codebase', { model: 'm-codebase' }),
      policy('layer:operator', { model: 'm-layer' }),
      policy('global', { model: 'm-global' }),
    ],
  });

  assert.equal(result.model, 'm-codebase');
  assert.equal(result.sources.model, 'codebase');
});

test('model tri-state: cli-default resolves null and stops less-specific inheritance', () => {
  const result = resolve({
    scopedPolicies: [
      policy('codebase', { model: '__cli_default__' }),
      policy('layer:operator', { model: 'm-layer' }),
      policy('global', { model: 'm-global' }),
    ],
  });

  assert.equal(result.model, null);
  assert.equal(result.sources.model, 'cli');
});

test('model tri-state: absent inherits to the next scope and none resolves to cli', () => {
  const inherited = resolve({
    scopedPolicies: [
      policy('codebase', { tier: 'fast' }),
      policy('layer:operator', { model: 'm-layer' }),
    ],
  });
  assert.equal(inherited.model, 'm-layer');
  assert.equal(inherited.sources.model, 'layer');

  const missing = resolve({ scopedPolicies: [policy('global', { tier: 'fast' })] });
  assert.equal(missing.model, null);
  assert.equal(missing.sources.model, 'cli');
});

test('effort tri-state: explicit, cli-default stop, absent inheritance, and none', () => {
  const cases = [
    {
      name: 'explicit',
      policies: [
        policy('codebase', { reasoning_effort: 'high' }),
        policy('global', { reasoning_effort: 'low' }),
      ],
      effort: 'high',
      source: 'codebase',
    },
    {
      name: 'cli-default',
      policies: [
        policy('codebase', { reasoning_effort: '__cli_default__' }),
        policy('global', { reasoning_effort: 'high' }),
      ],
      effort: null,
      source: 'cli',
    },
    {
      name: 'inherit',
      policies: [
        policy('codebase', { model: 'm1' }),
        policy('layer:operator', { reasoning_effort: 'medium' }),
      ],
      effort: 'medium',
      source: 'layer',
    },
    {
      name: 'none',
      policies: [policy('global', { model: 'm1' })],
      effort: null,
      source: 'cli',
    },
  ];

  for (const entry of cases) {
    const result = resolve({ scopedPolicies: entry.policies });
    assert.equal(result.effort, entry.effort, entry.name);
    assert.equal(result.sources.effort, entry.source, entry.name);
  }
});

test('operator tier: live instance 1/0 beats policy and env', () => {
  const shared = {
    scopedPolicies: [policy('codebase', { tier: 'fast' })],
    env: { PALANTIR_CODEX_FAST: '1' },
  };

  const fast = resolve({ ...shared, instanceFastMode: 1 });
  assert.equal(fast.tier, 'fast');
  assert.equal(fast.sources.tier, 'instance');

  const standard = resolve({ ...shared, instanceFastMode: 0 });
  assert.equal(standard.tier, 'standard');
  assert.equal(standard.sources.tier, 'instance');
});

test('operator tier: null/undefined instance falls through to the first policy tier', () => {
  for (const instanceFastMode of [null, undefined]) {
    const result = resolve({
      instanceFastMode,
      scopedPolicies: [
        policy('codebase', { model: 'model-only' }),
        policy('layer:operator', { tier: 'standard' }),
        policy('global', { tier: 'fast' }),
      ],
      env: { PALANTIR_CODEX_FAST: '1' },
    });
    assert.equal(result.tier, 'standard');
    assert.equal(result.sources.tier, 'layer');
  }
});

test('operator tier: without a policy env 1/true means fast; unset/other means standard', () => {
  for (const value of ['1', 'true']) {
    const result = resolve({ env: { PALANTIR_CODEX_FAST: value } });
    assert.equal(result.tier, 'fast', value);
    assert.equal(result.sources.tier, 'env', value);
  }

  for (const env of [{}, { PALANTIR_CODEX_FAST: '0' }, { PALANTIR_CODEX_FAST: 'false' }]) {
    const result = resolve({ env });
    assert.equal(result.tier, 'standard');
    assert.equal(result.sources.tier, 'env');
  }
});

test('top model precedence is request, then layer:top, then global', () => {
  const policies = [
    policy('layer:top', { model: 'm-layer' }),
    policy('global', { model: 'm-global' }),
  ];

  const requested = resolve({ layer: 'top', requestModel: 'm-request', scopedPolicies: policies });
  assert.equal(requested.model, 'm-request');
  assert.equal(requested.sources.model, 'request');

  const layered = resolve({ layer: 'top', requestModel: '', scopedPolicies: policies });
  assert.equal(layered.model, 'm-layer');
  assert.equal(layered.sources.model, 'layer');

  const global = resolve({
    layer: 'top',
    scopedPolicies: [policy('layer:top', { tier: 'fast' }), policy('global', { model: 'm-global' })],
  });
  assert.equal(global.model, 'm-global');
  assert.equal(global.sources.model, 'global');
});

test('top request cli-default suppresses policy inheritance', () => {
  const result = resolve({
    layer: 'top',
    requestModel: '__cli_default__',
    scopedPolicies: [policy('layer:top', { model: 'm-layer' })],
  });

  assert.equal(result.model, null);
  assert.equal(result.sources.model, 'cli');
});

test('top tier walks policy independently, then falls back to env/default', () => {
  const policyTier = resolve({
    layer: 'top',
    instanceFastMode: 1,
    scopedPolicies: [policy('layer:top', { tier: 'standard' })],
    env: { PALANTIR_CODEX_FAST: '1' },
  });
  assert.equal(policyTier.tier, 'standard');
  assert.equal(policyTier.sources.tier, 'layer');

  const envFast = resolve({ layer: 'top', env: { PALANTIR_CODEX_FAST: '1' } });
  assert.equal(envFast.tier, 'fast');
  assert.equal(envFast.sources.tier, 'env');

  const defaultStandard = resolve({ layer: 'top', env: {} });
  assert.equal(defaultStandard.tier, 'standard');
  assert.equal(defaultStandard.sources.tier, 'env');
});

test('claude resolves no tier even when instance, policy, and env all request fast', () => {
  const result = resolve({
    vendor: 'claude',
    instanceFastMode: 1,
    scopedPolicies: [policy('codebase', { model: 'claude-model', tier: 'fast' })],
    env: { PALANTIR_CODEX_FAST: '1' },
  });

  assert.equal(result.model, 'claude-model');
  assert.equal(result.tier, null);
  assert.equal(result.sources.tier, 'cli');
});

test('source tags map request/instance/codebase/layer/global/env/cli correctly', () => {
  const independentScopes = resolve({
    scopedPolicies: [
      policy('codebase', { model: 'm-codebase' }),
      policy('layer:operator', { reasoning_effort: 'high' }),
      policy('global', { tier: 'fast' }),
    ],
  });
  assert.deepEqual(independentScopes.sources, {
    model: 'codebase',
    effort: 'layer',
    tier: 'global',
  });

  assert.equal(resolve({ layer: 'top', requestModel: 'm-request' }).sources.model, 'request');
  assert.equal(resolve({ instanceFastMode: 1 }).sources.tier, 'instance');
  assert.equal(resolve({ env: { PALANTIR_CODEX_FAST: '1' } }).sources.tier, 'env');
  assert.equal(resolve().sources.model, 'cli');
});
