'use strict';

// Pure field-level resolver for Model/Effort Policy (spec §§3.2, 3.4).

const CLI_DEFAULT = '__cli_default__';
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function sourceForScope(scopeType) {
  if (scopeType === 'codebase') return 'codebase';
  if (scopeType === 'layer:top' || scopeType === 'layer:operator') return 'layer';
  if (scopeType === 'global') return 'global';
  return 'cli';
}

function findPolicyValue(scopedPolicies, key) {
  for (const policy of scopedPolicies) {
    const params = policy && policy.params;
    if (!params || typeof params !== 'object' || !hasOwn(params, key)) continue;

    const value = params[key];
    if (value === CLI_DEFAULT) return { value: null, source: 'cli' };
    if (typeof value === 'string') {
      return { value, source: sourceForScope(policy.scope_type) };
    }
  }

  return { value: null, source: 'cli' };
}

function findPolicyTier(scopedPolicies) {
  for (const policy of scopedPolicies) {
    const params = policy && policy.params;
    if (!params || typeof params !== 'object' || !hasOwn(params, 'tier')) continue;

    const value = params.tier;
    if (value === 'fast' || value === 'standard') {
      return { value, source: sourceForScope(policy.scope_type) };
    }
  }

  return null;
}

function envTier(env) {
  const fast = env && (env.PALANTIR_CODEX_FAST === '1' || env.PALANTIR_CODEX_FAST === 'true');
  return { value: fast ? 'fast' : 'standard', source: 'env' };
}

function resolveModelPolicy({
  layer,
  vendor,
  source,
  scopedPolicies = [],
  instanceFastMode,
  requestModel,
  env = {},
} = {}) {
  // F-1 is absolute and Phase 1 never applies model/effort to workers.
  if (layer === 'worker' || source === 'auto_review') {
    return {
      model: null,
      effort: null,
      tier: vendor === 'codex' ? 'standard' : null,
      sources: { model: 'cli', effort: 'cli', tier: 'cli' },
    };
  }

  let model;
  if (layer === 'top' && typeof requestModel === 'string' && requestModel.length > 0) {
    model = requestModel === CLI_DEFAULT
      ? { value: null, source: 'cli' }
      : { value: requestModel, source: 'request' };
  } else {
    model = findPolicyValue(scopedPolicies, 'model');
  }

  const effort = findPolicyValue(scopedPolicies, 'reasoning_effort');

  let tier;
  if (vendor !== 'codex') {
    tier = { value: null, source: 'cli' };
  } else if (layer === 'operator' && (instanceFastMode === 1 || instanceFastMode === 0)) {
    tier = { value: instanceFastMode === 1 ? 'fast' : 'standard', source: 'instance' };
  } else {
    tier = findPolicyTier(scopedPolicies) || envTier(env);
  }

  return {
    model: model.value,
    effort: effort.value,
    tier: tier.value,
    sources: { model: model.source, effort: effort.source, tier: tier.source },
  };
}

module.exports = { resolveModelPolicy };
