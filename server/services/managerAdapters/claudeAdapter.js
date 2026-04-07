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

const {
  NORMALIZED_EVENT_TYPES,
  RAW_EVENTS_ENABLED,
  buildPayload,
} = require('./eventTypes');

function createClaudeAdapter({ streamJsonEngine, runService }) {
  if (!streamJsonEngine) {
    throw new Error('claudeAdapter: streamJsonEngine is required');
  }

  // Per-run turn counter and pending tool_use bookkeeping for normalized events.
  // These are in-memory only — they reset on server restart, which is fine
  // because D1 forces all manager runs to 'stopped' on restart.
  const runState = new Map(); // runId -> { turnIndex, sessionEmitted, pendingTools: Map<id, name> }

  function getState(runId) {
    let s = runState.get(runId);
    if (!s) {
      s = { turnIndex: 0, sessionEmitted: false, pendingTools: new Map() };
      runState.set(runId, s);
    }
    return s;
  }

  function emitNormalized(runId, type, payload) {
    if (!runService) return;
    try {
      runService.addRunEvent(runId, type, JSON.stringify(payload));
    } catch (err) {
      // Don't let normalization errors break vendor event handling.
      console.warn(`[claudeAdapter] failed to emit ${type} for ${runId}: ${err.message}`);
    }
  }

  /**
   * Normalize a Claude vendor event into one or more normalized events.
   * Called by streamJsonEngine via the onVendorEvent hook BEFORE legacy
   * run_events writes happen, so we run alongside (dual emit) — D9: PR1c
   * will absorb the doubled event count via incremental polling.
   */
  function normalizeClaudeEvent(runId, event, proc) {
    const state = getState(runId);
    const turnIndex = state.turnIndex;

    if (RAW_EVENTS_ENABLED) {
      emitNormalized(runId, NORMALIZED_EVENT_TYPES.RAW_VENDOR_EVENT, buildPayload({
        turnIndex,
        summaryText: `${event.type}${event.subtype ? ':' + event.subtype : ''}`,
        hasRawStored: true,
        data: { event },
      }));
    }

    const type = event.type;
    const subtype = event.subtype;

    if (type === 'system' && subtype === 'init' && !state.sessionEmitted) {
      state.sessionEmitted = true;
      emitNormalized(runId, NORMALIZED_EVENT_TYPES.SESSION_STARTED, buildPayload({
        turnIndex,
        summaryText: `Claude session ${event.session_id || ''}`.trim(),
        hasRawStored: RAW_EVENTS_ENABLED,
        data: {
          sessionId: event.session_id || null,
          model: event.model || null,
          cwd: event.cwd || null,
        },
      }));
      return;
    }

    if (type === 'assistant') {
      const msg = event.message;
      if (!msg || !msg.content) return;
      const textParts = msg.content.filter(c => c.type === 'text').map(c => c.text);
      const text = textParts.join('\n').trim();
      const toolUses = msg.content.filter(c => c.type === 'tool_use');

      if (text) {
        emitNormalized(runId, NORMALIZED_EVENT_TYPES.ASSISTANT_MESSAGE, buildPayload({
          turnIndex,
          summaryText: text.length > 200 ? text.slice(0, 200) + '…' : text,
          hasRawStored: RAW_EVENTS_ENABLED,
          data: { text: text.slice(0, 5000) },
        }));
      }

      for (const tu of toolUses) {
        state.pendingTools.set(tu.id, tu.name);
        emitNormalized(runId, NORMALIZED_EVENT_TYPES.TOOL_CALL_STARTED, buildPayload({
          turnIndex,
          vendorItemId: tu.id,
          summaryText: `tool ${tu.name}`,
          hasRawStored: RAW_EVENTS_ENABLED,
          data: { name: tu.name, input: tu.input ? truncateForLog(tu.input) : null },
        }));
      }
      return;
    }

    if (type === 'user') {
      // tool_result blocks come back as user messages from Claude
      const msg = event.message;
      const blocks = (msg && Array.isArray(msg.content)) ? msg.content : [];
      for (const b of blocks) {
        if (b && b.type === 'tool_result') {
          const name = state.pendingTools.get(b.tool_use_id) || 'tool';
          state.pendingTools.delete(b.tool_use_id);
          // D7: store first 1KB only + size meta
          const raw = typeof b.content === 'string'
            ? b.content
            : JSON.stringify(b.content || '');
          const size = raw.length;
          const head = raw.slice(0, 1024);
          emitNormalized(runId, NORMALIZED_EVENT_TYPES.TOOL_CALL_FINISHED, buildPayload({
            turnIndex,
            vendorItemId: b.tool_use_id,
            summaryText: `tool ${name} done (${size}B)`,
            hasRawStored: RAW_EVENTS_ENABLED,
            data: {
              name,
              isError: !!b.is_error,
              outputHead: head,
              outputSize: size,
              truncated: size > 1024,
            },
          }));
        }
      }
      return;
    }

    if (type === 'result') {
      // D5: usage from the result event itself, falling back to proc.usage.
      // The hook fires BEFORE legacy handleEvent updates proc.usage, so reading
      // proc.usage alone would lag by one turn / be zero on the first turn.
      const evIn  = event.usage?.input_tokens;
      const evOut = event.usage?.output_tokens;
      const evCost = event.total_cost_usd;
      const inputTokens  = (evIn  != null) ? evIn  : (proc?.usage?.inputTokens  ?? 0);
      const outputTokens = (evOut != null) ? evOut : (proc?.usage?.outputTokens ?? 0);
      const costUsd      = (evCost != null) ? evCost : (proc?.usage?.costUsd ?? 0);

      emitNormalized(runId, NORMALIZED_EVENT_TYPES.USAGE, buildPayload({
        turnIndex,
        summaryText: `usage in=${inputTokens} out=${outputTokens}`,
        hasRawStored: RAW_EVENTS_ENABLED,
        data: { inputTokens, outputTokens, costUsd },
      }));

      const completedType = event.is_error
        ? NORMALIZED_EVENT_TYPES.TURN_FAILED
        : NORMALIZED_EVENT_TYPES.TURN_COMPLETED;
      emitNormalized(runId, completedType, buildPayload({
        turnIndex,
        summaryText: event.is_error ? 'turn failed' : 'turn completed',
        hasRawStored: RAW_EVENTS_ENABLED,
        data: {
          isError: !!event.is_error,
          stopReason: event.stop_reason || null,
          durationMs: event.duration_ms || null,
          numTurns: event.num_turns || null,
        },
      }));

      // Advance turn boundary so the next assistant message belongs to turnIndex+1.
      state.turnIndex += 1;
      state.pendingTools.clear();
      return;
    }
  }

  function truncateForLog(obj) {
    try {
      const s = JSON.stringify(obj);
      return s.length > 512 ? s.slice(0, 512) + '…' : s;
    } catch { return '[unserializable]'; }
  }

  function disposeNormalizerState(runId) {
    runState.delete(runId);
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
    // Reset normalizer state in case the runId is recycled.
    runState.delete(runId);
    const result = streamJsonEngine.spawnAgent(runId, {
      prompt,
      cwd,
      systemPrompt,
      permissionMode: permissionMode || 'bypassPermissions',
      allowedTools: allowedTools || ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
      model: model || undefined,
      isManager: true,
      onVendorEvent: (event, proc) => normalizeClaudeEvent(runId, event, proc),
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
  /**
   * Emit a normalized session_ended event once for this run, then forget state.
   * Idempotent — safe to call from both explicit dispose and the natural-exit
   * path in routes/manager.js.
   */
  function emitSessionEndedIfNeeded(runId, reason) {
    const state = runState.get(runId);
    if (!state) return;
    if (state.endedEmitted) {
      runState.delete(runId);
      return;
    }
    state.endedEmitted = true;
    emitNormalized(runId, NORMALIZED_EVENT_TYPES.SESSION_ENDED, buildPayload({
      turnIndex: state.turnIndex,
      summaryText: reason ? `session ended (${reason})` : 'session ended',
      hasRawStored: RAW_EVENTS_ENABLED,
      data: { reason: reason || null },
    }));
    runState.delete(runId);
  }

  function disposeSession(runId) {
    try { streamJsonEngine.kill(runId); } catch { /* ignore */ }
    emitSessionEndedIfNeeded(runId, 'dispose');
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
    emitSessionEndedIfNeeded,
    getUsage,
    getSessionId,
    detectExitCode,
    getOutput,
    // PR4 will add buildGuardrailsSection().
  };
}

module.exports = { createClaudeAdapter };
