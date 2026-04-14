const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { canonicalizeUrl, fetchUrlSafe } = require('./ssrf');

/**
 * Registry service — bundled skill pack registry loader + URL-install fetch pipeline.
 * Spec: docs/specs/skill-pack-gallery-v1.1.md §6.4
 */
function createRegistryService() {
  const bundledPath = path.join(__dirname, '..', 'data', 'skill-pack-registry.json');

  let bundledRegistry = null;

  function loadBundled() {
    try {
      const raw = fs.readFileSync(bundledPath, 'utf-8');
      bundledRegistry = JSON.parse(raw);
      if (bundledRegistry && Array.isArray(bundledRegistry.packs)) {
        for (const pack of bundledRegistry.packs) {
          pack._source = 'bundled';
        }
      }
    } catch (err) {
      console.error('[registry] Failed to load bundled registry:', err.message);
      bundledRegistry = { version: '1', categories: [], packs: [] };
    }
  }

  loadBundled();

  function getRegistry() {
    if (!bundledRegistry) loadBundled();
    return {
      source: 'bundled',
      categories: bundledRegistry.categories || [],
      packs: bundledRegistry.packs || [],
    };
  }

  function getRegistryPack(registryId) {
    if (!bundledRegistry) loadBundled();
    const packs = bundledRegistry.packs || [];
    return packs.find(p => p.registry_id === registryId) || null;
  }

  // ─── Preview token store (v1.1 §6.5) ───
  // In-memory, ephemeral, TTL 5min, 1-shot consumption.
  const PREVIEW_TTL_MS = 5 * 60 * 1000;
  const PREVIEW_MAX_ENTRIES = 1000;
  const previewTokens = new Map(); // token → { bindingKey, hash, expires }

  function pruneExpiredTokens() {
    const now = Date.now();
    for (const [tok, entry] of previewTokens) {
      if (entry.expires < now) previewTokens.delete(tok);
    }
    // LRU eviction if too large
    if (previewTokens.size > PREVIEW_MAX_ENTRIES) {
      const toRemove = previewTokens.size - PREVIEW_MAX_ENTRIES;
      const keys = [...previewTokens.keys()].slice(0, toRemove);
      for (const k of keys) previewTokens.delete(k);
    }
  }

  /**
   * Issue a preview token bound to a key + hash.
   * @param {string} bindingKey - e.g. `url:<canonical_url>` or `pack:<pack_id>`
   * @param {string} hash - SHA-256 hex of fetched content
   * @returns {string} token
   */
  function issuePreviewToken(bindingKey, hash) {
    pruneExpiredTokens();
    const token = crypto.randomBytes(24).toString('hex');
    previewTokens.set(token, {
      bindingKey,
      hash,
      expires: Date.now() + PREVIEW_TTL_MS,
    });
    return token;
  }

  /**
   * Consume a preview token — validates + removes (1-shot).
   * Throws if invalid/expired/mismatched.
   */
  function consumePreviewToken(token, expectedBindingKey, expectedHash) {
    pruneExpiredTokens();
    if (!token || typeof token !== 'string') {
      throw makeErr(400, 'preview_token required', 'preview_token_missing');
    }
    const entry = previewTokens.get(token);
    if (!entry) {
      throw makeErr(400, 'preview_token invalid or expired', 'preview_token_invalid');
    }
    if (entry.bindingKey !== expectedBindingKey || entry.hash !== expectedHash) {
      // Don't reveal which field mismatched
      throw makeErr(400, 'preview_token binding mismatch', 'preview_token_invalid');
    }
    previewTokens.delete(token); // 1-shot
  }

  /**
   * Fetch a pack JSON from a URL with full SSRF + size + content-type + parse pipeline.
   * Returns { canonicalUrl, displayUrl, pack, hash }
   * Throws on any violation.
   */
  async function fetchPackFromUrl(rawUrl) {
    // Canonicalize first (so subsequent error messages use canonical form)
    const { url: canonicalUrl, display: displayUrl } = canonicalizeUrl(rawUrl);

    const { bodyText, hash } = await fetchUrlSafe(canonicalUrl);

    let pack;
    try {
      pack = JSON.parse(bodyText);
    } catch (err) {
      throw makeErr(400, `Invalid JSON in response: ${err.message}`, 'invalid_json');
    }
    if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
      throw makeErr(400, 'Response is not a JSON object', 'invalid_schema');
    }
    if (!pack.name || typeof pack.name !== 'string') {
      throw makeErr(400, 'Pack missing required field: name', 'invalid_schema');
    }
    if (!pack.prompt_full || typeof pack.prompt_full !== 'string') {
      throw makeErr(400, 'Pack missing required field: prompt_full', 'invalid_schema');
    }

    return { canonicalUrl, displayUrl, pack, hash };
  }

  // Deprecated stub from v1.0 Stage 2 (central registry refresh) — removed in v1.1.
  // Kept as no-op for API compatibility with any legacy caller.
  async function refreshRemoteRegistry() {
    return { refreshed: false, reason: 'deprecated_in_v1_1' };
  }

  return {
    getRegistry,
    getRegistryPack,
    fetchPackFromUrl,
    issuePreviewToken,
    consumePreviewToken,
    refreshRemoteRegistry,
    // exposed for tests
    _previewTokens: previewTokens,
  };
}

function makeErr(status, message, code) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

module.exports = { createRegistryService };
