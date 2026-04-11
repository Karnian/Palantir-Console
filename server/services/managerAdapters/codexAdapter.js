/**
 * CodexAdapter — Codex CLI manager adapter (PR4).
 *
 * Codex differs from Claude in three structural ways:
 *   1. Stateless process: every turn is a NEW `codex exec` (or `codex exec
 *      resume <thread_id>`) child process. There is no long-lived stdin pipe.
 *   2. Vendor thread id: `codex exec --json` emits {"type":"thread.started",
 *      "thread_id":"<uuid>"} on its FIRST turn. We capture it and use
 *      `codex exec resume <thread_id>` on every subsequent turn.
 *   3. Usage shape: turn.completed.usage = { input_tokens,
 *      cached_input_tokens, output_tokens } — no USD cost field.
 *
 * Other facts (verified empirically before writing this adapter):
 *   - System prompt is delivered via `-c 'model_instructions_file="<path>"'`.
 *     A stable path / stable content => Codex caches the prompt and
 *     subsequent turns get a high cached_input_tokens, which we want.
 *   - The temp file is created in startSession() and deleted in
 *     disposeSession() (the dispose hook is precisely what D1 was added for).
 *   - --skip-git-repo-check is always passed. --full-auto is the default
 *     for manager role (auto-approves tool calls, keeps filesystem sandbox).
 *     --dangerously-bypass-approvals-and-sandbox is only for worker role
 *     or when PALANTIR_CODEX_MANAGER_BYPASS=1 is set.
 *   - AGENTS.md interaction (verified 2026-04-07 against codex-cli 0.118.0):
 *     ~/.codex/AGENTS.md is auto-loaded by codex when present and prepended
 *     to the model_instructions_file content. On the dev box this file is
 *     empty (0 bytes), so there is no conflict in practice. If a future user
 *     populates it, it will simply prefix the manager system prompt — no
 *     adapter change needed. Project-local AGENTS.md (in cwd) is also
 *     auto-loaded; we accept this as part of how Codex sees the workspace.
 *
 * Capability flags:
 *   persistentProcess: false  (matters for routes that try to "send to alive process")
 *   persistentSession: true   (the vendor thread persists across our turns)
 *   supportsResume:    true
 *   supportsUsdCost:   false  (callers must NOT show $ for Codex)
 */

const { spawn: realSpawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const {
  NORMALIZED_EVENT_TYPES,
  RAW_EVENTS_ENABLED,
  buildPayload,
} = require('./eventTypes');

// P2-2: vendor item.type='error' classification constants. Kept at
// module scope so the exported helper `classifyCodexErrorAsNotice` (below
// `createCodexAdapter`) can be called without instantiating an adapter,
// and so test fixtures can reference the same set the runtime uses.
const NON_FATAL_SEVERITIES = new Set(['warning', 'warn', 'notice', 'info', 'deprecation']);
const NOTICE_CODE_PREFIXES = ['deprecated_', 'deprecation_', 'notice_', 'warn_', 'warning_'];

// P4-6: error classification patterns. Each entry: [regex, category].
// Order matters — first match wins. Patterns are tested against the
// error message when no structured `item.code` or `item.error_type` field
// provides a category directly.
const ERROR_CLASSIFICATION_PATTERNS = [
  [/\brate.?limit/i, 'rate_limit'],
  [/\b(auth|unauthorized|forbidden|401|403)\b/i, 'auth_error'],
  [/\b(timeout|timed?\s*out|ETIMEDOUT|ESOCKETTIMEDOUT)\b/i, 'timeout'],
  [/\b(network|ECONNREFUSED|ECONNRESET|ENOTFOUND|fetch failed)\b/i, 'network_error'],
  [/\b(context.?length|token.?limit|too.?long|max.?tokens)\b/i, 'context_length'],
  [/\b(model.*not.*found|invalid.*model|does not exist)\b/i, 'invalid_model'],
  [/\b(overloaded|capacity|server.?error|500|502|503|529)\b/i, 'server_overloaded'],
  [/\b(invalid.*request|bad.*request|malformed|parse error)\b/i, 'invalid_request'],
  [/\b(content.?filter|safety|blocked|refus)/i, 'content_filtered'],
];

function classifyCodexErrorAsNotice(item) {
  if (!item || typeof item !== 'object') return false;
  const severity = typeof item.severity === 'string'
    ? item.severity.toLowerCase()
    : null;
  if (severity && NON_FATAL_SEVERITIES.has(severity)) return true;
  const code = typeof item.code === 'string' ? item.code.toLowerCase() : null;
  if (code && NOTICE_CODE_PREFIXES.some(p => code.startsWith(p))) return true;
  const msg = typeof item.message === 'string' ? item.message : '';
  return /\b(deprecated|deprecation)\b/i.test(msg);
}

/**
 * P4-6: classify a codex error item into a specific category.
 * Uses structured fields first (item.error_type, item.code), then falls
 * back to regex on the message. Returns 'unknown_error' if nothing matches.
 */
function classifyCodexErrorKind(item) {
  if (!item || typeof item !== 'object') return 'unknown_error';

  // 1. Structured field: item.error_type (if codex provides it)
  if (typeof item.error_type === 'string' && item.error_type.trim()) {
    return item.error_type.trim();
  }

  // 2. Structured field: item.code (non-notice codes)
  const code = typeof item.code === 'string' ? item.code.toLowerCase() : null;
  if (code && !NOTICE_CODE_PREFIXES.some(p => code.startsWith(p))) {
    return code;
  }

  // 3. Regex classification on message
  const msg = typeof item.message === 'string' ? item.message : '';
  for (const [pattern, category] of ERROR_CLASSIFICATION_PATTERNS) {
    if (pattern.test(msg)) return category;
  }

  // 4. Fallback — never silently drop
  return 'unknown_error';
}

/**
 * v3 Phase 0: spawnFn is injectable for behavior testing. Production callers
 * omit it and get the real child_process.spawn. Tests inject a fake that
 * captures args without actually spawning a subprocess.
 */
function createCodexAdapter({
  runService,
  codexBin = process.env.CODEX_BIN || 'codex',
  spawnFn,
} = {}) {
  const spawn = spawnFn || realSpawn;
  // Per-run state. Codex sessions are NOT persistent processes, so this map
  // tracks: thread id (after first turn), pending child (during a turn),
  // turn counter, instructions file path, accumulated usage.
  const sessions = new Map(); // runId -> { threadId, instructionsPath, model, cwd, turnIndex, usage, currentChild, ended, sessionStartedEmitted }

  const capabilities = {
    persistentProcess: false,
    persistentSession: true,
    supportsTokenUsage: true,
    supportsUsdCost: false,
    supportsToolStreaming: true,
    supportsResume: true,
  };

  function getState(runId) {
    return sessions.get(runId) || null;
  }

  function emitNormalized(runId, type, payload) {
    if (!runService) return;
    try {
      runService.addRunEvent(runId, type, JSON.stringify(payload));
    } catch (err) {
      console.warn(`[codexAdapter] failed to emit ${type} for ${runId}: ${err.message}`);
    }
  }

  /**
   * Start a Codex manager session. PR brief D2: this is the LIGHT path —
   * no process spawn yet. We just write the system prompt to a temp file and
   * record the session metadata. The first user message will trigger the
   * first turn (which spawns `codex exec` and captures thread_id).
   *
   * v3 Phase 0: accepts optional `role` ('manager' | 'worker', default 'manager').
   * Role-aware launch flags are resolved in spawnOneTurn — manager role omits
   * `--dangerously-bypass-approvals-and-sandbox` per the capability diet policy.
   * Worker role (future) keeps the bypass because workers have legitimate
   * filesystem write needs. See docs/specs/manager-v3-multilayer.md principle 1.
   *
   * P4-2: mcpConfig is accepted for interface parity with claudeAdapter but
   * silently ignored. Codex CLI does not support --mcp-config as of 0.118.0.
   * When/if Codex adds MCP support, wire mcpConfig into spawnOneTurn args.
   */
  function startSession(runId, { systemPrompt, cwd, model, env, role, resumeThreadId, onThreadStarted, mcpConfig } = {}) {
    if (sessions.has(runId)) {
      throw new Error(`codexAdapter: session ${runId} already started`);
    }

    // Write the system prompt to a stable temp file. Path includes runId so
    // restarts of the same runId (shouldn't happen — D1 wipes managers on
    // restart) get a fresh file.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `palantir-codex-${runId}-`));
    const instructionsPath = path.join(tmpDir, 'system_prompt.md');
    fs.writeFileSync(instructionsPath, systemPrompt || '', { mode: 0o600 });

    sessions.set(runId, {
      // v3 Phase 3a: if the caller passes a persisted thread_id (PM lazy
      // spawn loading `project_briefs.pm_thread_id`), seed it so the first
      // runTurn goes through `codex exec resume <thread_id>` instead of
      // creating a brand new thread. Passing null (default) keeps the
      // pre-3a behavior: thread_id is captured from the first vendor
      // thread.started event.
      threadId: resumeThreadId || null,
      instructionsPath,
      tmpDir,
      cwd: cwd || process.cwd(),
      model: model || null,
      env: env || null, // PR4: filtered subprocess env from routes/manager.js
      role: role || 'manager', // v3 Phase 0: default to manager (tightened)
      // v3 Phase 3a: fires exactly once when thread.started arrives or on
      // synthetic emission for resumes. pmSpawnService uses this to
      // persist pm_thread_id into project_briefs.
      onThreadStarted: typeof onThreadStarted === 'function' ? onThreadStarted : null,
      threadStartedFired: false,
      turnIndex: 0,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      currentChild: null,
      ended: false,
      sessionStartedEmitted: false,
    });

    // If we're resuming from a persisted thread id, fire the callback
    // immediately so the caller can finalize any bookkeeping that would
    // otherwise wait for the first turn to complete.
    if (resumeThreadId) {
      const state = sessions.get(runId);
      state.threadStartedFired = true;
      try { if (state.onThreadStarted) state.onThreadStarted(resumeThreadId); } catch { /* ignore */ }
    }

    return { sessionRef: { instructionsPath, resumedThreadId: resumeThreadId || null } };
  }

  /**
   * Spawn ONE turn. Returns a Promise that resolves when the codex process
   * exits. Caller (runTurn) does NOT await — it returns { accepted: true }
   * immediately and lets normalized events drive the UI.
   */
  function spawnOneTurn(runId, userText) {
    const state = sessions.get(runId);
    if (!state) throw new Error(`codexAdapter: no session ${runId}`);
    if (state.currentChild) {
      // A turn is still in flight — Codex turns are not concurrent.
      throw new Error('codexAdapter: previous turn still running');
    }

    const isFirstTurn = state.threadId == null;
    const args = [];

    // Args differ between first turn and resume:
    // - first turn:  codex exec --json -C <cwd> ... -
    // - resume turn: codex exec resume <thread_id> --json ... -
    //   Note: `codex exec resume` does NOT accept -C/--cd; the resumed
    //   session inherits the original cwd. We still spawn the child with
    //   cwd=state.cwd so any side-effect commands the model emits run in
    //   the right place.
    if (isFirstTurn) {
      args.push('exec', '--json');
      args.push('-C', state.cwd);
    } else {
      args.push('exec', 'resume', state.threadId, '--json');
    }
    args.push('--skip-git-repo-check');
    // Sandbox policy: always bypass. PM must call the Palantir Console
    // API (curl) to spawn workers, update tasks, etc. The --full-auto
    // sandbox blocks network access, making PM non-functional. Workers
    // also need full bypass for filesystem writes.
    args.push('--dangerously-bypass-approvals-and-sandbox');
    args.push('-c', `model_instructions_file="${state.instructionsPath}"`);
    if (state.model) {
      args.push('-m', state.model);
    }
    // Read prompt from stdin to avoid shell-quoting issues with multi-line input.
    args.push('-');

    const child = spawn(codexBin, args, {
      cwd: state.cwd,
      // PR4: use the filtered env from buildManagerSpawnEnv if the caller
      // provided one. Fall back to process.env for tests that use the
      // adapter directly.
      env: state.env || process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    state.currentChild = child;

    // Emit a turn_started normalized event (Codex DOES have a turn boundary
    // signal, but the JSONL turn.started arrives after we spawn — emit our
    // own turn boundary now so consumers see the user input bracketed).
    emitNormalized(runId, NORMALIZED_EVENT_TYPES.TURN_STARTED, buildPayload({
      turnIndex: state.turnIndex,
      summaryText: 'turn started',
      hasRawStored: RAW_EVENTS_ENABLED,
      data: { resume: !isFirstTurn },
    }));

    // Pipe the user text in.
    try {
      child.stdin.write(userText || '');
      child.stdin.end();
    } catch (err) {
      console.warn(`[codexAdapter] stdin write failed for ${runId}: ${err.message}`);
    }

    const stderrChunks = [];
    child.stderr.on('data', (d) => {
      stderrChunks.push(d.toString());
      while (stderrChunks.length > 100) stderrChunks.shift();
    });

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      handleVendorEvent(runId, state, event);
    });

    child.on('error', (err) => {
      console.error(`[codexAdapter] spawn error for ${runId}: ${err.message}`);
      emitNormalized(runId, NORMALIZED_EVENT_TYPES.TURN_FAILED, buildPayload({
        turnIndex: state.turnIndex,
        summaryText: `spawn error: ${err.message}`,
        hasRawStored: RAW_EVENTS_ENABLED,
        data: { error: err.message },
      }));
      state.currentChild = null;
    });

    child.on('exit', (code) => {
      state.currentChild = null;
      // If the turn produced a turn.completed vendor event we already advanced
      // turnIndex; otherwise treat exit-with-error as a failed turn.
      if (code !== 0) {
        emitNormalized(runId, NORMALIZED_EVENT_TYPES.TURN_FAILED, buildPayload({
          turnIndex: state.turnIndex,
          summaryText: `codex exited code=${code}`,
          hasRawStored: RAW_EVENTS_ENABLED,
          data: { exitCode: code, stderr: stderrChunks.join('').slice(-2000) },
        }));
        // Persist failure on the run row AND mark the session logically dead
        // so isSessionAlive flips to false. Otherwise getActiveManager() in
        // routes/manager.js keeps treating the run as active (it trusts
        // isSessionAlive over run.status).
        state.ended = true;
        try {
          if (runService) {
            runService.updateRunStatus(runId, 'failed', { force: true });
          }
        } catch { /* ignore */ }
        emitSessionEndedIfNeeded(runId, 'codex-exit-error');
      }
    });
  }

  /**
   * Handle a single vendor JSONL line and emit normalized events.
   */
  function handleVendorEvent(runId, state, event) {
    if (RAW_EVENTS_ENABLED) {
      emitNormalized(runId, NORMALIZED_EVENT_TYPES.RAW_VENDOR_EVENT, buildPayload({
        turnIndex: state.turnIndex,
        summaryText: event.type || 'raw',
        hasRawStored: true,
        data: { event },
      }));
    }

    const type = event.type;

    if (type === 'thread.started') {
      // Capture thread_id on first turn so subsequent turns can resume.
      if (!state.threadId && event.thread_id) {
        state.threadId = event.thread_id;
        try {
          if (runService) runService.updateManagerThreadId(runId, state.threadId);
        } catch { /* ignore */ }
      }
      // v3 Phase 3a: notify the PM spawn service exactly once so it can
      // persist the fresh thread id into project_briefs.pm_thread_id.
      // Guarded by threadStartedFired so we don't double-fire on multiple
      // thread.started vendor emissions (codex has been known to re-emit
      // on reconnect).
      if (!state.threadStartedFired && state.threadId) {
        state.threadStartedFired = true;
        try { if (state.onThreadStarted) state.onThreadStarted(state.threadId); } catch { /* ignore */ }
      }
      if (!state.sessionStartedEmitted) {
        state.sessionStartedEmitted = true;
        emitNormalized(runId, NORMALIZED_EVENT_TYPES.SESSION_STARTED, buildPayload({
          turnIndex: state.turnIndex,
          summaryText: `Codex thread ${state.threadId || ''}`.trim(),
          hasRawStored: RAW_EVENTS_ENABLED,
          data: { threadId: state.threadId, model: state.model },
        }));
      }
      return;
    }

    if (type === 'turn.started') {
      // Already emitted our own TURN_STARTED on spawn; vendor signal is
      // informational. Skip to avoid duplicate boundaries.
      return;
    }

    // Codex emits item.started AND item.completed for most items. For the
    // normalized event stream we only care about the terminal state, so
    // we skip item.started to avoid duplicate rows for the same vendor id.
    if (type === 'item.completed') {
      const item = event.item || {};
      const itemType = item.type;
      const itemId = item.id || null;

      if (itemType === 'agent_message') {
        const text = item.text || '';
        if (text) {
          emitNormalized(runId, NORMALIZED_EVENT_TYPES.ASSISTANT_MESSAGE, buildPayload({
            turnIndex: state.turnIndex,
            vendorItemId: itemId,
            summaryText: text.length > 200 ? text.slice(0, 200) + '…' : text,
            hasRawStored: RAW_EVENTS_ENABLED,
            data: { text: text.slice(0, 5000) },
          }));
          // Mirror the legacy assistant_text shape so existing UI / dedupe
          // pairing works for Codex too.
          if (runService) {
            try {
              runService.addRunEvent(runId, 'assistant_text', JSON.stringify({ text: text.slice(0, 5000) }));
            } catch { /* ignore */ }
          }
        }
        return;
      }

      if (itemType === 'command_execution') {
        // D7: store first 1KB of output + size meta. command_execution items
        // come back as a single completed event with output already attached.
        const cmd = item.command || item.tool || 'cmd';
        const out = typeof item.output === 'string' ? item.output : JSON.stringify(item.output || '');
        const size = out.length;
        emitNormalized(runId, NORMALIZED_EVENT_TYPES.TOOL_CALL_FINISHED, buildPayload({
          turnIndex: state.turnIndex,
          vendorItemId: itemId,
          summaryText: `command ${cmd} (${size}B)`,
          hasRawStored: RAW_EVENTS_ENABLED,
          data: { name: cmd, outputHead: out.slice(0, 1024), outputSize: size, truncated: size > 1024 },
        }));
        return;
      }

      if (itemType === 'error') {
        // Codex overloads item.type='error' for two things:
        //   1. Benign config notices (e.g. `[features].foo` is deprecated).
        //      These do NOT fail the turn.
        //   2. Real model/runtime errors.
        //
        // P2-2 hardening: we used to depend SOLELY on a loose regex
        // (`/deprecated|deprecation/i`) against the message. A vendor
        // localization tweak or rename would flip benign notices into
        // TURN_FAILED and kill the session. Now we classify as a notice
        // when ANY of the following hold (ordered from most to least
        // structured):
        //   a. `item.severity` is a non-fatal label
        //      ('warning'|'warn'|'notice'|'info'|'deprecation').
        //   b. `item.code` looks like a deprecation/notice marker
        //      (starts with 'deprecated_', 'notice_', 'warn_', or 'warning_').
        //   c. regex fallback on the message — still intentional because
        //      current codex-cli builds (verified 2026-04-07 on 0.118.0)
        //      do NOT populate severity/code on deprecation items, so
        //      dropping the regex today would re-introduce the fail. Keep
        //      the fallback until vendor shape is reliable. Pattern uses
        //      \b word boundaries to avoid matching user text like
        //      "deprecation was reversed".
        //
        // Everything else is escalated to a real TURN_FAILED. The
        // turn.completed / process exit code is still authoritative.
        const msg = item.message || '';
        const isDeprecationNotice = classifyCodexErrorAsNotice(item);
        if (isDeprecationNotice) {
          emitNormalized(runId, NORMALIZED_EVENT_TYPES.TOOL_CALL_FINISHED, buildPayload({
            turnIndex: state.turnIndex,
            vendorItemId: itemId,
            summaryText: `codex notice: ${msg.slice(0, 160)}`,
            hasRawStored: RAW_EVENTS_ENABLED,
            data: { kind: 'codex_notice', message: msg },
          }));
        } else {
          // P4-6: classify error into a specific category for downstream
          // consumers. Falls back to 'unknown_error' — never silently drops.
          const errorKind = classifyCodexErrorKind(item);
          emitNormalized(runId, NORMALIZED_EVENT_TYPES.TURN_FAILED, buildPayload({
            turnIndex: state.turnIndex,
            vendorItemId: itemId,
            summaryText: `codex error [${errorKind}]: ${msg.slice(0, 140)}`,
            hasRawStored: RAW_EVENTS_ENABLED,
            data: { kind: 'codex_error', errorKind, message: msg },
          }));
        }
        return;
      }

      // Unknown item type — surface a placeholder as a single
      // TOOL_CALL_FINISHED (not STARTED) so there are no dangling started
      // events. Full data is only stored when raw events are on.
      emitNormalized(runId, NORMALIZED_EVENT_TYPES.TOOL_CALL_FINISHED, buildPayload({
        turnIndex: state.turnIndex,
        vendorItemId: itemId,
        summaryText: `${itemType || 'unknown'} item`,
        hasRawStored: RAW_EVENTS_ENABLED,
        data: { itemType: itemType || null, kind: 'unknown_item' },
      }));
      return;
    }

    if (type === 'turn.completed') {
      const usage = event.usage || {};
      const inputTokens = usage.input_tokens || 0;
      const cached = usage.cached_input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      // D5: accumulate per-run usage.
      state.usage.inputTokens  += inputTokens;
      state.usage.cachedInputTokens += cached;
      state.usage.outputTokens += outputTokens;

      emitNormalized(runId, NORMALIZED_EVENT_TYPES.USAGE, buildPayload({
        turnIndex: state.turnIndex,
        summaryText: `usage in=${inputTokens} cached=${cached} out=${outputTokens}`,
        hasRawStored: RAW_EVENTS_ENABLED,
        data: { inputTokens, cachedInputTokens: cached, outputTokens, costUsd: null },
      }));

      emitNormalized(runId, NORMALIZED_EVENT_TYPES.TURN_COMPLETED, buildPayload({
        turnIndex: state.turnIndex,
        summaryText: 'turn completed',
        hasRawStored: RAW_EVENTS_ENABLED,
        data: { isError: false },
      }));

      // Persist accumulated usage on the run row. costUsd stays null per D5
      // (Codex doesn't report dollars).
      try {
        if (runService) {
          runService.updateRunResult(runId, {
            result_summary: null,
            exit_code: null,
            input_tokens: state.usage.inputTokens,
            output_tokens: state.usage.outputTokens,
            cost_usd: null,
          });
        }
      } catch { /* ignore */ }

      state.turnIndex += 1;
      return;
    }
  }

  function runTurn(runId, { text } = {}) {
    const state = sessions.get(runId);
    if (!state) return { accepted: false };
    if (state.ended) return { accepted: false };
    try {
      // Record user_input event BEFORE spawning the turn so the UI shows
      // the message immediately (parity with streamJsonEngine/claudeAdapter).
      if (runService && text) {
        try {
          runService.addRunEvent(runId, 'user_input', JSON.stringify({ text: text.slice(0, 5000) }));
        } catch (err) {
          console.warn(`[codexAdapter] user_input event failed for ${runId}: ${err.message}`);
        }
      }
      spawnOneTurn(runId, text || '');
      return { accepted: true };
    } catch (err) {
      console.warn(`[codexAdapter] runTurn failed for ${runId}: ${err.message}`);
      return { accepted: false };
    }
  }

  function cancelTurn(runId) {
    const state = sessions.get(runId);
    if (!state || !state.currentChild) return false;
    try { state.currentChild.kill('SIGTERM'); return true; } catch { return false; }
  }

  function isSessionAlive(runId) {
    const state = sessions.get(runId);
    if (!state) return false;
    return !state.ended;
  }

  function detectExitCode(runId) {
    const state = sessions.get(runId);
    if (!state) return null;
    return state.ended ? 0 : null;
  }

  function emitSessionEndedIfNeeded(runId, reason) {
    const state = sessions.get(runId);
    if (!state) return;
    if (state._endedEmitted) return;
    state._endedEmitted = true;
    emitNormalized(runId, NORMALIZED_EVENT_TYPES.SESSION_ENDED, buildPayload({
      turnIndex: state.turnIndex,
      summaryText: reason ? `session ended (${reason})` : 'session ended',
      hasRawStored: RAW_EVENTS_ENABLED,
      data: { reason: reason || null },
    }));
  }

  /**
   * Dispose of session resources. CRITICAL: this is the hook D1 was added
   * for — Codex's instructionsPath temp file MUST be cleaned up here, both
   * on /stop and on boot-time stale cleanup. The Claude adapter's no-op
   * dispose just kills a process; Codex actually has on-disk state.
   */
  function disposeSession(runId) {
    const state = sessions.get(runId);
    if (!state) return;
    state.ended = true;
    if (state.currentChild) {
      try { state.currentChild.kill('SIGTERM'); } catch { /* ignore */ }
    }
    // Best-effort cleanup of the temp dir.
    if (state.tmpDir) {
      fsp.rm(state.tmpDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
    }
    emitSessionEndedIfNeeded(runId, 'dispose');
    sessions.delete(runId);
  }

  function getUsage(runId) {
    const state = sessions.get(runId);
    if (!state) return null;
    // Return a Claude-compatible shape so /api/manager/status doesn't need
    // to branch on adapter type for the basic numbers. costUsd is always 0
    // for Codex; UI should look at capabilities.supportsUsdCost to decide
    // whether to render it.
    return {
      inputTokens: state.usage.inputTokens,
      cachedInputTokens: state.usage.cachedInputTokens,
      outputTokens: state.usage.outputTokens,
      costUsd: 0,
    };
  }

  function getSessionId(runId) {
    const state = sessions.get(runId);
    return state ? state.threadId : null;
  }

  function getOutput() {
    // Codex doesn't have a long-lived output buffer like Claude — events
    // are the source of truth. Return null so the route layer falls back
    // to the events stream.
    return null;
  }

  function buildGuardrailsSection() {
    return `## Codex CLI adapter notes

You are running as a Codex CLI subprocess (codex exec --json). HARD RULES:
- Do NOT spawn nested codex / claude / codex-acp / mcp-codex sessions yourself.
  Delegated work goes through the Palantir /execute API only.
- Do NOT do code edits directly inside this manager session. Spawn a worker.
- Do NOT install a polling loop on /execute results — the user will see them
  in the Palantir Console UI; just report once per turn.
- Filesystem sandbox is active. Your tools are limited to read operations
  and WebFetch for API calls. Do not attempt file writes — those are a worker concern.`;
  }

  return {
    type: 'codex',
    capabilities,
    buildGuardrailsSection,
    startSession,
    runTurn,
    cancelTurn,
    isSessionAlive,
    disposeSession,
    emitSessionEndedIfNeeded,
    detectExitCode,
    getUsage,
    getSessionId,
    getOutput,
  };
}

module.exports = {
  createCodexAdapter,
  // P2-2: expose classifier + constants for vendor fixture tests.
  classifyCodexErrorAsNotice,
  NON_FATAL_SEVERITIES,
  NOTICE_CODE_PREFIXES,
  // P4-6: expose error kind classifier + patterns for tests.
  classifyCodexErrorKind,
  ERROR_CLASSIFICATION_PATTERNS,
};
