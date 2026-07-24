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
 *   - The temp file is placed lazily on the first runTurn() and deleted in
 *     disposeSession() (the dispose hook is precisely what D1 was added for).
 *   - --skip-git-repo-check is always passed. --full-auto is the default
 *     for manager role (auto-approves tool calls, keeps filesystem sandbox).
 *     --dangerously-bypass-approvals-and-sandbox is only for worker role
 *     or when PALANTIR_CODEX_MANAGER_BYPASS=1 is set.
 *   - AGENTS.md interaction (verified 2026-04-20 against codex-cli 0.120.0):
 *     ~/.codex/AGENTS.md is auto-loaded by codex when present and prepended
 *     to the model_instructions_file content. On the dev box this file is
 *     empty (0 bytes), so there is no conflict in practice. If a future user
 *     populates it, it will simply prefix the manager system prompt — no
 *     adapter change needed. Project-local AGENTS.md (in cwd) is also
 *     auto-loaded; we accept this as part of how Codex sees the workspace.
 *   - MCP injection (M1, verified 2026-04-20 against codex-cli 0.120.0):
 *     `-c mcp_servers.<alias>.<key>=<TOML-value>` dotted-path overrides land
 *     in the same merged config as ~/.codex/config.toml. The earlier
 *     `-c mcp_servers=<JSON>` form is rejected with "invalid type: string,
 *     expected a map" and MUST NOT be re-introduced. See codexMcpFlatten.js.
 *
 * Capability flags:
 *   persistentProcess: false  (matters for routes that try to "send to alive process")
 *   persistentSession: true   (the vendor thread persists across our turns)
 *   supportsResume:    true
 *   supportsUsdCost:   false  (callers must NOT show $ for Codex)
 */

const { spawn: realSpawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { assertSpawnAllowed } = require('../../utils/spawnGuard');

const {
  NORMALIZED_EVENT_TYPES,
  RAW_EVENTS_ENABLED,
  buildPayload,
} = require('./eventTypes');
const {
  prepareCodexMcpArgs,
  removeSecretDirWithRetry,
  validateCodexMcpSecretTransport,
} = require('./codexMcpSecretTransport');
const {
  scanCodexUserConfigAliases,
  detectLegacyAliasConflicts,
  resolveCodexUserConfigPath,
} = require('./codexUserConfigScan');
const { resolveSpawnCwd } = require('../../utils/spawnCwd');

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

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * F-1: resolve the Codex service tier for a turn.
 *
 * Priority (spec docs/specs/codex-fast-mode-brief.md §3):
 *   operator_instances.fast_mode (1=fast, 0=standard, NULL=unset)
 *     → PALANTIR_CODEX_FAST env (global default, unset/≠'1' = standard)
 *
 * NULL/undefined MUST be checked BEFORE any numeric coercion — Number(null)
 * is 0, which would silently pin an unset instance to standard and skip the
 * env fallback. Returns 'fast' | 'default'. Callers ALWAYS emit the result
 * explicitly so the user's ~/.codex/config.toml service_tier never leaks into
 * a Palantir-spawned codex (the drift this feature exists to close).
 */
function resolveCodexServiceTier(fastMode, { env = process.env } = {}) {
  let fast;
  if (fastMode === null || fastMode === undefined) {
    fast = env.PALANTIR_CODEX_FAST === '1';
  } else {
    fast = Number(fastMode) === 1;
  }
  return fast ? 'fast' : 'default';
}

function createDefaultLocalExecutor({ runId, spawnImpl }) {
  let lastTmpDir = null;
  return {
    // SYNC on purpose: the local default path must place the instructions file
    // and reach the spawn WITHOUT yielding a microtask, so existing tests that
    // call runTurn() and inspect the captured spawn args SYNCHRONOUSLY still
    // pass (byte-equivalence with the pre-S3a sync fs.writeFileSync path). A
    // remote executor's putSecretFile is async — spawnOneTurn awaits only when
    // the result is thenable.
    putSecretFile(name, content, mode = 0o600) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `palantir-codex-${runId}-`));
      lastTmpDir = tmpDir;
      const filePath = path.join(tmpDir, name);
      try {
        fs.writeFileSync(filePath, content, { mode });
        return filePath;
      } catch (err) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        if (lastTmpDir === tmpDir) lastTmpDir = null;
        throw err;
      }
    },
    resolveNodeRuntime() {
      return process.execPath;
    },
    spawnInteractive(command, args, { cwd, env } = {}) {
      return spawnImpl(command, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    },
    async rmrf(targetPath) {
      await fsp.rm(targetPath || lastTmpDir, { recursive: true, force: true });
    },
  };
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
    const invocationId = sessions.get(runId)?.currentInvocationId;
    if (invocationId && [
      NORMALIZED_EVENT_TYPES.TURN_STARTED,
      NORMALIZED_EVENT_TYPES.TURN_COMPLETED,
      NORMALIZED_EVENT_TYPES.TURN_FAILED,
    ].includes(type)) {
      payload = {
        ...payload,
        data: { ...(payload?.data || {}), invocationId },
      };
    }
    try {
      runService.addRunEvent(runId, type, JSON.stringify(payload));
    } catch (err) {
      console.warn(`[codexAdapter] failed to emit ${type} for ${runId}: ${err.message}`);
    }
  }

  /**
   * Start a Codex manager session. PR brief D2: this is the LIGHT path —
   * no process spawn yet. We just record the session metadata. The first user
   * message will lazily place the system prompt through the session executor,
   * spawn `codex exec`, and capture thread_id.
   *
   * v3 Phase 0: accepts optional `role` ('manager' | 'worker', default 'manager').
   * Role-aware launch flags are resolved in spawnOneTurn — manager role omits
   * `--dangerously-bypass-approvals-and-sandbox` per the capability diet policy.
   * Worker role (future) keeps the bypass because workers have legitimate
   * filesystem write needs. See docs/specs/manager-v3-multilayer.md principle 1.
   *
   * M1 (supersedes P4-2 note): object-shaped mcpConfig is consumed. Codex
   * 0.120.0 has no `--mcp-config` flag, but `-c
   * mcp_servers.<alias>.<key>=<TOML>` dotted-path overrides land in the same
   * merged config as the user's ~/.codex/config.toml. We persist only plain
   * object shapes on the session and prepare non-secret leaf args on the first
   * turn via codexMcpSecretTransport. String config paths are for the
   * Claude adapter's `--mcp-config` path and are skipped here.
   */
  function startSession(runId, { systemPrompt, cwd, model, reasoning_effort, env, role, resumeThreadId, onThreadStarted, mcpConfig, executor, nodePrefix, serviceTier } = {}) {
    if (sessions.has(runId)) {
      throw new Error(`codexAdapter: session ${runId} already started`);
    }

    const sessionExecutor = executor || createDefaultLocalExecutor({ runId, spawnImpl: spawn });

    const hasPlainObjectMcpConfig = isPlainObject(mcpConfig);
    const skippedMcpConfigPath = typeof mcpConfig === 'string';

    sessions.set(runId, {
      runId,
      // v3 Phase 3a: if the caller passes a persisted thread_id (PM lazy
      // spawn loading `project_briefs.pm_thread_id`), seed it so the first
      // runTurn goes through `codex exec resume <thread_id>` instead of
      // creating a brand new thread. Passing null (default) keeps the
      // pre-3a behavior: thread_id is captured from the first vendor
      // thread.started event.
      threadId: resumeThreadId || null,
      systemPrompt: systemPrompt || '',
      instructionsPath: null,
      instructionsDir: null,
      executor: sessionExecutor,
      nodePrefix: nodePrefix || null,
      usingDefaultLocalExecutor: !executor,
      usingRealSpawn: spawn === realSpawn,
      cwd: resolveSpawnCwd({ workspaceDir: cwd }),
      model: model || null,
      effort: reasoning_effort || null,
      env: env || null, // PR4: filtered subprocess env from routes/manager.js
      role: role || 'manager', // v3 Phase 0: default to manager (tightened)
      // v3 Phase 3a: fires exactly once when thread.started arrives or on
      // synthetic emission for resumes. operatorSpawnService uses this to
      // persist pm_thread_id into project_briefs.
      onThreadStarted: typeof onThreadStarted === 'function' ? onThreadStarted : null,
      threadStartedFired: false,
      // M1: merged MCP config to flatten into -c flags per turn. null means
      // "no MCP injection" (empty object behaves the same). Only plain object
      // shapes are accepted; path strings belong to Claude's --mcp-config path.
      mcpConfig: hasPlainObjectMcpConfig ? mcpConfig : null,
      // Issue #113: env-bearing stdio aliases are prepared once into a mode-0600
      // wrapper on the execution node. The resulting non-secret -c args and
      // secret dirs stay stable across initial + resume turns.
      mcpArgs: null,
      mcpSecretDirs: [],
      pendingCleanupDirs: [],
      cleanupPromise: null,
      disposeRequested: false,
      // F-1: Codex Fast Mode. May be a static string ('fast'|'default', resolved
      // once by the caller — Top uses this with an env-derived tier) OR a
      // function returning 'fast'|'default' per turn (Operators pass a resolver
      // that re-reads operator_instances.fast_mode, so a live toggle takes
      // effect on the NEXT turn without a re-spawn). Unset → 'default' (we ALWAYS
      // emit a tier so the user's ~/.codex/config.toml value never leaks in).
      serviceTier: serviceTier || 'default',
      turnIndex: 0,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      currentChild: null,
      turnStarting: false,
      ended: false,
      sessionStartedEmitted: false,
    });

    if (skippedMcpConfigPath && runService && typeof runService.addRunEvent === 'function') {
      try {
        runService.addRunEvent(runId, 'mcp:config_path_skipped', JSON.stringify({ adapter: 'codex' }));
      } catch (err) {
        console.warn(`[codexAdapter] failed to emit mcp:config_path_skipped for ${runId}: ${err.message}`);
      }
    }

    // If we're resuming from a persisted thread id, fire the callback
    // immediately so the caller can finalize any bookkeeping that would
    // otherwise wait for the first turn to complete.
    if (resumeThreadId) {
      const state = sessions.get(runId);
      state.threadStartedFired = true;
      try { if (state.onThreadStarted) state.onThreadStarted(resumeThreadId); } catch { /* ignore */ }
    }

    // M2: legacy alias conflict detection. Emit once at startSession so the
    // event lands even before the first turn spawns. Source is fixed to
    // 'pm_config' because the PM path receives a single pre-merged
    // mcpConfig and cannot split it back into preset / project /
    // skillpack. Annotate-only — Codex will still leaf-merge user config
    // at spawn; preset author just sees the drift warning. Event payload
    // shape `{ alias, source, message }` matches the worker path so event
    // consumers can treat both uniformly (M2 review cardinality rule).
    if (mcpConfig && runService) {
      try {
        const resolvedConfigPath = resolveCodexUserConfigPath();
        const userAliases = scanCodexUserConfigAliases(resolvedConfigPath);
        const conflicts = detectLegacyAliasConflicts(mcpConfig, userAliases, {
          perAliasSource: () => 'pm_config',
          configPath: resolvedConfigPath,
        });
        for (const c of conflicts) {
          try {
            runService.addRunEvent(runId, 'mcp:legacy_alias_conflict', JSON.stringify({
              alias: c.alias,
              source: c.source,
              message: c.message,
            }));
          } catch { /* ignore */ }
        }
      } catch (err) {
        console.warn(`[codexAdapter] legacy alias scan failed for ${runId}: ${err.message}`);
      }
    }

    return {
      sessionRef: {
        // The executor may be remote, so placement is lazy on first runTurn.
        instructionsPath: null,
        resumedThreadId: resumeThreadId || null,
      },
    };
  }

  /**
   * Spawn ONE turn. Returns a Promise that resolves when the codex process
   * has been spawned and wired. It does not wait for the Codex process to
   * exit; normalized events still drive the UI after acceptance.
   */
  async function spawnOneTurn(runId, userText, { source } = {}) {
    const state = sessions.get(runId);
    if (!state) throw new Error(`codexAdapter: no session ${runId}`);
    if (state.currentChild || state.turnStarting) {
      // A turn is still in flight — Codex turns are not concurrent.
      throw new Error('codexAdapter: previous turn still running');
    }

    // F-1: resolve the effective service tier for THIS turn. state.serviceTier
    // is either a function (re-read per turn) or a static string. Batch turns
    // (source==='auto_review') are forced to 'default' regardless — an
    // auto-review turn runs on every worker harvest and must never cost 2.5×.
    let baseTier = 'default';
    try {
      baseTier = (typeof state.serviceTier === 'function' ? state.serviceTier() : state.serviceTier);
    } catch { baseTier = 'default'; }
    if (baseTier !== 'fast') baseTier = 'default';
    const effectiveTier = ['auto_review', 'scheduled', 'manual_run_now'].includes(source) ? 'default' : baseTier;
    // Track the tier of the in-flight turn so the terminal failure handlers can
    // annotate a fast-tier turn that died (observability only, v1 has no
    // fallback retry — see spec §3 "가드/관측"). Reset the per-turn emit guard.
    state.currentTurnTier = effectiveTier;
    state._fastUnavailEmitted = false;

    state.turnStarting = true;
    let placedInstructionsDirThisTurn = null;
    const placedMcpDirsThisTurn = [];
    try {
      if (!state.instructionsPath) {
        // Conditional await: a remote executor returns a Promise; the default
        // local executor returns the path SYNCHRONOUSLY so the spawn below is
        // reached without a microtask yield (keeps sync arg-inspection tests
        // green). Do NOT make this an unconditional `await`.
        const placed = state.executor.putSecretFile('system_prompt.md', state.systemPrompt || '', 0o600);
        state.instructionsPath = (placed && typeof placed.then === 'function') ? await placed : placed;
        state.instructionsDir = path.dirname(state.instructionsPath);
        placedInstructionsDirThisTurn = state.instructionsDir;
      }
      if (state.ended) {
        state.turnStarting = false;
        await cleanupExecutorDirs(state, [placedInstructionsDirThisTurn]);
        return;
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
    // F-1: ALWAYS emit the resolved service tier as a leaf `-c` override so the
    // user's ~/.codex/config.toml service_tier never leaks into a Palantir turn.
    // `-c` is per-invocation and is NOT baked into the vendor thread state, so
    // this is resume-safe (verified on codex-cli 0.142.5) and does not disturb
    // the model_instructions_file prompt cache. When fast, also enable the
    // feature flag so a config that hasn't set features.fast_mode still routes.
    args.push('-c', `service_tier="${effectiveTier}"`);
    if (effectiveTier === 'fast') {
      args.push('-c', 'features.fast_mode=true');
    }
    if (state.model) {
      args.push('-m', state.model);
    }
    if (state.effort) {
      args.push('-c', `model_reasoning_effort="${state.effort}"`);
    }
    // M1: inject merged MCP config as leaf-level `-c mcp_servers.<alias>.<key>=<TOML>`
    // overrides. These must come BEFORE `-` (the stdin sentinel) — codex's
    // arg parser treats everything after `-` as prompt input.
    //
    // Fail-closed on invalid input (per Codex M1 review): silently dropping
    // the MCP block would let an Operator run proceed without tools a preset
    // declared required. Emit TURN_FAILED + SESSION_ENDED, mark the run
    // failed, and re-throw so runTurn returns { accepted: false } to its
    // caller (routes/manager.js).
    //
    // M4-a note: when state.mcpConfig becomes an object that includes
    // `http`-transport aliases (cfg.url present), the worker path runs a
    // HEAD-based preflight before flatten via `mcpPreflight.preflightHttpMcpConfig`
    // (lifecycleService.executeTask). The PM path here doesn't currently
    // receive object-shaped mcpConfig (operatorSpawnService passes the
    // project.mcp_config_path string, which startSession skips before this
    // point), so preflight is a no-op in current production. If the PM
    // path is ever re-plumbed to read+parse that file into an object,
    // extend this site with the same preflight call before flatten —
    // spec §L6 fail-closed contract applies.
    if (state.mcpConfig) {
      try {
        if (state.mcpArgs === null) {
          const prepared = prepareCodexMcpArgs(state.mcpConfig, {
            putSecretFile: typeof state.executor.putSecretFile === 'function'
              ? state.executor.putSecretFile.bind(state.executor)
              : undefined,
            onSecretPlaced(secretPath) {
              const secretDir = path.dirname(secretPath);
              if (!state.mcpSecretDirs.includes(secretDir)) state.mcpSecretDirs.push(secretDir);
              if (!placedMcpDirsThisTurn.includes(secretDir)) placedMcpDirsThisTurn.push(secretDir);
            },
            resolveWrapperCommand() {
              if (typeof state.executor.resolveNodeRuntime === 'function') {
                return state.executor.resolveNodeRuntime({ pathPrefix: state.nodePrefix });
              }
              if (state.nodePrefix) {
                throw new Error(
                  'codexMcpSecretTransport: remote executor must resolve its Node.js runtime',
                );
              }
              return process.execPath;
            },
          });
          const resolved = (prepared && typeof prepared.then === 'function') ? await prepared : prepared;
          state.mcpArgs = resolved.args;
        }
      } catch (err) {
        emitNormalized(runId, NORMALIZED_EVENT_TYPES.TURN_FAILED, buildPayload({
          turnIndex: state.turnIndex,
          summaryText: `mcpConfig invalid: ${err.message}`,
          hasRawStored: RAW_EVENTS_ENABLED,
          data: { kind: 'mcp_invalid', error: err.message, terminal: true },
        }));
        state.ended = true;
        try {
          if (runService) runService.updateRunStatus(runId, 'failed', { force: true });
        } catch { /* ignore */ }
        state.exitCode = 1;
        emitSessionEndedIfNeeded(runId, 'mcp-invalid');
        throw new Error(`codexAdapter: mcpConfig prepare failed: ${err.message}`);
      }
      if (state.ended) {
        state.turnStarting = false;
        await cleanupExecutorDirs(state, [placedInstructionsDirThisTurn, ...placedMcpDirsThisTurn]);
        return;
      }
      if (state.mcpArgs.length) args.push(...state.mcpArgs);
    }
    // Read prompt from stdin to avoid shell-quoting issues with multi-line input.
    args.push('-');

    if (state.usingDefaultLocalExecutor && state.usingRealSpawn) {
      try {
        assertSpawnAllowed({ command: codexBin, source: 'codexAdapter:exec' });
      } catch (err) {
        emitNormalized(runId, NORMALIZED_EVENT_TYPES.TURN_FAILED, buildPayload({
          turnIndex: state.turnIndex,
          summaryText: `spawn error: ${err.message}`,
          hasRawStored: RAW_EVENTS_ENABLED,
          data: { kind: 'spawn_blocked', error: err.message, terminal: true },
        }));
        state.ended = true;
        state.exitCode = 1;
        try {
          if (runService) runService.updateRunStatus(runId, 'failed', { force: true });
        } catch { /* ignore */ }
        emitSessionEndedIfNeeded(runId, 'spawn-blocked');
        throw err;
      }
    }
    // Conditional await (see putSecretFile note): local spawnInteractive returns
    // the child synchronously so the fake spawn is invoked in this sync frame;
    // remote returns a Promise<child>.
    const spawned = state.executor.spawnInteractive(codexBin, args, {
      cwd: state.cwd,
      // PR4: use the filtered env from buildManagerSpawnEnv if the caller
      // provided one. Only the default local executor inherits process.env;
      // injected executors must receive an explicit env object.
      env: state.usingDefaultLocalExecutor ? (state.env || process.env) : (state.env || {}),
      pathPrefix: state.nodePrefix,
    });
    const child = (spawned && typeof spawned.then === 'function') ? await spawned : spawned;
    if (state.ended) {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      state.turnStarting = false;
      // disposeSession may have completed while an async remote spawn was in
      // flight. Its first cleanup deliberately retained this state behind the
      // turnStarting fence; run a final pass now so the disposed session can be
      // forgotten (and any failed dirs retried) once the late child is killed.
      await cleanupExecutorDirs(state);
      return;
    }
    state.currentChild = child;
    state.turnStarting = false;

    // Emit a turn_started normalized event (Codex DOES have a turn boundary
    // signal, but the JSONL turn.started arrives after we spawn — emit our
    // own turn boundary now so consumers see the user input bracketed).
    emitNormalized(runId, NORMALIZED_EVENT_TYPES.TURN_STARTED, buildPayload({
      turnIndex: state.turnIndex,
      summaryText: 'turn started',
      hasRawStored: RAW_EVENTS_ENABLED,
      data: { resume: !isFirstTurn, tier: effectiveTier }, // F-1: record used tier
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
        data: { error: err.message, terminal: true },
      }));
      state.currentChild = null;
      // A spawn-time OS error (ENOENT/EACCES) is terminal but does NOT fire the
      // 'exit' event — surface it the same way the exit-failure path does so the
      // session flips to not-alive and the failed status is probe-stable
      // (Codex P4-S3a R6). Guard against double surfacing if 'exit' also fires.
      if (!state.ended) {
        state.exitCode = 1;
        state.ended = true;
        emitFastUnavailableIfNeeded(runId, 'spawn-error'); // F-1
        try {
          if (runService) runService.updateRunStatus(runId, 'failed', { force: true });
        } catch { /* ignore */ }
        emitSessionEndedIfNeeded(runId, 'spawn-error');
        Promise.resolve(cleanupExecutorDirs(state)).catch(() => { /* best-effort */ });
      }
    });

    child.on('exit', (code, signal) => {
      state.currentChild = null;
      // Track the terminal exit code so detectExitCode() can report the ACTUAL
      // outcome. Without this, an ended session always reports 0 and a later
      // managerRegistry.probeActive() would overwrite a failed run to completed.
      // A signal-killed child reports code === null — record a nonzero so it is
      // classified as a failure, not a false 'completed' (Codex P4-S3a R5).
      state.exitCode = (code === null || code === undefined) ? (signal ? 128 : 1) : code;
      // If the turn produced a turn.completed vendor event we already advanced
      // turnIndex; otherwise treat exit-with-error as a failed turn.
      if (code !== 0) {
        emitNormalized(runId, NORMALIZED_EVENT_TYPES.TURN_FAILED, buildPayload({
          turnIndex: state.turnIndex,
          summaryText: `codex exited code=${code}`,
          hasRawStored: RAW_EVENTS_ENABLED,
          data: { exitCode: code, stderr: stderrChunks.join('').slice(-2000), terminal: true },
        }));
        // Persist failure on the run row AND mark the session logically dead
        // so isSessionAlive flips to false. Otherwise getActiveManager() in
        // routes/manager.js keeps treating the run as active (it trusts
        // isSessionAlive over run.status).
        state.ended = true;
        emitFastUnavailableIfNeeded(runId, 'codex-exit-error'); // F-1
        try {
          if (runService) {
            runService.updateRunStatus(runId, 'failed', { force: true });
          }
        } catch { /* ignore */ }
        emitSessionEndedIfNeeded(runId, 'codex-exit-error');
        Promise.resolve(cleanupExecutorDirs(state)).catch(() => { /* best-effort */ });
      }
    });
    } catch (err) {
      state.turnStarting = false;
      // Surface an async spawn/placement failure (a REMOTE putSecretFile /
      // spawnInteractive rejection that happens before a child exists) the same
      // way the sync fail-closed paths do — mark the run failed, emit
      // TURN_FAILED + SESSION_ENDED, and clean up a secret dir placed this turn.
      // Without this, runTurn's fire-and-forget path would leave the turn
      // {accepted:true} but never failed (isSessionAlive stays true), so the
      // caller could commit a notice-drain for a turn that never spawned.
      // Skip if a fail-closed path already surfaced it (it sets state.ended
      // before throwing → avoid double-emit). Codex P4-S3a R3 review.
      if (!state.ended) {
        try {
          emitNormalized(runId, NORMALIZED_EVENT_TYPES.TURN_FAILED, buildPayload({
            turnIndex: state.turnIndex,
            summaryText: `turn spawn failed: ${err && err.message}`,
            hasRawStored: RAW_EVENTS_ENABLED,
            data: { kind: 'spawn_failed', error: err && err.message, terminal: true },
          }));
        } catch { /* ignore */ }
        state.ended = true;
        state.exitCode = 1;
        emitFastUnavailableIfNeeded(runId, 'spawn-failed'); // F-1: async spawn/placement rejection of a fast turn
        try {
          if (runService) runService.updateRunStatus(runId, 'failed', { force: true });
        } catch { /* ignore */ }
        emitSessionEndedIfNeeded(runId, 'spawn-failed');
      }
      await cleanupExecutorDirs(
        state,
        [placedInstructionsDirThisTurn, ...placedMcpDirsThisTurn],
      );
      throw err;
    }
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
      // v3 Phase 3a: notify the Operator spawn service exactly once so it can
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
        //      current codex-cli builds (verified 2026-04-20 on 0.120.0)
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
            data: { kind: 'codex_error', errorKind, message: msg, terminal: false },
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
        data: { isError: false, terminal: true, invocationId: state.currentInvocationId || undefined },
      }));

      state.currentInvocationId = null;

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

  // runTurn is SYNC-returning {accepted} on purpose (P4-S3a). spawnOneTurn is
  // async (a remote-pod turn awaits the ssh spawn), but every REFUSAL path is
  // synchronously knowable — no/ended session, a turn already in flight, and an
  // invalid mcpConfig (flatten is a pure sync function). We decide `accepted`
  // from those sync checks and then DRIVE the (possibly-async) spawn. This keeps
  // the sync caller contract (conversationService.sendToManagerSlot reads
  // result.accepted synchronously and must NOT false-accept a refusal — the
  // earlier thenable-optimistic approach did, because refusals RESOLVE
  // {accepted:false} rather than reject, so a .catch never fired). Codex P4-S3a
  // R2 review.
  function runTurn(runId, { text, displayText, source, invocationId } = {}) {
    const state = sessions.get(runId);
    if (!state) return { accepted: false };
    if (state.ended) return { accepted: false };
    // Turn already in flight — Codex turns are not concurrent (mirrors the
    // spawnOneTurn guard, but decided synchronously so accepted is truthful).
    if (state.currentChild || state.turnStarting) return { accepted: false };
    // Fail-closed mcpConfig pre-check: validate synchronously so an invalid
    // config REFUSES the turn (accepted:false) here rather than surfacing after
    // the caller already committed. Emission mirrors spawnOneTurn's fail-closed.
    if (state.mcpConfig) {
      try {
        const validated = validateCodexMcpSecretTransport(state.mcpConfig);
        if (Object.keys(validated.wrapped).length > 0
            && (!state.executor || typeof state.executor.putSecretFile !== 'function')) {
          throw new Error(
            'codexMcpSecretTransport: executor.putSecretFile is required for stdio MCP env values',
          );
        }
        if (Object.keys(validated.wrapped).length > 0
            && (!state.executor || typeof state.executor.resolveNodeRuntime !== 'function')) {
          throw new Error(
            'codexMcpSecretTransport: executor.resolveNodeRuntime is required for stdio MCP env values',
          );
        }
      } catch (err) {
        emitNormalized(runId, NORMALIZED_EVENT_TYPES.TURN_FAILED, buildPayload({
          turnIndex: state.turnIndex,
          summaryText: `mcpConfig invalid: ${err.message}`,
          hasRawStored: RAW_EVENTS_ENABLED,
          data: { kind: 'mcp_invalid', error: err.message, terminal: true },
        }));
        state.ended = true;
        try {
          if (runService) runService.updateRunStatus(runId, 'failed', { force: true });
        } catch { /* ignore */ }
        state.exitCode = 1;
        emitSessionEndedIfNeeded(runId, 'mcp-invalid');
        return { accepted: false };
      }
    }
    // Record user_input BEFORE spawning so the UI shows the message immediately
    // (parity with streamJsonEngine/claudeAdapter).
    if (runService && text) {
      try {
        const eventPayload = { text: text.slice(0, 5000) };
        if (typeof displayText === 'string') {
          eventPayload.display_text = displayText.slice(0, 5000);
        }
        runService.addRunEvent(runId, 'user_input', JSON.stringify(eventPayload));
      } catch (err) {
        console.warn(`[codexAdapter] user_input event failed for ${runId}: ${err.message}`);
      }
    }
    // Accept the turn and drive the spawn. LOCAL runs synchronously in THIS
    // frame (the fake spawn / real child is created before we return, so sync
    // arg-inspection tests + composer side-effects still observe it); REMOTE
    // proceeds async and is fire-and-forget — its outcome/failure surfaces via
    // run status + SESSION_ENDED events (spawnOneTurn already marks + emits).
    state.currentInvocationId = invocationId || null;
    let spawnResult;
    try {
      spawnResult = spawnOneTurn(runId, text || '', { source });
    } catch (err) {
      // spawnOneTurn is async so it should not throw synchronously, but guard.
      console.warn(`[codexAdapter] runTurn spawn failed for ${runId}: ${err.message}`);
      return { accepted: false };
    }
    if (spawnResult && typeof spawnResult.then === 'function') {
      spawnResult.catch((err) => {
        console.warn(`[codexAdapter] turn spawn rejected for ${runId}: ${err && err.message}`);
      });
    }
    return { accepted: true };
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
    // Prefer the tracked terminal exit code (nonzero on child-exit failure /
    // mcp-flatten / remote-spawn rejection) so a probeActive() liveness sweep
    // preserves 'failed' instead of forcing 'completed'. Fall back to 0 for a
    // session ended without a recorded code (e.g. explicit disposeSession).
    if (state.exitCode != null) return state.exitCode;
    return state.ended ? 0 : null;
  }

  // F-1: annotate-only event when a FAST-tier turn's codex process failed.
  // Emitted at most once per turn (state._fastUnavailEmitted guard) from the
  // terminal failure handlers. Does NOT change turn outcome — the existing
  // TURN_FAILED / status flip owns that; this just surfaces "fast may be
  // unavailable (auth/model/config)" so the UI can advise toggling it off.
  function emitFastUnavailableIfNeeded(runId, reason) {
    const state = sessions.get(runId);
    if (!state) return;
    if (state.currentTurnTier !== 'fast') return;
    if (state._fastUnavailEmitted) return;
    state._fastUnavailEmitted = true;
    try {
      if (runService) {
        runService.addRunEvent(runId, 'codex:fast_unavailable', JSON.stringify({
          tier: 'fast',
          reason: reason || null,
          turnIndex: state.turnIndex,
        }));
      }
    } catch { /* annotate-only, never throw */ }
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

  function maybeForgetDisposedState(state, cleaned) {
    if (
      cleaned
      && state.disposeRequested
      && !state.turnStarting
      && sessions.get(state.runId) === state
    ) {
      sessions.delete(state.runId);
    }
    return cleaned;
  }

  async function cleanupExecutorDirs(state, extraDirs = []) {
    if (!state) return true;
    state.pendingCleanupDirs = [...new Set([
      ...(state.pendingCleanupDirs || []),
      ...extraDirs,
    ].filter(Boolean))];
    // Child error/exit and registry disposal can converge on cleanup. Serialize
    // them so a stale failed snapshot cannot overwrite another caller's
    // successful removal result. A second pass picks up dirs placed meanwhile.
    if (state.cleanupPromise) {
      await state.cleanupPromise;
      return cleanupExecutorDirs(state);
    }
    const dirs = new Set([
      state.instructionsDir,
      ...(state.mcpSecretDirs || []),
      ...(state.pendingCleanupDirs || []),
    ].filter(Boolean));
    state.instructionsDir = null;
    state.instructionsPath = null;
    state.mcpSecretDirs = [];
    state.mcpArgs = null;
    state.pendingCleanupDirs = [];
    if (dirs.size === 0) {
      return maybeForgetDisposedState(state, true);
    }
    if (!state.executor || typeof state.executor.rmrf !== 'function') {
      state.pendingCleanupDirs = [...dirs];
      return false;
    }
    const cleanupPromise = Promise.all([...dirs].map(async (dir) => {
      try {
        await removeSecretDirWithRetry(state.executor, dir);
        return { dir, removed: true };
      } catch {
        return { dir, removed: false };
      }
    }));
    state.cleanupPromise = cleanupPromise;
    let outcomes;
    try {
      outcomes = await cleanupPromise;
    } finally {
      if (state.cleanupPromise === cleanupPromise) state.cleanupPromise = null;
    }
    state.pendingCleanupDirs = [...new Set([
      ...(state.pendingCleanupDirs || []),
      ...outcomes.filter(outcome => !outcome.removed).map(outcome => outcome.dir),
    ])];
    for (const outcome of outcomes) {
      if (!outcome.removed) {
        console.warn('[codexAdapter] secret cleanup deferred after bounded retries');
      }
    }
    const cleaned = state.pendingCleanupDirs.length === 0
      && !state.instructionsDir
      && state.mcpSecretDirs.length === 0;
    return maybeForgetDisposedState(state, cleaned);
  }

  /**
   * Dispose of session resources. CRITICAL: this is the hook D1 was added
   * for — Codex's instructionsPath temp file MUST be cleaned up here, both
   * on /stop and on boot-time stale cleanup. The Claude adapter's no-op
   * dispose just kills a process; Codex actually has on-disk state.
   */
  function disposeSession(runId) {
    const state = sessions.get(runId);
    if (!state) return Promise.resolve();
    state.ended = true;
    state.disposeRequested = true;
    if (state.currentChild) {
      try { state.currentChild.kill('SIGTERM'); } catch { /* ignore */ }
    }
    emitSessionEndedIfNeeded(runId, 'dispose');
    // Remote executors may transiently fail while a node reconnects. Keep the
    // ended state until every mode-0600 dir is confirmed gone, so a repeated
    // dispose retries the preserved paths instead of silently orphaning them.
    return cleanupExecutorDirs(state).then((cleaned) => {
      if (!cleaned) {
        console.warn(`[codexAdapter] cleanup remains pending for ${runId}; a repeated dispose will retry`);
        return false;
      }
      return true;
    });
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
  // F-1: tier policy resolver (per-instance fast_mode → env → standard).
  resolveCodexServiceTier,
  // P2-2: expose classifier + constants for vendor fixture tests.
  classifyCodexErrorAsNotice,
  NON_FATAL_SEVERITIES,
  NOTICE_CODE_PREFIXES,
  // P4-6: expose error kind classifier + patterns for tests.
  classifyCodexErrorKind,
  ERROR_CLASSIFICATION_PATTERNS,
};
