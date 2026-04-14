const path = require('node:path');
const fs = require('node:fs');

/**
 * Registry service — loads bundled skill pack registry.
 * Stage 2 will add remote fetch + merge.
 */
function createRegistryService() {
  const bundledPath = path.join(__dirname, '..', 'data', 'skill-pack-registry.json');

  let bundledRegistry = null;

  function loadBundled() {
    try {
      const raw = fs.readFileSync(bundledPath, 'utf-8');
      bundledRegistry = JSON.parse(raw);
      // Tag each pack with _source: "bundled"
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

  // Load on construction
  loadBundled();

  /**
   * Get the full registry (bundled-only in Stage 1).
   * Returns { source, categories, packs }
   */
  function getRegistry() {
    if (!bundledRegistry) loadBundled();
    return {
      source: 'bundled',
      categories: bundledRegistry.categories || [],
      packs: bundledRegistry.packs || [],
    };
  }

  /**
   * Get a single registry pack by registry_id.
   */
  function getRegistryPack(registryId) {
    if (!bundledRegistry) loadBundled();
    const packs = bundledRegistry.packs || [];
    return packs.find(p => p.registry_id === registryId) || null;
  }

  /**
   * Stub for Stage 2 — remote registry refresh.
   * IMPORTANT: When implementing Stage 2, any packs fetched from a remote
   * registry MUST have `_source: "remote"` set. This is a security invariant —
   * installFromRegistry gates on `_source === "remote"` to require
   * `confirmed_preview: true` before installation. Bundled packs are tagged
   * `_source: "bundled"` in loadBundled(). Failing to tag remote packs will
   * silently disable the preview gate.
   */
  async function refreshRemoteRegistry() {
    // Stage 2: implement remote fetch + cache + merge
    return { refreshed: false, reason: 'remote_not_configured' };
  }

  return {
    getRegistry,
    getRegistryPack,
    refreshRemoteRegistry,
  };
}

module.exports = { createRegistryService };
