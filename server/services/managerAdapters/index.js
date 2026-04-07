/**
 * Manager adapter factory.
 *
 * PR1a: only the Claude adapter exists. The factory still resolves by type
 * so that PR3 (agent_profile_id) and PR4 (CodexAdapter) can plug in without
 * touching call sites.
 */

const { createClaudeAdapter } = require('./claudeAdapter');
const { createCodexAdapter } = require('./codexAdapter');

function createManagerAdapterFactory({ streamJsonEngine, runService, codexBin }) {
  const claude = createClaudeAdapter({ streamJsonEngine, runService });
  const codex = createCodexAdapter({ runService, codexBin });

  /**
   * Resolve an adapter for the given type.
   * PR3: now strict. The router gates by PROFILE_TYPE_TO_ADAPTER first, so
   * by the time we get here we expect a known type. Unknown types throw so
   * misconfiguration cannot silently fall through to Claude.
   *
   * Backward compat: undefined/null still maps to claude-code so the
   * boot-time stale-cleanup loop in routes/manager.js (which sees rows
   * predating migration 005 with NULL manager_adapter) works.
   */
  function getAdapter(type) {
    if (type == null || type === 'claude-code') return claude;
    if (type === 'codex') return codex;
    throw new Error(`Unknown manager adapter type: ${type}`);
  }

  return {
    getAdapter,
    // Exposed for tests and lifecycle checks
    listAdapters() { return [claude, codex]; },
  };
}

module.exports = { createManagerAdapterFactory };
