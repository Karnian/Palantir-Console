'use strict';

const { BadRequestError } = require('../utils/errors');
const { isBearerEnvKeyDenied } = require('./envDenylist');

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ENV_KEYS = 256;
const MAX_ENV_KEYS_JSON_BYTES = 16 * 1024;

// Provider declarations describe requirements, not authority. Credential-like
// names therefore need a second, profile-local approval in env_allowlist before
// they can be forwarded. These patterns are intentionally provider-agnostic:
// adding a provider name must never imply a vendor-specific credential set.
//
// The suffixes mirror the credential portion of envDenylist.js. The token
// forms additionally catch canaries such as AWS_SECRET_ACCESS_KEY and names
// where SECRET / API_KEY are not the final component.
//
// Two deliberate widenings over envDenylist.js, because that list guards names
// this codebase chose while these names are whatever an operator types:
//
//   1. Matching is case-INSENSITIVE. ENV_VAR_NAME_RE admits any case, so an
//      uppercase-only rule would wave through `stripeSecretKey` — a real
//      spelling for a real credential.
//   2. The word forms do not require an underscore boundary. `SECRETKEY` and
//      `MY_SECRETKEY` are the same secret as `SECRET_KEY`; only the separator
//      differs, and a classifier that turns on punctuation is not a classifier.
//
// Over-blocking is the safe direction here: a false positive costs one explicit
// env_allowlist entry, a false negative forwards a credential automatically.
const PROVIDER_SECRET_ENV_PATTERNS = [
  /SECRET/i,
  /API_?KEY/i,
  /ACCESS_?KEY/i,
  /_?KEY$/i,
  /_?TOKEN$/i,
  /PASSWORD/i,
  /PASSWD/i,
  /CREDENTIALS?/i,
  /_?CERT$/i,
  /PRIVATE/i,
  /_?PASS$/i,
];

function isProviderSecretEnvKey(key) {
  const text = String(key);
  // `stripeSecretKey` has no separators at all, so also test the camelCase
  // boundaries as if they were underscores — otherwise the anchored patterns
  // (`_KEY$`) never see a boundary to anchor to.
  const snakeCased = text.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return PROVIDER_SECRET_ENV_PATTERNS.some(
    (pattern) => pattern.test(text) || pattern.test(snakeCased),
  );
}

function normalizeProviderEnvKeys(value) {
  let keys = value;
  if (typeof keys === 'string') {
    try {
      keys = JSON.parse(keys);
    } catch {
      throw new BadRequestError('env_keys must be a valid JSON array');
    }
  }
  if (!Array.isArray(keys)) {
    throw new BadRequestError('env_keys must be an array');
  }
  if (keys.length > MAX_ENV_KEYS) {
    throw new BadRequestError(`env_keys has too many entries (max ${MAX_ENV_KEYS})`);
  }

  const normalized = [];
  const seen = new Set();
  for (const key of keys) {
    if (typeof key !== 'string' || !ENV_VAR_NAME_RE.test(key)) {
      throw new BadRequestError(
        `env_keys entries must match ${ENV_VAR_NAME_RE} (POSIX env var name)`,
      );
    }
    // Provider declarations may contain credential names, so use the shared
    // denylist's process/loader predicate (the full MCP predicate also rejects
    // every *_KEY). This still rejects NODE_OPTIONS, LD_PRELOAD, PATH, etc.
    if (isBearerEnvKeyDenied(key)) {
      throw new BadRequestError(
        `env_keys entry "${key}" is denied because it can alter process loading or runtime configuration`,
      );
    }
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(key);
    }
  }

  const json = JSON.stringify(normalized);
  if (Buffer.byteLength(json, 'utf8') > MAX_ENV_KEYS_JSON_BYTES) {
    throw new BadRequestError(
      `env_keys JSON exceeds ${MAX_ENV_KEYS_JSON_BYTES} byte limit`,
    );
  }
  return normalized;
}

function parseEnvKeyArray(value) {
  try {
    // NULL/undefined is an EMPTY allowlist, not a malformed one — matching
    // lifecycleService's long-standing `JSON.parse(json || '[]')`. Treating it
    // as invalid instead made a profile with env_allowlist=NULL silently drop
    // every provider key at spawn while the API kept reporting them as active:
    // the operator sees the provider applied and the child never receives it.
    if (value === null || value === undefined) return { valid: true, keys: [] };
    const parsed = typeof value === 'string' ? JSON.parse(value || '[]') : value;
    if (
      !Array.isArray(parsed)
      || parsed.some((key) => typeof key !== 'string')
    ) {
      return { valid: false, keys: [] };
    }
    return {
      valid: true,
      keys: parsed,
    };
  } catch {
    return { valid: false, keys: [] };
  }
}

function parseProviderGate(provider) {
  const gateEnvKey = provider && provider.gate_env_key;
  const gateEnvValue = provider && provider.gate_env_value;
  if (gateEnvKey == null && gateEnvValue == null) {
    return {
      valid: true,
      key: null,
      value: null,
    };
  }
  const presenceOnly = gateEnvValue == null && isProviderSecretEnvKey(gateEnvKey);
  if (
    typeof gateEnvKey !== 'string'
    || !ENV_VAR_NAME_RE.test(gateEnvKey)
    || (!presenceOnly && (
      typeof gateEnvValue !== 'string'
      || gateEnvValue.length === 0
    ))
  ) {
    return {
      valid: false,
      key: null,
      value: null,
    };
  }
  return {
    valid: true,
    key: gateEnvKey,
    value: gateEnvValue,
  };
}

function resolveProviderEnvPolicy(
  explicitAllowlist,
  providers = [],
  hostEnv = process.env,
) {
  const parsedExplicit = parseEnvKeyArray(explicitAllowlist);
  const explicitSet = new Set(parsedExplicit.keys);
  const parsedProviders = providers.map((provider) => {
    const parsedProviderKeys = parseEnvKeyArray(provider.env_keys);
    const rawEnvKeys = parsedProviderKeys.valid ? parsedProviderKeys.keys : [];
    // Defense in depth for rows inserted before declaration-time validation or
    // by direct SQL. Denied keys never enter any effective set, even when the
    // same key also appears in the profile's explicit allowlist.
    const deniedKeys = rawEnvKeys.filter(isBearerEnvKeyDenied);
    const envKeys = rawEnvKeys.filter((key) => !isBearerEnvKeyDenied(key));
    const gate = parseProviderGate(provider);
    const gateDeclared = !gate.key || envKeys.includes(gate.key);
    const valid = parsedProviderKeys.valid
      && rawEnvKeys.every((key) => ENV_VAR_NAME_RE.test(key))
      && gate.valid
      && gateDeclared
      && deniedKeys.length === 0;
    // Gates are intentionally evaluated on the controller because this policy
    // resolves controller process.env. Remote call sites MUST reject a gated
    // policy rather than assuming the node has the same value; node-side gate
    // evaluation requires a separate transport contract.
    const active = valid
      && gateDeclared
      && (
        !gate.key
        || (
          hostEnv
          && Object.prototype.hasOwnProperty.call(hostEnv, gate.key)
          && hostEnv[gate.key] != null
          && (gate.value == null || String(hostEnv[gate.key]) === gate.value)
        )
      );
    return {
      provider,
      rawEnvKeys,
      envKeys,
      deniedKeys,
      gate,
      active,
      valid,
    };
  });

  // An inactive gated provider suppresses its declared keys even when a
  // credential-shaped key is present in the profile's explicit allowlist.
  // The explicit entry is the second approval; the gate remains the first.
  // If another active provider declares the same key, that active declaration
  // is sufficient to keep the shared key eligible.
  const activeDeclaredKeys = new Set(
    parsedProviders
      .filter((provider) => provider.active)
      .flatMap((provider) => provider.envKeys),
  );
  const blockedKeys = new Set();
  for (const provider of parsedProviders) {
    for (const key of provider.deniedKeys) blockedKeys.add(key);
  }
  for (const provider of parsedProviders) {
    if (provider.active || !provider.gate.key) continue;
    for (const key of provider.envKeys) {
      if (!activeDeclaredKeys.has(key)) blockedKeys.add(key);
    }
  }

  const effectiveKeys = [];
  const effectiveSet = new Set();
  for (const key of parsedExplicit.keys) {
    if (blockedKeys.has(key)) continue;
    if (!effectiveSet.has(key)) {
      effectiveSet.add(key);
      effectiveKeys.push(key);
    }
  }

  const resolvedProviders = [];
  for (const parsedProvider of parsedProviders) {
    const {
      provider,
      rawEnvKeys,
      envKeys,
      deniedKeys,
      gate,
      active,
      valid,
    } = parsedProvider;
    const inheritedKeys = [];
    const secretKeys = [];
    const withheldSecretKeys = [];
    const approvedSecretKeys = [];

    for (const key of envKeys) {
      if (isProviderSecretEnvKey(key)) {
        secretKeys.push(key);
        if (!explicitSet.has(key)) {
          withheldSecretKeys.push(key);
        } else if (active) {
          approvedSecretKeys.push(key);
        }
        continue;
      }
      if (!active) continue;
      inheritedKeys.push(key);
      if (!effectiveSet.has(key)) {
        effectiveSet.add(key);
        effectiveKeys.push(key);
      }
    }

    resolvedProviders.push({
      id: provider.id,
      name: provider.name,
      envKeys: rawEnvKeys,
      deniedKeys,
      inheritedKeys,
      secretKeys,
      withheldSecretKeys,
      approvedSecretKeys,
      gateEnvKey: gate.key,
      gateEnvValue: gate.value,
      gateScope: gate.key ? 'controller' : null,
      active,
      inactiveKeys: active ? [] : envKeys,
      valid,
    });
  }

  return {
    valid: parsedExplicit.valid && resolvedProviders.every((provider) => provider.valid),
    explicitKeys: parsedExplicit.keys,
    effectiveKeys,
    allowDefaultAuth: parsedExplicit.keys.length === 0,
    blockedKeys: [...blockedKeys],
    providers: resolvedProviders,
  };
}

module.exports = {
  ENV_VAR_NAME_RE,
  PROVIDER_SECRET_ENV_PATTERNS,
  isProviderSecretEnvKey,
  normalizeProviderEnvKeys,
  parseEnvKeyArray,
  parseProviderGate,
  resolveProviderEnvPolicy,
};
