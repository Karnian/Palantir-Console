'use strict';

const { BadRequestError } = require('../utils/errors');

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
    if (!Array.isArray(parsed)) return { valid: false, keys: [] };
    return {
      valid: true,
      keys: parsed.filter((key) => typeof key === 'string'),
    };
  } catch {
    return { valid: false, keys: [] };
  }
}

function resolveProviderEnvPolicy(explicitAllowlist, providers = []) {
  const parsedExplicit = parseEnvKeyArray(explicitAllowlist);
  const effectiveKeys = [];
  const effectiveSet = new Set();
  for (const key of parsedExplicit.keys) {
    if (!effectiveSet.has(key)) {
      effectiveSet.add(key);
      effectiveKeys.push(key);
    }
  }

  const resolvedProviders = [];
  for (const provider of providers) {
    const parsedProviderKeys = parseEnvKeyArray(provider.env_keys);
    const envKeys = parsedProviderKeys.valid ? parsedProviderKeys.keys : [];
    const inheritedKeys = [];
    const secretKeys = [];
    const withheldSecretKeys = [];

    for (const key of envKeys) {
      if (isProviderSecretEnvKey(key)) {
        secretKeys.push(key);
        if (!effectiveSet.has(key)) withheldSecretKeys.push(key);
        continue;
      }
      inheritedKeys.push(key);
      if (!effectiveSet.has(key)) {
        effectiveSet.add(key);
        effectiveKeys.push(key);
      }
    }

    resolvedProviders.push({
      id: provider.id,
      name: provider.name,
      envKeys,
      inheritedKeys,
      secretKeys,
      withheldSecretKeys,
      valid: parsedProviderKeys.valid,
    });
  }

  return {
    valid: parsedExplicit.valid && resolvedProviders.every((provider) => provider.valid),
    explicitKeys: parsedExplicit.keys,
    effectiveKeys,
    providers: resolvedProviders,
  };
}

module.exports = {
  ENV_VAR_NAME_RE,
  PROVIDER_SECRET_ENV_PATTERNS,
  isProviderSecretEnvKey,
  normalizeProviderEnvKeys,
  parseEnvKeyArray,
  resolveProviderEnvPolicy,
};
