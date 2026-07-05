/**
 * Agent Lifecycle Manager — orchestrates the full lifecycle of agent runs.
 *
 * Responsibilities:
 * - Task → Run creation when task moves to in_progress
 * - Agent spawning via ExecutionEngine
 * - Health monitoring (heartbeat, timeout, crash detection)
 * - Crash recovery on server restart (orphan tmux reattach)
 * - Status transitions (run completes → task moves to review)
 */

const { createLocalNodeExecutor, createLocalWorkerChannel } = require('./nodeExecutor');
const { explainDispatch } = require('./dispatchPolicy');

function createLifecycleService({
  runService,
  taskService,
  agentProfileService,
  projectService,
  executionEngine,
  streamJsonEngine,
  worktreeService,
  harvestService,
  eventBus,
  skillPackService,
  presetService,
  claudeVersionResolver,
  authResolver,               // Phase 10D: injectable for tests
  authResolverOpts,           // { hasKeychain, readKeychainToken, prefer, tmpRoot }
  nodeService,
  nodeExecutor,
  queueStuckMs,
  now,
}) {
  nodeExecutor = nodeExecutor || createLocalNodeExecutor({ executionEngine, streamJsonEngine });
  const workerChannel = (nodeExecutor && typeof nodeExecutor.spawnWorker === 'function')
    ? nodeExecutor
    : createLocalWorkerChannel({ streamJsonEngine, executionEngine });
  function channelForNode(nodeId) {
    // LOCAL (null/'local', or a node that resolves to kind 'local') keeps the
    // EXISTING global workerChannel — preserves all current behavior AND the
    // test injection path (fake engines).
    if (!nodeId || nodeId === 'local') return workerChannel;
    const node = getDispatchNode(nodeId);
    if (!node || (node.kind || 'local') === 'local') return workerChannel;
    // Genuine remote node: it MUST route through pickExecutor. Fail CLOSED —
    // never fall back to the local control-plane channel, which would silently
    // run a pod-bound worker on the control plane (the P2 dispatch gate that
    // prevented this was removed in P3b-3). Codex P3b-3 review.
    if (!nodeService || typeof nodeService.pickExecutor !== 'function') {
      throw new Error(`Remote node ${nodeId} requires nodeService.pickExecutor; refusing to run a remote worker on the control plane`);
    }
    return nodeService.pickExecutor(nodeId);
  }
  // Lazy-require default authResolver so tests that don't use Tier 2 don't
  // force a load of the real keychain probe.
  const _authResolver = authResolver || require('./authResolver');
  const { resolveSpawnCwd } = require('../utils/spawnCwd');
  const { deriveLegacyContext, enforceWorkspace } = require('../utils/operatorContext');
  const _authResolverOpts = authResolverOpts || {};
  const HEARTBEAT_INTERVAL_MS = 30000;  // 30s
  const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min (increased from 10 min for long-running tasks)
  // Normalize BOTH the injected option and the env var through Number() so a
  // caller passing '0' / 'abc' / a negative falls back to the 15-min default
  // (Codex N3-2 review NIT — the option was previously trusted verbatim).
  const QUEUE_STUCK_THRESHOLD_MS = (() => {
    const raw = queueStuckMs !== undefined ? Number(queueStuckMs) : Number(process.env.PALANTIR_QUEUE_STUCK_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60 * 1000;
  })();
  const nowMs = typeof now === 'function' ? now : Date.now;
  const MAX_RETRY = 1;
  let heartbeatTimer = null;
  let healthCheckRunning = false; // Re-entrancy guard
  let unsubscribeEventBus = null; // for stopMonitoring teardown
  const _outputHashes = new Map(); // Track tmux output changes per run
  // runId → projectDir snapshot captured at executeTask time. Used as a fallback
  // for worktree cleanup when the run→task→project chain has been broken (e.g. the
  // task or project was deleted while the run was still in flight).
  const _runProjectDirs = new Map();

  /**
   * Check if the agent process for a tmux run is actively consuming CPU.
   * Uses `tmux list-panes` to get the child PID, then checks /proc or `ps`
   * to see if it's actually working vs idle/sleeping.
   */
  function _isProcessActive(runId) {
    try {
      const { execFileSync } = require('node:child_process');
      const sessionName = `palantir-run-${String(runId).replace(/[^a-zA-Z0-9_-]/g, '_')}`;

      // Get the PID of the process running inside the tmux pane
      const pidStr = execFileSync('tmux', ['list-panes', '-t', sessionName, '-F', '#{pane_pid}'], {
        stdio: 'pipe', timeout: 3000, encoding: 'utf8',
      }).trim();

      if (!pidStr) return false;
      const panePid = parseInt(pidStr.split('\n')[0], 10);
      if (isNaN(panePid)) return false;

      // Check all descendant processes for CPU activity using ps
      // ps -o pid,state,%cpu for the pane PID and all its children
      const psOutput = execFileSync('ps', ['-o', 'pid=,state=,%cpu=', '-g', String(panePid)], {
        stdio: 'pipe', timeout: 3000, encoding: 'utf8',
      }).trim();

      if (!psOutput) return false;

      // Check if any process in the group is running (R state) or using CPU > 0
      for (const line of psOutput.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3) {
          const state = parts[1];
          const cpu = parseFloat(parts[2]);
          // R = running, S = sleeping (interruptible, often normal for I/O wait)
          // If any process is in R state or using measurable CPU, it's active
          if (state.startsWith('R') || cpu > 0.5) {
            return true;
          }
        }
      }
      return false;
    } catch {
      // If we can't determine, assume not active (safe fallback)
      return false;
    }
  }

  /**
   * Classify an agent profile into one of the three adapter families Phase
   * 10C wires preset injection for. Falls back to 'other' so callers can
   * emit a Tier 1 skip warning instead of silently dropping MCP.
   */
  function resolveAdapterName(profile) {
    const cmd = (profile?.command || '').toLowerCase();
    if (cmd.includes('claude')) return 'claude';
    if (cmd.includes('codex')) return 'codex';
    if (cmd.includes('opencode')) return 'opencode';
    return 'other';
  }

  // Fail-closed: a corrupt queued_args (manual DB edit, partial write) must
  // NOT silently spawn a worker without its preset/skill packs. Throw so
  // spawnQueuedRun marks the run failed instead of running it under-equipped.
  // A genuinely empty (NULL) queued_args is the normal no-args case → {}.
  function parseQueuedArgs(value) {
    if (!value) return {};
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('queued_args is not a JSON object');
    }
    return parsed;
  }

  function buildQueuedArgs({ skillPackIds, presetId }) {
    return {
      skillPackIds: Array.isArray(skillPackIds) ? skillPackIds : null,
      presetId: presetId || null,
    };
  }

  function getRunningCount(profileId) {
    if (runService && typeof runService.countRunning === 'function') {
      return runService.countRunning(profileId);
    }
    return agentProfileService.getRunningCount(profileId);
  }

  const localDispatchableNode = {
    id: 'local',
    kind: 'local',
    reachable: 1,
    can_execute: 1,
    files_only: 0,
    max_concurrent: null,
  };

  function resolveProjectNode(project) {
    if (nodeService && typeof nodeService.resolveNode === 'function') {
      return nodeService.resolveNode(project);
    }
    return project?.node_id || 'local';
  }

  function getDispatchNode(nodeId) {
    const id = nodeId || 'local';
    if (!nodeService || typeof nodeService.getNode !== 'function') {
      return { ...localDispatchableNode, id };
    }
    try {
      return nodeService.getNode(id);
    } catch {
      if (id === 'local') return localDispatchableNode;
      return null;
    }
  }

  function countRunningOnNode(nodeId, profileId) {
    if (runService && typeof runService.countRunningOnNode === 'function') {
      return runService.countRunningOnNode(nodeId || 'local', profileId);
    }
    return getRunningCount(profileId);
  }

  function countRunningTotalOnNode(nodeId) {
    if (runService && typeof runService.countRunningTotalOnNode === 'function') {
      return runService.countRunningTotalOnNode(nodeId || 'local');
    }
    return 0;
  }

  function isThenable(value) {
    return value && typeof value.then === 'function';
  }

  function canDispatchOnNode(nodeId, profileId, profile) {
    const node = getDispatchNode(nodeId);
    const nodeGate = explainDispatch({
      node,
      profile,
      runningOnNodeForProfile: Number.NEGATIVE_INFINITY,
      runningTotalOnNode: Number.NEGATIVE_INFINITY,
    });
    if (!nodeGate.ok) return false;

    const id = node.id || nodeId || 'local';
    const runningOnNodeForProfile = countRunningOnNode(id, profileId);
    const profileGate = explainDispatch({
      node,
      profile,
      runningOnNodeForProfile,
      runningTotalOnNode: Number.NEGATIVE_INFINITY,
    });
    if (!profileGate.ok) return false;

    const runningTotalOnNode = node.max_concurrent != null
      ? countRunningTotalOnNode(id)
      : Number.NEGATIVE_INFINITY;
    const nodeCapacityGate = explainDispatch({
      node,
      profile,
      runningOnNodeForProfile,
      runningTotalOnNode,
    });
    return nodeCapacityGate.ok;
  }

  /**
   * Run `claude --version` and return the raw semver portion, or null on
   * any failure. The gate is enforced only when the preset declares
   * `min_claude_version`; callers treat null as "unable to verify" and
   * fall back to passing the preset through unchanged (documented in the
   * gate call site). Test path injects `claudeVersionResolver`.
   */
  function resolveClaudeVersion() {
    if (typeof claudeVersionResolver === 'function') {
      try { return claudeVersionResolver() || null; } catch { return null; }
    }
    try {
      const { execFileSync } = require('node:child_process');
      const out = execFileSync('claude', ['--version'], {
        stdio: 'pipe', timeout: 3000, encoding: 'utf8',
      }).trim();
      const match = out.match(/(\d+\.\d+\.\d+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  /**
   * Build a git-branch-safe identifier from a run id (run_xxx → palantir/run-xxx).
   * Underscores break worktreeService.validateBranchName, so they get replaced.
   */
  function runBranchName(runId) {
    return `palantir/${String(runId).replace(/_/g, '-')}`;
  }

  /**
   * Resolve the project directory associated with a run. Tries the in-memory
   * snapshot first (captured at executeTask), then falls back to walking
   * run → task → project → directory. Returns null only if both fail.
   * The snapshot makes cleanup robust against task/project deletion mid-run.
   */
  function resolveProjectDirForRun(run) {
    if (run?.id && _runProjectDirs.has(run.id)) {
      return _runProjectDirs.get(run.id);
    }
    try {
      if (!run?.task_id) return null;
      const task = taskService.getTask(run.task_id);
      if (!task?.project_id) return null;
      const project = projectService.getProject(task.project_id);
      return project?.directory || null;
    } catch {
      return null;
    }
  }

  /**
   * Cleanup worktree for a run that has reached a terminal state.
   * Idempotent: safe to call even if no worktree was created or already removed.
   * Always clears the in-memory project-dir snapshot to avoid leaks.
   */
  async function cleanupRunRuntimeFiles(run) {
    if (!run?.id) return;
    _runProjectDirs.delete(run.id);

    // Skill Packs: cleanup MCP config file
    if (run.mcp_config_path) {
      try {
        const fs = require('node:fs');
        if (await nodeExecutor.fileExists(run.mcp_config_path)) {
          fs.unlinkSync(run.mcp_config_path);
        }
      } catch (err) {
        console.warn(`[lifecycle] MCP config cleanup failed for run ${run.id}: ${err.message}`);
      }
    }
  }

  async function cleanupRunWorktree(run) {
    if (!run?.id) return;
    if (worktreeService && run.worktree_path && run.branch) {
      const projectDir = resolveProjectDirForRun(run);
      if (projectDir) {
        try {
          await worktreeService.removeWorktree(projectDir, run.worktree_path, run.branch, { runId: run.id });
        } catch (err) {
          console.warn(`[lifecycle] Worktree cleanup failed for run ${run.id}: ${err.message}`);
        }
      }
    }
    await cleanupRunRuntimeFiles(run);
  }

  /**
   * Execute a task: create a Run, spawn the agent.
   *
   * M4-a: async because http-MCP preflight (DNS resolve + HEAD request)
   * is async. Pre-M4 callers that ignored the return value still work
   * (the Promise is just dropped); callers that consumed the run row
   * MUST `await`. Sole production caller is routes/tasks.js which is
   * already inside an asyncHandler.
   */
  async function executeTask(taskId, { agentProfileId, prompt, skillPackIds, presetId }) {
    const task = taskService.getTask(taskId);
    const profile = agentProfileService.getProfile(agentProfileId);
    let nodeId = 'local';
    if (task.project_id) {
      const project = projectService.getProject(task.project_id);
      nodeId = resolveProjectNode(project);
    }

    // Phase 10C: resolve preferred preset. Explicit argument wins over
    // task.preferred_preset_id so callers can override per-execute.
    const effectivePresetId = presetId || task.preferred_preset_id || null;

    const run = runService.createRun({
      task_id: taskId,
      agent_profile_id: agentProfileId,
      prompt,
      node_id: nodeId,
      queued_args: buildQueuedArgs({ skillPackIds, presetId: effectivePresetId }),
      retry_count: 0,
    });

    if (canDispatchOnNode(nodeId, agentProfileId, profile)) {
      return (await spawnQueuedRun(run.id)) || runService.getRun(run.id);
    }

    runService.addRunEvent(run.id, 'queue:enqueued', JSON.stringify({
      profile_id: agentProfileId,
      node_id: nodeId,
    }));
    return runService.getRun(run.id);
  }

  async function spawnQueuedRun(runId) {
    const claimed = runService.claimQueuedRun(runId);
    if (!claimed) return null;

    const run = runService.getRun(runId);
    let queuedArgs;
    try {
      queuedArgs = parseQueuedArgs(run.queued_args);
    } catch (err) {
      // Already claimed → running; fail it closed rather than spawn under-equipped.
      // Exhaust the retry budget first: a retry would copy the same corrupt
      // queued_args and fail identically, so it's pure waste (one needless
      // failed run + PM review). Bump retry_count to MAX so run:ended skips it.
      runService.addRunEvent(runId, 'queue:args_invalid', JSON.stringify({ error: err.message }));
      runService.setRetryCount(runId, MAX_RETRY);
      runService.updateRunStatus(runId, 'failed', { force: true, reason: 'queued_args_invalid' });
      return null;
    }
    const skillPackIds = Array.isArray(queuedArgs.skillPackIds) ? queuedArgs.skillPackIds : undefined;
    const effectivePresetId = queuedArgs.presetId || null;
    const taskId = run.task_id;
    const agentProfileId = run.agent_profile_id;
    const prompt = run.prompt || '';
    const task = taskService.getTask(taskId);
    const profile = agentProfileService.getProfile(agentProfileId);
    const adapterName = resolveAdapterName(profile);
    const node = getDispatchNode(run.node_id);
    const isRemoteNode = node && (node.kind || 'local') !== 'local';

    runService.addRunEvent(run.id, 'queue:dequeued', JSON.stringify({
      profile_id: agentProfileId,
    }));

    // Resolve project directory and MCP config for agent CWD
    let projectDir = null;
    let projectMcpConfig = null;
    let project = null;
    if (task.project_id) {
      project = projectService.getProject(task.project_id);
      if (project?.source_type === 'git') {
        runService.addRunEvent(run.id, 'run:repo_materialize_unavailable', JSON.stringify({ project_id: project.id }));
        runService.updateRunStatus(run.id, 'failed', { force: true, reason: 'repo_materialize_unavailable' });
        // Return the FAILED run row (not null) to match executeTask's contract:
        // callers (routes/tasks.js) respond `{ run }`, so the client sees the
        // failed status + reason rather than a misleading `{ run: null }` 201
        // (Codex R2 review NIT).
        return runService.getRun(run.id);
      }
      if (project?.directory) {
        if (isRemoteNode) {
          projectDir = project.directory;
        } else if (await nodeExecutor.fileExists(project.directory)) {
          projectDir = project.directory;
        } else {
          console.warn(`[lifecycle] Project directory not found: ${project.directory}, falling back to server cwd`);
        }
      }
      // P4-2: capture project-scoped MCP config path for worker spawn
      if (project?.mcp_config_path) {
        projectMcpConfig = project.mcp_config_path;
      }
    }

    // Snapshot the project dir against the run id so cleanup still works even if
    // the task or project is deleted before the run terminates.
    if (projectDir) _runProjectDirs.set(run.id, projectDir);

    // ── Preset resolution (Phase 10C) ──
    // Resolve the worker preset BEFORE skill packs so the combined MCP
    // precedence (preset > project > skill pack) can be applied in one
    // place. Failures here are fail-closed — the run is marked failed
    // and the error rethrown (same pattern as skill pack resolution).
    let presetResolution = null;
    let presetObj = null;
    if (effectivePresetId && presetService) {
      try {
        presetResolution = presetService.resolveForSpawn({
          presetId: effectivePresetId,
          adapter: adapterName,
        });
        presetObj = presetResolution.preset;

        // min_claude_version gate (Claude adapter only — non-Claude adapters
        // can't meaningfully satisfy a Claude CLI version constraint). If
        // we cannot resolve the installed CLI version we warn and proceed.
        if (adapterName === 'claude' && presetResolution.minClaudeVersion) {
          const found = resolveClaudeVersion();
          if (!found) {
            runService.addRunEvent(run.id, 'preset:version_unverified', JSON.stringify({
              min_claude_version: presetResolution.minClaudeVersion,
              reason: 'claude --version resolution failed',
            }));
          } else if (presetService.compareSemver(found, presetResolution.minClaudeVersion) < 0) {
            const msg = `Preset requires Claude CLI >= ${presetResolution.minClaudeVersion}, found ${found}`;
            runService.addRunEvent(run.id, 'preset:version_mismatch', JSON.stringify({
              min_claude_version: presetResolution.minClaudeVersion, found,
            }));
            const err = new Error(msg);
            err.status = 400;
            throw err;
          }
        }

        // Emit resolver warnings as run events (tier2_skipped,
        // mcp_template_missing, etc.). These are annotate-only.
        for (const w of presetResolution.warnings || []) {
          runService.addRunEvent(run.id, w.type || 'preset:warning', JSON.stringify(w));
        }

        // Phase 10D: Tier 2 active (Claude isolated worker). Auth must be
        // materialized here because `--bare` strips the CLI's ability to
        // read OAuth / keychain. The resolver writes a temp apiKeyHelper
        // script + settings.json (default) or falls back to env
        // ANTHROPIC_API_KEY. Either path is fail-closed on missing auth.
        if (presetResolution.isolated) {
          runService.addRunEvent(run.id, 'preset:tier2_active', JSON.stringify({
            plugin_refs: (presetObj.plugin_refs || []),
            setting_sources: presetObj.setting_sources || '',
          }));
        }

        // Persist the content snapshot + bind preset_id to the run row
        // immediately (R1-P1-5: persist at resolve time, not at spawn
        // completion, so forensic data survives crashes mid-spawn).
        presetService.persistSnapshot(run.id, presetObj, presetResolution.snapshot);
        runService.updateRunPreset(run.id, {
          preset_id: presetObj.id,
          preset_snapshot_hash: presetResolution.snapshot.hash,
        });
      } catch (err) {
        // Fail the run on any preset resolution error so operators never
        // ship a worker that was meant to carry a preset without it.
        runService.updateRunStatus(run.id, 'failed', { force: true });
        runService.addRunEvent(run.id, 'error', JSON.stringify({ message: err.message }));
        _runProjectDirs.delete(run.id);
        throw err;
      }
    }

    // ── Skill Pack resolution (Phase 1b) ──
    // Only for workers (is_manager guard is implicit: executeTask is worker-only)
    let skillPackResult = null;
    let skillPackMcpConfigPath = null;
    if (skillPackService) {
      try {
        skillPackResult = skillPackService.resolveForRun(
          { taskService, agentProfileService, projectService },
          { taskId, explicitPackIds: skillPackIds, agentProfileId }
        );

        // Log warnings as run events
        for (const w of skillPackResult.warnings) {
          runService.addRunEvent(run.id, w.type || 'skill_pack:warning', JSON.stringify(w));
        }

        // MCP merge is deferred until after the skill pack block so the
        // three sources (preset > project > skill pack, §6.8) can be
        // composed in one place. See _buildMergedMcp below.

        // Record denormalized snapshots
        if (skillPackResult.appliedPacks.length > 0) {
          skillPackService.recordRunSnapshots(run.id, skillPackResult.appliedPacks);
        }
      } catch (err) {
        // If skill pack resolution fails, mark run as failed
        if (err.status === 400) {
          runService.updateRunStatus(run.id, 'failed', { force: true });
          runService.addRunEvent(run.id, 'error', JSON.stringify({ message: err.message }));
          throw err;
        }
        // All skill pack errors fail the run — never proceed without intended overlays
        runService.updateRunStatus(run.id, 'failed', { force: true });
        runService.addRunEvent(run.id, 'error', JSON.stringify({ message: err.message }));
        throw err;
      }
    }

    // ── Unified MCP merge + system prompt chain (Phase 10C §6.8) ──
    // Source precedence — MCP: preset > project > skill pack. Prompt:
    // preset base → skill pack sections (priority order) → adapter footer.
    // `skillPackMcpConfigPath` is reused downstream and repurposed to point
    // at the merged config file so Phase 1b consumers keep working.
    const mergedMcpWarnings = [];
    const presetMcp = presetResolution ? presetResolution.mcpConfig : null;
    const skillPackMcp = skillPackResult ? skillPackResult.mcpConfig : null;
    let projectMcpObj = null;
    if (projectMcpConfig && projectDir) {
      try {
        // Control-plane-local MCP config read; worker/worktree paths use NodeExecutor.
        const fsM = require('node:fs');
        const pathM = require('node:path');
        const realRoot = fsM.realpathSync(projectDir);
        const realMcpPath = fsM.realpathSync(projectMcpConfig);
        if (realMcpPath !== realRoot && !realMcpPath.startsWith(realRoot + pathM.sep)) {
          throw new Error('mcp_config_path escapes project directory boundary');
        }
        projectMcpObj = JSON.parse(fsM.readFileSync(realMcpPath, 'utf8'));
      } catch (err) {
        console.warn(`[lifecycle] Failed to read project MCP config: ${err.message}`);
      }
    }
    let mergedMcp = null;
    if (presetService) {
      mergedMcp = presetService.mergeMcp3(presetMcp, projectMcpObj, skillPackMcp, {
        warnings: mergedMcpWarnings,
      });
    } else if (skillPackMcp || projectMcpObj) {
      // Legacy fallback (presetService absent in some tests): mimic the
      // pre-10C behavior — project wins over skill pack.
      const servers = { ...(skillPackMcp?.mcpServers || {}) };
      for (const [alias, config] of Object.entries(projectMcpObj?.mcpServers || {})) {
        servers[alias] = config;
      }
      mergedMcp = Object.keys(servers).length > 0 ? { mcpServers: servers } : null;
    }
    // M4-a: collect http-transport bearer env keys for auto-allowlisting
    // into the worker spawn env. Per-alias env names are derived from the
    // merged config (cfg.bearer_token_env_var) so a preset/skill pack can
    // ship http aliases without the operator hand-listing the key in
    // agent_profiles.env_allowlist.
    const httpBearerEnvKeys = [];
    if (mergedMcp && mergedMcp.mcpServers) {
      for (const cfg of Object.values(mergedMcp.mcpServers)) {
        if (cfg && typeof cfg === 'object' && typeof cfg.bearer_token_env_var === 'string'
            && cfg.bearer_token_env_var) {
          if (!httpBearerEnvKeys.includes(cfg.bearer_token_env_var)) {
            httpBearerEnvKeys.push(cfg.bearer_token_env_var);
          }
        }
      }
    }

    // M4-a: HTTP MCP preflight — fail-closed on bad endpoint / SSRF / dead
    // service. stdio aliases are unaffected (collectHttpAliases filters by
    // `cfg.url`). Preflight runs BEFORE writing the merged mcp file so a
    // failed preflight leaves no stale config on disk.
    if (mergedMcp) {
      const { preflightHttpMcpConfig } = require('./mcpPreflight');
      const pre = await preflightHttpMcpConfig(mergedMcp);
      for (const f of pre.failures) {
        runService.addRunEvent(run.id, 'preset:mcp_unreachable', JSON.stringify({
          alias: f.alias,
          url: f.url,
          reason: f.reason,
          ...(f.status != null ? { status: f.status } : {}),
          ...(f.ip ? { ip: f.ip } : {}),
          ...(f.bearer_env ? { bearer_env: f.bearer_env } : {}),
        }));
      }
      if (pre.failures.length > 0) {
        runService.updateRunStatus(run.id, 'failed', { force: true });
        const first = pre.failures[0];
        const msg = `MCP preflight failed: ${first.alias} (${first.reason})`;
        runService.addRunEvent(run.id, 'error', JSON.stringify({ message: msg }));
        _runProjectDirs.delete(run.id);
        throw new Error(msg);
      }
    }

    if (mergedMcp) {
      // Control-plane-local runtime MCP file; worker/worktree paths use NodeExecutor.
      const fsW = require('node:fs');
      const pathW = require('node:path');
      if (!/^[a-zA-Z0-9_-]+$/.test(run.id)) {
        throw new Error(`Invalid run id for MCP config path: ${run.id}`);
      }
      const mcpConfigFilePath = pathW.resolve(process.cwd(), 'runtime', 'mcp', `${run.id}.json`);
      fsW.mkdirSync(pathW.dirname(mcpConfigFilePath), { recursive: true, mode: 0o700 });
      fsW.writeFileSync(mcpConfigFilePath, JSON.stringify(mergedMcp, null, 2), { mode: 0o600 });
      skillPackMcpConfigPath = mcpConfigFilePath;
      runService.updateRunMcpConfig(run.id, {
        mcp_config_path: mcpConfigFilePath,
        mcp_config_snapshot: JSON.stringify(mergedMcp),
      });
      for (const w of mergedMcpWarnings) {
        runService.addRunEvent(run.id, w.type || 'mcp:alias_conflict', JSON.stringify(w));
      }
    }

    // Composed system prompt: preset base → skill pack sections → (no
    // adapter footer at this layer — callers apply adapter-specific
    // footers elsewhere). For non-preset runs with skill pack sections,
    // still use the legacy "--- Skill: <name> ---" concatenation to
    // avoid changing behavior for existing deployments.
    const composedSystemPrompt = (() => {
      if (!presetService || !presetObj) {
        if (!skillPackResult || skillPackResult.promptSections.length === 0) return null;
        return skillPackResult.promptSections
          .map(s => `--- Skill: ${s.name} ---\n${s.text}`)
          .join('\n\n');
      }
      const skillSections = (skillPackResult?.promptSections || [])
        .map(s => `--- Skill: ${s.name} ---\n${s.text}`);
      return presetService.resolvePromptChain({
        presetPrompt: presetObj.base_system_prompt || '',
        skillPackSections: skillSections,
        adapterFooter: null,
      }) || null;
    })();

    let worktreePath = null;
    let branch = null;

    try {
      // Create an isolated git worktree for this run when the project is a git
      // repo. When production has a projectDir it also has worktreeService
      // (app.js injects it). A missing worktreeService is a test-harness-only
      // legacy configuration, so keep the old projectDir spawn behavior there.
      // Remote runs use the pod project directory directly for this slice;
      // pod-side worktree isolation is a follow-up.
      if (projectDir && worktreeService && !isRemoteNode) {
        let classification = 'unknown';
        if (typeof worktreeService.classifyProjectDir === 'function') {
          classification = await worktreeService.classifyProjectDir(projectDir);
        } else if (typeof worktreeService.isGitRepo === 'function' && await worktreeService.isGitRepo(projectDir)) {
          classification = 'git';
        }

        if (classification === 'git') {
          try {
            const result = await worktreeService.createWorktree(projectDir, runBranchName(run.id));
            if (!result?.path || !result?.branch) {
              throw new Error('worktree service returned an invalid result');
            }
            worktreePath = result.path;
            branch = result.branch;
          } catch (err) {
            runService.addRunEvent(run.id, 'worktree:create_failed', JSON.stringify({ reason: 'worktree_add_failed' }));
            throw new Error(`Worktree creation failed: ${err.message}`);
          }
        } else if (classification === 'unknown') {
          runService.addRunEvent(run.id, 'worktree:create_failed', JSON.stringify({ reason: 'git_classify_failed' }));
          throw new Error('Git project classification failed');
        } else if (classification === 'non_git') {
          if (Number(project?.allow_non_git_dir || 0) === 1) {
            runService.addRunEvent(run.id, 'worktree:shared_dir_optin', JSON.stringify({}));
          } else {
            runService.addRunEvent(run.id, 'worktree:create_failed', JSON.stringify({ reason: 'non_git_not_allowed' }));
            runService.setRetryCount(run.id, MAX_RETRY);
            throw new Error('Non-git project directory is not allowed for worker spawn');
          }
        } else {
          runService.addRunEvent(run.id, 'worktree:create_failed', JSON.stringify({ reason: 'git_classify_failed' }));
          throw new Error(`Unknown git project classification: ${classification}`);
        }
      }

      // P-B2b: thread the operator context through the real worker spawn path and
      // enforce the workspace surface. For every legacy run isEnforced===false, so
      // this is a provable no-op (byte-identical). A folder-less specialist would
      // throw WORKSPACE_UNBOUND here — but specialists don't use the CLI spawn path
      // (B2c runs them on a dedicated backend); this is a defense-in-depth tripwire.
      const operatorContext = deriveLegacyContext({ run, workspaceDir: worktreePath || projectDir });
      enforceWorkspace(operatorContext, 'spawn_cwd');
      const cwd = resolveSpawnCwd({ workspaceDir: worktreePath || projectDir });
      console.log(`[lifecycle] Executing task ${taskId} in cwd: ${cwd} (project: ${task.project_id || 'none'})`);

      // Route Claude Code workers through streamJsonEngine for rich event parsing.
      // Other agents (codex, gemini, etc.) use the tmux/subprocess executionEngine.
      const isClaude = (profile.command || '').includes('claude');
      if (isRemoteNode && isClaude) {
        runService.addRunEvent(run.id, 'spawn:remote_claude_unsupported', JSON.stringify({
          node_id: run.node_id || 'local',
          reason: 'remote_stream_json_unsupported',
        }));
        runService.updateRunStatus(run.id, 'failed', { force: true, reason: 'remote_claude_unsupported' });
        await cleanupRunWorktree({
          ...runService.getRun(run.id),
          is_manager: false,
          worktree_path: worktreePath,
          branch,
          task_id: run.task_id,
        });
        return null;
      }

      let result;
      if (isClaude && streamJsonEngine) {
        // Use streamJsonEngine — same as Manager but isManager=false (single-shot worker)
        const mcpTools = parseMcpTools(profile.capabilities_json);

        // Preset/skill-pack composed prompt (Phase 10C §6.8).
        const systemPrompt = composedSystemPrompt || undefined;

        // MCP config file: unified (preset > project > skill pack) if
        // anything merged, else plain project MCP, else undefined.
        const effectiveMcpConfig = skillPackMcpConfigPath || projectMcpConfig || undefined;

        // Phase 10D Tier 2: isolated Claude worker. `--bare` path needs
        // explicit auth materialization (apiKeyHelper by default, env
        // fallback). Fail-closed: the run is marked failed and the 400
        // message surfaces in the response.
        let isolatedOpts = null;
        let spawnEnv = parseEnvAllowlist(profile.env_allowlist, httpBearerEnvKeys);
        let presetAuthCleanup = null;
        if (presetResolution && presetResolution.isolated) {
          const auth = _authResolver.resolveClaudeAuthForIsolated({
            envAllowlist: parseEnvAllowlistArray(profile.env_allowlist),
            ..._authResolverOpts,
          });
          runService.addRunEvent(run.id, 'preset:auth_sources', JSON.stringify({
            sources: auth.sources,
          }));
          if (!auth.canAuth) {
            const err = new Error(
              (auth.diagnostics[0] || 'Isolated preset requires Claude auth.'),
            );
            err.status = 400;
            throw err;
          }
          presetAuthCleanup = auth.apiKeyHelperSettings?.cleanup || null;
          isolatedOpts = {
            isolated: true,
            pluginDirs: presetResolution.pluginDirs,
            settingsPath: auth.apiKeyHelperSettings?.settingsPath || null,
            settingSources: presetResolution.settingSources || '',
            onCleanup: presetAuthCleanup,
          };
          spawnEnv = { ...spawnEnv, ...auth.env };
        }

        try {
          result = await channelForNode(run.node_id).spawnWorker(run.id, {
            engine: 'stream-json',
            spec: {
              prompt,
              cwd,
              env: spawnEnv,
              systemPrompt,
              permissionMode: 'bypassPermissions',
              allowedTools: mcpTools.length > 0 ? mcpTools : undefined,
              mcpConfig: effectiveMcpConfig,
              isManager: false,
              ...(isolatedOpts || {}),
            },
          });
        } catch (spawnErr) {
          // spawnAgent itself invokes its onCleanup before rethrow when
          // spawn() is called, so the temp dir is already gone. This is
          // belt-and-suspenders for any pre-spawn validation failure that
          // throws before spawn() is even attempted.
          if (presetAuthCleanup) {
            try { presetAuthCleanup(); } catch { /* ignore */ }
          }
          throw spawnErr;
        }
      } else {
        // Non-Claude agents: use tmux/subprocess engine
        // Phase 5 / Phase 10C: Write composed system prompt file for agents
        // that support {system_prompt_file}. `composedSystemPrompt` already
        // merges preset base prompt + skill pack sections (§6.8).
        const placeholders = {};
        if (composedSystemPrompt &&
            profile.args_template && profile.args_template.includes('{system_prompt_file}')) {
          const fs = require('node:fs');
          const path = require('node:path');
          const promptFilePath = path.resolve(process.cwd(), 'runtime', 'mcp', `${run.id}-system-prompt.md`);
          fs.mkdirSync(path.dirname(promptFilePath), { recursive: true, mode: 0o700 });
          fs.writeFileSync(promptFilePath, composedSystemPrompt, { mode: 0o600 });
          placeholders.system_prompt_file = promptFilePath;
        }
        // Phase 10C + M1: Codex worker gets preset MCP injected as leaf-level
        // dotted paths:
        //   -c mcp_servers.<alias>.<key>=<TOML-value>
        // The earlier `-c mcp_servers=<JSON>` form was rejected by Codex CLI
        // with "invalid type: string, expected a map", so it silently broke
        // the entire config load. Shared util lives in
        // managerAdapters/codexMcpFlatten.js and is reused by codexAdapter
        // (PM path) so worker/PM never drift.
        //
        // Fail-closed on invalid input (per Codex M1 review): silently
        // dropping an MCP block and still spawning would violate the
        // preset's intent — Codex supports `mcp_servers.<id>.required=true`
        // and a preset author choosing a required server expects spawn
        // failure, not a quiet degrade. We emit `preset:mcp_invalid` for
        // observability then throw; the outer catch on this try block
        // flips the run to failed and runs worktree cleanup.
        let extraArgs = [];
        if (mergedMcp && adapterName === 'codex') {
          // M2: detect alias conflicts with ~/.codex/config.toml BEFORE
          // flatten so the event lands on the run even if flatten later
          // throws. Annotate-only; Codex CLI will leaf-merge the two at
          // spawn regardless — preset author just gets a visible signal.
          const {
            scanCodexUserConfigAliases,
            detectLegacyAliasConflicts,
            resolveCodexUserConfigPath,
          } = require('./managerAdapters/codexUserConfigScan');
          const resolvedConfigPath = resolveCodexUserConfigPath();
          const userAliases = scanCodexUserConfigAliases(resolvedConfigPath);
          // perAliasSource mirrors mergeMcp3's precedence (preset wins
          // over project wins over skill pack). If merge precedence ever
          // changes, update this resolver in lockstep so the source hint
          // in the event payload still points at the actual winner.
          const perAliasSource = (alias) => {
            if (presetMcp && presetMcp.mcpServers && presetMcp.mcpServers[alias]) return 'preset';
            if (projectMcpObj && projectMcpObj.mcpServers && projectMcpObj.mcpServers[alias]) return 'project';
            if (skillPackMcp && skillPackMcp.mcpServers && skillPackMcp.mcpServers[alias]) return 'skillpack';
            return 'unknown';
          };
          const conflicts = detectLegacyAliasConflicts(mergedMcp, userAliases, {
            perAliasSource,
            configPath: resolvedConfigPath,
          });
          for (const c of conflicts) {
            runService.addRunEvent(run.id, 'mcp:legacy_alias_conflict', JSON.stringify({
              alias: c.alias,
              source: c.source,
              message: c.message,
            }));
          }
          const { flattenMcpToCodexArgs } = require('./managerAdapters/codexMcpFlatten');
          try {
            extraArgs = flattenMcpToCodexArgs(mergedMcp);
          } catch (err) {
            runService.addRunEvent(run.id, 'preset:mcp_invalid', JSON.stringify({
              adapter: 'codex',
              reason: err.message,
            }));
            throw new Error(`preset MCP invalid for codex worker: ${err.message}`);
          }
        } else if (mergedMcp && adapterName === 'opencode') {
          runService.addRunEvent(run.id, 'preset:mcp_unsupported', JSON.stringify({
            adapter: 'opencode',
            reason: 'opencode CLI has no MCP config flag — prompt-only injection applied',
          }));
        }
        const baseArgs = buildAgentArgs(profile, prompt, placeholders);
        const args = adapterName === 'codex' ? [...extraArgs, ...baseArgs] : baseArgs;
        result = await channelForNode(run.node_id).spawnWorker(run.id, {
          engine: 'cli',
          spec: {
            command: profile.command,
            args,
            cwd,
            env: parseEnvAllowlist(profile.env_allowlist, httpBearerEnvKeys),
            workerPath: isRemoteNode ? (node.node_prefix || undefined) : undefined,
          },
        });
      }

      // Mark run as started
      runService.markRunStarted(run.id, {
        tmux_session: result.sessionName || null,
        worktree_path: worktreePath,
        branch,
      });

      // Update task status to in_progress if not already
      if (task.status !== 'in_progress') {
        taskService.updateTaskStatus(taskId, 'in_progress');
      }

      return runService.getRun(run.id);
    } catch (error) {
      runService.updateRunStatus(run.id, 'failed', { force: true });
      runService.addRunEvent(run.id, 'error', JSON.stringify({ message: error.message }));
      // Awaited cleanup so the worktree AND the in-memory _runProjectDirs entry
      // are released even if monitoring/subscriber were never started or have
      // been torn down. cleanupRunWorktree is idempotent — the run:ended
      // subscriber that updateRunStatus may also trigger will be a safe no-op
      // the second time.
      await cleanupRunWorktree({
        id: run.id,
        is_manager: false,
        worktree_path: worktreePath,
        branch,
        task_id: run.task_id,
      });
      throw error;
    }
  }

  /**
   * Build command arguments from agent profile template.
   */
  function buildAgentArgs(profile, prompt, placeholders = {}) {
    if (!profile.args_template) return [prompt];

    const template = profile.args_template;
    // Split template into parts first, then replace placeholders as single args
    const parts = template.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const args = [];
    for (const part of parts) {
      if (part === '{prompt}') {
        args.push(prompt);
      } else if (part === '{system_prompt_file}') {
        // Skip placeholder entirely when no system prompt file was generated
        if (placeholders.system_prompt_file) args.push(placeholders.system_prompt_file);
      } else if (part.includes('{prompt}') || part.includes('{system_prompt_file}')) {
        let resolved = part;
        resolved = resolved.replace(/\{prompt\}/g, prompt);
        // Replace {system_prompt_file} or remove it if no file
        resolved = resolved.replace(/\{system_prompt_file\}/g, placeholders.system_prompt_file || '');
        if (resolved.trim()) args.push(resolved);
      } else {
        // Static template part — strip surrounding quotes if present
        args.push(part.replace(/^"(.*)"$/, '$1'));
      }
    }
    return args.length > 0 ? args : [prompt];
  }

  /**
   * Parse env_allowlist JSON and extract allowed env vars from process.env.
   *
   * M4-a: optional `bearerEnvKeys` extends the allowlist with per-template
   * bearer-token env var names so http MCP templates carry their token
   * forwarding into the worker spawn without hand-editing agent profile
   * env_allowlist. Keys are forwarded only if process.env has a value
   * (resolveBearerForPreflight already enforced that, but keep the guard
   * here so the spawn env doesn't carry noise empty entries).
   */
  function parseEnvAllowlist(allowlistJson, bearerEnvKeys) {
    try {
      const keys = JSON.parse(allowlistJson || '[]');
      const allowed = new Set(Array.isArray(keys) ? keys : []);
      if (Array.isArray(bearerEnvKeys)) {
        for (const k of bearerEnvKeys) {
          if (typeof k === 'string' && k) allowed.add(k);
        }
      }
      const env = {};
      for (const key of allowed) {
        if (process.env[key]) env[key] = process.env[key];
      }
      return env;
    } catch {
      return {};
    }
  }

  // Raw allowlist (array) for callers that need the key set, not the
  // materialized env map.
  function parseEnvAllowlistArray(allowlistJson) {
    try {
      const arr = JSON.parse(allowlistJson || '[]');
      return Array.isArray(arr) ? arr.filter(k => typeof k === 'string') : [];
    } catch {
      return [];
    }
  }

  /**
   * Parse mcp_tools from capabilities_json. Returns a filtered array of
   * non-empty strings, or [] if the field is absent / malformed.
   */
  function parseMcpTools(capabilitiesJson) {
    try {
      const caps = JSON.parse(capabilitiesJson || '{}');
      return Array.isArray(caps.mcp_tools)
        ? caps.mcp_tools.filter(t => typeof t === 'string' && t.trim())
        : [];
    } catch {
      return [];
    }
  }

  function createRetryRun(run) {
    const retryRun = runService.createRun({
      task_id: run.task_id,
      agent_profile_id: run.agent_profile_id,
      prompt: run.prompt || '',
      node_id: run.node_id || 'local',
      queued_args: run.queued_args || null,
      retry_count: Number(run.retry_count || 0) + 1,
    });
    runService.addRunEvent(retryRun.id, 'queue:retry', JSON.stringify({
      profile_id: run.agent_profile_id,
    }));
    return retryRun;
  }

  async function drainQueue(profileId, opts = {}) {
    if (!profileId) return 0;
    const onlyNodeId = opts && opts.nodeId ? String(opts.nodeId) : null;
    let profile;
    try {
      profile = agentProfileService.getProfile(profileId);
    } catch {
      return 0;
    }

    let started = 0;
    const nodeIds = [];
    const seen = new Set();
    for (const run of runService.listRuns({ status: 'queued' })) {
      if (run.is_manager || run.agent_profile_id !== profileId) continue;
      const nodeId = run.node_id || 'local';
      if (onlyNodeId && nodeId !== onlyNodeId) continue;
      if (!seen.has(nodeId)) {
        seen.add(nodeId);
        nodeIds.push(nodeId);
      }
    }

    for (const nodeId of nodeIds) {
      while (canDispatchOnNode(nodeId, profileId, profile)) {
        const next = typeof runService.getOldestQueuedOnNode === 'function'
          ? runService.getOldestQueuedOnNode(nodeId, profileId)
          : runService.getOldestQueued(profileId);
        if (!next) break;
        const spawned = await spawnQueuedRun(next.id);
        if (spawned) started++;
      }
    }
    return started;
  }

  async function drainAllQueues() {
    const profileIds = new Set();
    for (const run of runService.listRuns({ status: 'queued' })) {
      if (run.is_manager || !run.agent_profile_id) continue;
      profileIds.add(run.agent_profile_id);
    }

    let started = 0;
    for (const profileId of profileIds) {
      started += await drainQueue(profileId);
    }
    return started;
  }

  function scheduleDrain(profileId) {
    if (!profileId) return;
    setImmediate(() => {
      Promise.resolve(drainQueue(profileId)).catch((err) => {
        console.warn(`[lifecycle] Queue drain failed for profile ${profileId}: ${err.message}`);
      });
    });
  }

  function scheduleDrainForNode(nodeId) {
    const onlyNodeId = nodeId || 'local';
    const profileIds = new Set();
    try {
      for (const run of runService.listRuns({ status: 'queued' })) {
        if (run.is_manager || !run.agent_profile_id) continue;
        if ((run.node_id || 'local') !== onlyNodeId) continue;
        profileIds.add(run.agent_profile_id);
      }
    } catch (err) {
      console.warn(`[lifecycle] Queue drain scan failed for node ${onlyNodeId}: ${err.message}`);
      return;
    }

    for (const profileId of profileIds) {
      setImmediate(() => {
        Promise.resolve(drainQueue(profileId, { nodeId: onlyNodeId })).catch((err) => {
          console.warn(`[lifecycle] Queue drain failed for node ${onlyNodeId} profile ${profileId}: ${err.message}`);
        });
      });
    }
  }

  /**
   * Check health of all running runs.
   */
  async function checkHealth() {
    // Re-entrancy guard: prevent overlapping health checks
    if (healthCheckRunning) return;
    healthCheckRunning = true;

    try {
      await _doHealthCheck();
    } catch (err) {
      // _doHealthCheck now awaits remote (ssh) executor calls whose rejections
      // (network/ssh failures) are an EXPECTED failure mode. Swallow-and-log so
      // a flaky remote node can't turn setInterval(checkHealth) into an
      // unhandled promise rejection; the next tick retries. Codex P3b-3 review.
      // (Follow-up: per-run isolation so one bad node doesn't skip the rest of
      // the same tick.)
      console.warn(`[lifecycle] health check failed: ${err && err.message}`);
    } finally {
      sweepStuckQueuedRuns();
      healthCheckRunning = false;
    }
  }

  function sweepStuckQueuedRuns() {
    try {
      if (
        !runService
        || typeof runService.listRuns !== 'function'
        || typeof runService.getRunEvents !== 'function'
        || typeof runService.addRunEvent !== 'function'
      ) {
        return 0;
      }

      const queuedRuns = runService.listRuns({ status: 'queued' }) || [];
      const timestamp = nowMs();
      let annotated = 0;

      for (const run of queuedRuns) {
        try {
          if (!run || Number(run.is_manager || 0) === 1) continue;

          const nodeId = run.node_id || 'local';
          const createdAtMs = Date.parse(run.created_at || '');
          if (!Number.isFinite(createdAtMs)) continue;

          const waitedMs = timestamp - createdAtMs;
          if (!(waitedMs > QUEUE_STUCK_THRESHOLD_MS)) continue;

          const node = getDispatchNode(nodeId);
          if (!node) continue;

          const cordoned = Number(node.cordoned || 0) === 1;
          const reachable = Number(node.reachable) === 1;
          if (!cordoned && reachable) continue;

          const events = runService.getRunEvents(run.id) || [];
          if (events.some((event) => event.event_type === 'queue:stuck' || event.type === 'queue:stuck')) continue;

          runService.addRunEvent(run.id, 'queue:stuck', JSON.stringify({
            node_id: nodeId,
            reason: cordoned ? 'node_cordoned' : 'node_unreachable',
            waited_ms: waitedMs,
          }));
          annotated++;
        } catch {
          // Stuck annotations are observability only; one bad row must not
          // break the health loop or auto-fail a queued run.
        }
      }

      return annotated;
    } catch {
      return 0;
    }
  }

  async function _doHealthCheck() {
    const runningRuns = runService.listRuns({ status: 'running' });

    for (const run of runningRuns) {
      // Skip manager runs and streamJsonEngine workers — they manage their own lifecycle
      if (run.is_manager) continue;
      const channel = channelForNode(run.node_id);
      const owner = await channel.ownerOf(run.id);
      if (owner === 'stream-json') {
        // streamJsonEngine handles exit via its own event handler (result → updateRunStatus)
        // Just check for orphaned processes where exit was missed
        const alive = await channel.isAlive(run.id, 'stream-json');
        if (!alive) {
          const exitCode = await channel.detectExitCode(run.id, 'stream-json');
          if (exitCode !== null) {
            const status = exitCode === 0 ? 'completed' : 'failed';
            try { runService.updateRunStatus(run.id, status, { force: true }); } catch {}
            if (run.task_id) checkTaskCompletion(run.task_id);
          }
        }
        continue;
      }
      // Anything that is not stream-json-owned falls through to the cli
      // handling — the pre-channel code's else-default. Do NOT gate this on
      // ownerOf(...)==='cli': a dead/unknown run must still be terminalized
      // here, and skipping it would strand the run in 'running' forever.

      const alive = await channel.isAlive(run.id, 'cli');
      const exitCode = await channel.detectExitCode(run.id, 'cli');

      if (!alive || exitCode !== null) {
        // Agent has terminated
        const status = (exitCode === 0) ? 'completed' : 'failed';
        // v3 Phase 5: propagate the actual transition reason so
        // subscribers see WHY the run ended, not just that it did.
        const reason = exitCode === 0 ? 'agent-exit-success' : `agent-exit-error(${exitCode})`;
        const fromStatus = run.status;
        runService.updateRunStatus(run.id, status, { force: true, reason });

        if (exitCode !== null) {
          runService.updateRunResult(run.id, {
            exit_code: exitCode,
            result_summary: status === 'completed' ? 'Agent completed successfully' : `Agent exited with code ${exitCode}`,
          });
        }

        // Capture final output
        const output = await channel.getOutput(run.id, 200);
        if (output) {
          runService.addRunEvent(run.id, 'final_output', JSON.stringify({ output: output.slice(-2000) }));
        }

        // Transition task if all runs for this task are complete
        if (run.task_id) {
          checkTaskCompletion(run.task_id);
        }

        // Cleanup tmux session and output tracking
        await channel.kill(run.id, 'cli');
        _outputHashes.delete(run.id);

        if (eventBus) {
          // v3 Phase 5: enrich run:completed with the same semantic
          // envelope fields so clients can filter priority alerts
          // (task_id / project_id) without re-reading the row.
          const finalRun = runService.getRun(run.id);
          eventBus.emit('run:completed', {
            run: finalRun,
            from_status: fromStatus,
            to_status: status,
            reason,
            task_id: finalRun.task_id || null,
            project_id: finalRun.project_id || null,
            node_id: finalRun.node_id || null,
          });
        }
      } else {
        // Still alive — check if tmux output has changed (real activity indicator)
        const currentOutput = await channel.getOutput(run.id, 10);
        const outputHash = currentOutput ? currentOutput.length + ':' + currentOutput.slice(-100) : '';
        const prevHash = _outputHashes.get(run.id);
        _outputHashes.set(run.id, outputHash);

        if (outputHash !== prevHash) {
          // Output changed — agent is actively working, record heartbeat with snippet
          const snippet = currentOutput ? currentOutput.trim().split('\n').pop()?.slice(0, 200) : '';
          runService.addRunEvent(run.id, 'heartbeat', snippet ? JSON.stringify({ output: snippet }) : null);
        } else {
          // Output unchanged — but check if the process is still alive and consuming CPU
          // before declaring it idle. Agents may be thinking/processing without terminal output.
          const processStillActive = _isProcessActive(run.id);

          if (processStillActive) {
            // Process is alive and consuming CPU — agent is working, just no terminal output yet.
            // Record a heartbeat and let it keep running.
            runService.addRunEvent(run.id, 'heartbeat', JSON.stringify({ status: 'process_active_no_output' }));
          } else {
            // Process is idle or dead — check idle timeout
            const events = runService.getRunEvents(run.id);
            const lastEvent = events[events.length - 1];
            const lastActivity = lastEvent ? new Date(lastEvent.created_at).getTime() : new Date(run.started_at || run.created_at).getTime();
            const idleTime = Date.now() - lastActivity;

            if (idleTime > IDLE_TIMEOUT_MS) {
              // Double-check: is the process truly dead or just idle?
              const alive = await channel.isAlive(run.id, 'cli');
              if (!alive) {
                // Process is dead — finalize as completed/failed
                const exitCode = await channel.detectExitCode(run.id, 'cli');
                const status = (exitCode === 0) ? 'completed' : 'failed';
                runService.updateRunStatus(run.id, status, { force: true, reason: 'process_dead_after_idle' });
                if (run.task_id) checkTaskCompletion(run.task_id);
                await channel.kill(run.id, 'cli');
                _outputHashes.delete(run.id);
              } else {
                // Process alive but truly idle for too long — mark needs_input
                const fromStatus = run.status;
                runService.updateRunStatus(run.id, 'needs_input', { force: true, reason: 'idle_timeout' });
                runService.addRunEvent(run.id, 'idle_timeout', JSON.stringify({
                  message: `Agent idle for ${Math.round(idleTime / 60000)} minutes (process alive but no activity)`,
                  idleMs: idleTime,
                }));
                if (eventBus) {
                  const finalRun = runService.getRun(run.id);
                  eventBus.emit('run:needs_input', {
                    runId: run.id,
                    run: finalRun,
                    from_status: fromStatus,
                    to_status: 'needs_input',
                    reason: 'idle_timeout',
                    task_id: finalRun.task_id || null,
                    project_id: finalRun.project_id || null,
                    node_id: finalRun.node_id || null,
                    priority: 'alert',
                  });
                }
              }
            } else {
              runService.addRunEvent(run.id, 'heartbeat', null);
            }
          }
        }
      }
    }

    // Check needs_input runs — recover if tmux is still active and output changed
    const needsInputRuns = runService.listRuns({ status: 'needs_input' });
    for (const run of needsInputRuns) {
      if (run.is_manager) continue;
      // Skip streamJsonEngine runs — everything else falls through to the
      // cli handling (pre-channel else-default; see health loop note above).
      const channel = channelForNode(run.node_id);
      const owner = await channel.ownerOf(run.id);
      if (owner === 'stream-json') continue;

      const alive = await channel.isAlive(run.id, 'cli');
      if (alive) {
        // Check if output changed — agent may still be working
        const currentOutput = await channel.getOutput(run.id, 10);
        const outputHash = currentOutput ? currentOutput.length + ':' + currentOutput.slice(-100) : '';
        const prevHash = _outputHashes.get(run.id);
        _outputHashes.set(run.id, outputHash);

        if (outputHash !== prevHash && prevHash !== undefined) {
          // Output changed — agent is working, recover to running
          runService.updateRunStatus(run.id, 'running', { force: true });
          runService.addRunEvent(run.id, 'recovered', JSON.stringify({ message: 'Agent output detected, recovered from needs_input' }));
        }
      } else {
        // Process died while in needs_input
        const exitCode = await channel.detectExitCode(run.id, 'cli');
        const status = (exitCode === 0) ? 'completed' : 'failed';
        runService.updateRunStatus(run.id, status, { force: true });
        if (run.task_id) checkTaskCompletion(run.task_id);
        await channel.kill(run.id, 'cli');
        _outputHashes.delete(run.id);
      }
    }
  }

  /**
   * Check if all runs for a task are complete, and transition task accordingly.
   */
  function checkTaskCompletion(taskId) {
    const runs = runService.listRuns({ task_id: taskId });
    const allComplete = runs.every(r => ['completed', 'failed', 'cancelled', 'stopped'].includes(r.status));

    if (allComplete && runs.length > 0) {
      const hasSuccess = runs.some(r => r.status === 'completed');
      const hasFailed = runs.some(r => r.status === 'failed');
      const newStatus = hasSuccess ? 'review' : hasFailed ? 'failed' : 'todo';
      try {
        taskService.updateTaskStatus(taskId, newStatus);
      } catch {
        // task may have been deleted
      }
    }
  }

  /**
   * Crash recovery — detect orphan tmux sessions on startup.
   */
  async function recoverOrphanSessions() {
    // Boot orphan discovery remains executionEngine-direct; ghost sessions are
    // local tmux sessions.
    if (executionEngine.type !== 'tmux') return [];

    const ghostSessions = executionEngine.discoverGhostSessions();
    const recovered = [];

    for (const session of ghostSessions) {
      // Extract runId from session name (palantir-run-<runId>)
      const runId = session.name.replace('palantir-run-', '');

      try {
        const run = runService.getRun(runId);

        // If run is still marked as running in DB, it's a valid orphan
        if (run.status === 'running' || run.status === 'queued') {
          const alive = await workerChannel.isAlive(runId, 'cli');

          if (alive) {
            // Reattach: update DB to reflect tmux session
            // If still queued (spawn happened but markRunStarted didn't complete), mark as running
            if (run.status === 'queued') {
              runService.markRunStarted(runId, { tmux_session: session.name });
            }
            runService.addRunEvent(runId, 'recovered', JSON.stringify({
              message: 'Reattached after server restart',
              sessionName: session.name,
            }));
            recovered.push({ runId, status: 'reattached' });
          } else {
            // Session exists but agent terminated
            const exitCode = await workerChannel.detectExitCode(runId, 'cli');
            const status = (exitCode === 0) ? 'completed' : 'failed';
            runService.updateRunStatus(runId, status, { force: true });
            runService.updateRunResult(runId, {
              exit_code: exitCode,
              result_summary: status === 'completed'
                ? 'Agent completed (recovered after restart)'
                : `Agent exited with code ${exitCode} (recovered after restart)`,
            });
            await workerChannel.kill(runId, 'cli');
            // Check if task should transition
            if (run.task_id) {
              checkTaskCompletion(run.task_id);
            }
            recovered.push({ runId, status: 'terminated' });
          }
        }
      } catch {
        // Run not in DB — orphan tmux session from unknown source
        recovered.push({ runId, status: 'unknown_orphan', sessionName: session.name });
      }
    }

    return recovered;
  }

  /**
   * Start the heartbeat monitor.
   */
  function startMonitoring() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(checkHealth, HEARTBEAT_INTERVAL_MS);

    // Subscribe to run:ended so task status syncs immediately (not just on next health check),
    // and so worktrees get cleaned up regardless of which engine drove the termination
    // (tmux health check, streamJsonEngine exit handler, or explicit cancelRun all funnel here).
    // Stash the unsubscribe so stopMonitoring() can release the listener — without this,
    // tests that spin up multiple createApp() instances accumulate stale listeners.
    if (eventBus) {
      unsubscribeEventBus = eventBus.subscribe((event) => {
        if (event.channel !== 'run:ended') return;
        const run = event.data?.run;
        if (!run) return;
        const toStatus = event.data?.to_status || run.status;

        // Auto-retry only runs that entered the spawn path. started_at is set
        // exclusively by claimQueuedRun / markRunStarted, never by a bare
        // updateStatus — so a manual PATCH to 'failed' (tests, operator debug)
        // or a never-spawned row does NOT create a retry attempt (and can't
        // loop). A run that claimed then failed during setup (preflight/preset)
        // DOES retry once — that intentionally covers transient failures, and
        // retry_count caps it at MAX_RETRY.
        if (
          toStatus === 'failed'
          && !run.is_manager
          && run.started_at
          && Number(run.retry_count || 0) < MAX_RETRY
        ) {
          try {
            createRetryRun(run);
          } catch (err) {
            console.warn(`[lifecycle] Retry enqueue failed for run ${run.id}: ${err.message}`);
          }
        }

        if (run.task_id) checkTaskCompletion(run.task_id);
        if (run.is_manager) return;

        const reviewTarget = ['completed', 'failed'].includes(toStatus) && harvestService;
        if (reviewTarget) {
          const projectDir = resolveProjectDirForRun(run);
          setImmediate(() => {
            Promise.resolve(harvestService.harvestRun(run, { projectDir }))
              .catch((err) => {
                console.warn(`[lifecycle] Harvest failed for run ${run.id}: ${err.message}`);
              })
              .finally(() => cleanupRunRuntimeFiles(run).catch((err) => {
                console.warn(`[lifecycle] Runtime cleanup failed for run ${run.id}: ${err.message}`);
              }));
          });
        } else {
          cleanupRunWorktree(run).catch((err) => {
            console.warn(`[lifecycle] Worktree cleanup failed for run ${run.id}: ${err.message}`);
          });
        }

        scheduleDrain(run.agent_profile_id);
      });
    }

    console.log(`[lifecycleService] Health monitor started (${HEARTBEAT_INTERVAL_MS}ms interval)`);
  }

  /**
   * Stop the heartbeat monitor.
   */
  function stopMonitoring() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      console.log('[lifecycleService] Health monitor stopped');
    }
    if (unsubscribeEventBus) {
      try { unsubscribeEventBus(); } catch { /* ignore */ }
      unsubscribeEventBus = null;
    }
  }

  /**
   * Send input to a running agent.
   */
  function finishSendAgentInput(run, text, sent) {
    if (sent) {
      runService.addRunEvent(run.id, 'user_input', JSON.stringify({ text }));
      if (run.status === 'needs_input') {
        runService.updateRunStatus(run.id, 'running', { force: true });
      }
    }
    return sent;
  }

  function sendAgentInput(runId, text) {
    const run = runService.getRun(runId);
    if (run.status !== 'running' && run.status !== 'needs_input') {
      throw new Error(`Cannot send input to run in status: ${run.status}`);
    }

    const sent = channelForNode(run.node_id).sendInput(runId, text);
    if (isThenable(sent)) {
      return sent.then((resolved) => finishSendAgentInput(run, text, resolved));
    }
    return finishSendAgentInput(run, text, sent);
  }

  /**
   * Cancel a running agent.
   */
  function finishCancelRun(run) {
    runService.updateRunStatus(run.id, 'cancelled', { force: true });
    if (run.task_id) {
      checkTaskCompletion(run.task_id);
    }
    return runService.getRun(run.id);
  }

  function cancelRun(runId) {
    const run = runService.getRun(runId);
    // Don't cancel already-terminal runs
    if (['completed', 'failed', 'cancelled', 'stopped'].includes(run.status)) {
      return run;
    }
    const killed = channelForNode(run.node_id).kill(runId);
    if (isThenable(killed)) {
      return killed.then(() => finishCancelRun(run));
    }
    return finishCancelRun(run);
  }

  /**
   * Clean up orphan MCP config files from runtime/mcp/ on boot.
   * Files whose runs are no longer active (not running/queued) are removed.
   */
  function cleanupOrphanMcpConfigs() {
    const fs = require('node:fs');
    const path = require('node:path');
    const mcpDir = path.resolve(process.cwd(), 'runtime', 'mcp');
    if (!fs.existsSync(mcpDir)) return 0;
    let cleaned = 0;
    try {
      const files = fs.readdirSync(mcpDir);
      for (const file of files) {
        // Clean both .json (MCP config) and .md (system prompt) files
        if (!file.endsWith('.json') && !file.endsWith('.md')) continue;
        const runId = file.replace('.json', '').replace('-system-prompt.md', '').replace('.md', '');
        try {
          const run = runService.getRun(runId);
          if (!['running', 'queued'].includes(run.status)) {
            fs.unlinkSync(path.join(mcpDir, file));
            cleaned++;
          }
        } catch {
          // Run not found — orphan file
          fs.unlinkSync(path.join(mcpDir, file));
          cleaned++;
        }
      }
    } catch (err) {
      console.warn(`[lifecycle] Orphan MCP config cleanup failed: ${err.message}`);
    }
    return cleaned;
  }

  /**
   * Boot cleanup for terminal runs whose worktree survived a server exit.
   * Harvest is not retried here (B-lite); the default removeWorktree autosave
   * preserves any uncommitted agent work before pruning the stale checkout.
   */
  async function cleanupStaleTerminalWorktrees() {
    if (!worktreeService) return 0;
    const terminalStatuses = ['completed', 'failed', 'cancelled', 'stopped'];
    let cleaned = 0;
    for (const status of terminalStatuses) {
      let runs = [];
      try { runs = runService.listRuns({ status }); } catch { runs = []; }
      for (const run of runs) {
        if (run.is_manager || !run.worktree_path || !run.branch) continue;
        if (!await nodeExecutor.fileExists(run.worktree_path)) continue;
        const projectDir = resolveProjectDirForRun(run);
        if (!projectDir) continue;
        try {
          await worktreeService.removeWorktree(projectDir, run.worktree_path, run.branch, { runId: run.id });
          cleaned++;
        } catch (err) {
          console.warn(`[lifecycle] Stale terminal worktree cleanup failed for run ${run.id}: ${err.message}`);
        } finally {
          await cleanupRunRuntimeFiles(run);
        }
      }
    }
    return cleaned;
  }

  return {
    executeTask,
    spawnQueuedRun,
    drainQueue,
    drainAllQueues,
    scheduleDrainForNode,
    checkHealth,
    sweepStuckQueuedRuns,
    recoverOrphanSessions,
    cleanupOrphanMcpConfigs,
    cleanupStaleTerminalWorktrees,
    startMonitoring,
    stopMonitoring,
    sendAgentInput,
    cancelRun,
  };
}

module.exports = { createLifecycleService };
