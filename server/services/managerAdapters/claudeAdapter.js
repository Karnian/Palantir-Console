/**
 * ClaudeAdapter — wraps streamJsonEngine to satisfy the ManagerAdapter interface.
 *
 * PR1a: behavior-preserving wrapper. No new events, no capability branching.
 *       Routes simply call adapter methods instead of streamJsonEngine directly.
 *
 * The adapter does NOT yet emit normalized events (PR1b) and does NOT
 * implement runTurn semantics for stateless engines (PR1b/PR4 — Codex).
 * For PR1a we only expose the methods routes/manager.js needs today.
 */

function createClaudeAdapter({ streamJsonEngine }) {
  if (!streamJsonEngine) {
    throw new Error('claudeAdapter: streamJsonEngine is required');
  }

  const capabilities = {
    persistentProcess: true,
    persistentSession: true,
    supportsTokenUsage: true,
    supportsUsdCost: true,
    supportsToolStreaming: true,
    supportsResume: false,
  };

  /**
   * Start a manager session.
   * Returns { sessionRef } where sessionRef is the spawn result (pid, etc).
   */
  function startSession(runId, { prompt, cwd, systemPrompt, model, allowedTools, permissionMode }) {
    const result = streamJsonEngine.spawnAgent(runId, {
      prompt,
      cwd,
      systemPrompt,
      permissionMode: permissionMode || 'bypassPermissions',
      allowedTools: allowedTools || ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
      model: model || undefined,
      isManager: true,
    });
    return { sessionRef: result };
  }

  /**
   * Send a user message to the running manager session.
   * For Claude: sends via stdin to the persistent process.
   *
   * Returns { accepted: bool }.
   */
  function runTurn(runId, { text, images } = {}) {
    const accepted = streamJsonEngine.sendInput(runId, text || '', images);
    return { accepted };
  }

  function cancelTurn(runId) {
    // Claude stream-json mode does not support per-turn cancel today.
    // Best we can do is signal the process; routes/manager.js currently uses kill() in /stop.
    return false;
  }

  function isSessionAlive(runId) {
    return streamJsonEngine.isAlive(runId);
  }

  /**
   * Dispose of any external resources held for this session.
   * For Claude: kill the persistent subprocess if alive.
   * No temp files to clean today, but Codex (PR4) will use this hook.
   */
  function disposeSession(runId) {
    try { streamJsonEngine.kill(runId); } catch { /* ignore */ }
  }

  function getUsage(runId) {
    return streamJsonEngine.getUsage(runId);
  }

  function getSessionId(runId) {
    return streamJsonEngine.getSessionId(runId);
  }

  /**
   * Detect natural exit (used by routes/manager.js to transition stale runs).
   * Exposed so routes don't need to know which engine backs the adapter.
   */
  function detectExitCode(runId) {
    return streamJsonEngine.detectExitCode(runId);
  }

  function getOutput(runId, lines) {
    return streamJsonEngine.getOutput(runId, lines);
  }

  return {
    type: 'claude-code',
    capabilities,
    startSession,
    runTurn,
    cancelTurn,
    isSessionAlive,
    disposeSession,
    getUsage,
    getSessionId,
    detectExitCode,
    getOutput,
    // PR4 will add buildGuardrailsSection().
  };
}

module.exports = { createClaudeAdapter };
