/**
 * Manager adapter factory.
 *
 * PR1a: only the Claude adapter exists. The factory still resolves by type
 * so that PR3 (agent_profile_id) and PR4 (CodexAdapter) can plug in without
 * touching call sites.
 */

const { createClaudeAdapter } = require('./claudeAdapter');

function createManagerAdapterFactory({ streamJsonEngine }) {
  const claude = createClaudeAdapter({ streamJsonEngine });

  /**
   * Resolve an adapter for the given type.
   * PR1a: only 'claude-code' is supported. Unknown types fall back to claude
   *       to preserve current behavior — PR3 will turn this into a hard error
   *       once /start requires agent_profile_id.
   */
  function getAdapter(type) {
    if (!type || type === 'claude-code') return claude;
    return claude;
  }

  return {
    getAdapter,
    // Exposed for tests and lifecycle checks
    listAdapters() { return [claude]; },
  };
}

module.exports = { createManagerAdapterFactory };
