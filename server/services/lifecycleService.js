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

const path = require('node:path');
const { createLocalNodeExecutor, createLocalWorkerChannel } = require('./nodeExecutor');
const { explainDispatch } = require('./dispatchPolicy');
const { resolveProjectSource } = require('./projectSource');
const { createProjectMaterializationService } = require('./projectMaterializationService');
const { validateStructuredModelEffort } = require('./agentProfileService');
const { compileGoalPrompt } = require('./goalPrompt'); // G1
const { parseGoalReport } = require('./goalReport'); // G1
const { createGoalVerdictService } = require('./goalVerdictService'); // G3
const { VERDICT_TO_TASK_STATUS } = require('./goalVerdict'); // G3

// G1: cap a string to at most maxBytes UTF-8 bytes without splitting a
// multi-byte codepoint (final_output is stored raw; the 64KB bound is on bytes,
// not chars). Truncates at a real codepoint boundary \u2014 it backs the cut off
// any trailing continuation bytes rather than letting toString emit/strip a
// replacement char, so legitimate U+FFFD content is preserved. null \u2192 null.
function capUtf8Bytes(value, maxBytes) {
  if (value == null) return null;
  const str = String(value);
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) return str;
  // If the byte at the cut is a UTF-8 continuation byte (0b10xxxxxx), the
  // codepoint straddles the boundary \u2014 back off until the next dropped byte
  // starts a new codepoint, so we never split one.
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xC0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

// G1: file-backed output log for a local goal worker (§5k-2 — codex/tmux/
// subprocess tee their stdout here so capture does not depend on the volatile
// process-local buffer and survives a restart). runId is sanitized to a safe
// filename segment. Returns null for a blank id.
function goalOutputLogPath(runId) {
  const safe = String(runId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) return null;
  return path.resolve(process.cwd(), 'runtime', 'goal-output', `${safe}.log`);
}

// G2 §5k-1: isolated deliverable-mode workspace for a local goal run with no
// git workspace. Server-controlled path under runtime/ with a sanitized runId
// segment (a blank id yields null so the caller fails closed rather than
// materializing at the runtime root).
function goalWorkspaceDir(runId) {
  const safe = String(runId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) return null;
  return path.resolve(process.cwd(), 'runtime', 'goal-workspaces', safe);
}

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
  projectMaterializationService,
  maxMaterializingPerNode,
  maxMaterializingGlobal,
  materializeStuckMs,
  queueStuckMs,
  now,
  // G2 §6 (Codex BLOCKER-1): goal features only activate when goal mode is on
  // AND the PM token is separated. Injectable for tests; defaults to the real
  // env-derived gate. When it returns false, a goal_enabled task runs exactly
  // like a normal task (no goal workspace / no acceptance) — the security
  // precondition (token scrub) and the goal features move in lock-step.
  goalFeatureActive = require('./goalMode').goalFeatureActive,
  // G3c §5k-4: the Gate 1.5 judge activation gate. Default DERIVES from the SAME
  // (injectable) goalFeatureActive + the judge flag, so an injected goal gate
  // never diverges from the judge gate (codex MINOR). Stamped per-run at spawn.
  goalJudgeActive = (e) => goalFeatureActive(e) && ((e || process.env).PALANTIR_GOAL_JUDGE === '1'),
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
  const MATERIALIZE_STUCK_THRESHOLD_MS = (() => {
    const raw = materializeStuckMs !== undefined ? Number(materializeStuckMs) : Number(process.env.PALANTIR_MATERIALIZE_STUCK_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60 * 1000;
  })();
  const MAX_MATERIALIZING_PER_NODE = (() => {
    const raw = maxMaterializingPerNode !== undefined ? Number(maxMaterializingPerNode) : Number(process.env.PALANTIR_MAX_MATERIALIZING_PER_NODE);
    return Number.isInteger(raw) && raw > 0 ? raw : 2;
  })();
  const MAX_MATERIALIZING_GLOBAL = (() => {
    const raw = maxMaterializingGlobal !== undefined ? Number(maxMaterializingGlobal) : Number(process.env.PALANTIR_MAX_MATERIALIZING_GLOBAL);
    return Number.isInteger(raw) && raw > 0 ? raw : 4;
  })();
  const nowMs = typeof now === 'function' ? now : Date.now;
  const MAX_RETRY = 1;
  // G1: goal final-output capture bounds (§5k-2 — final_output cap 64KB).
  const GOAL_FINAL_OUTPUT_MAX_BYTES = 64 * 1024;
  const GOAL_OUTPUT_LINES = 2000; // read a generous tail so the report fence is included
  const MAX_MATERIALIZE_ATTEMPTS = 3;
  let heartbeatTimer = null;
  let goalSweepTimer = null; // G3: periodic verdict-loop self-heal
  const GOAL_SWEEP_INTERVAL_MS = 60000; // 60s — runtime self-heal for missed settles/drains
  let healthCheckRunning = false; // Re-entrancy guard
  let unsubscribeEventBus = null; // for stopMonitoring teardown
  const _outputHashes = new Map(); // Track tmux output changes per run
  // runId → projectDir snapshot captured at executeTask time. Used as a fallback
  // for worktree cleanup when the run→task→project chain has been broken (e.g. the
  // task or project was deleted while the run was still in flight).
  const _runProjectDirs = new Map();
  const _materializationTimers = new Set();
  const materializationService = projectMaterializationService || (
    nodeService
      ? createProjectMaterializationService({
        runService,
        projectService,
        nodeService,
        eventBus,
        logger: console,
      })
      : null
  );

  function repoFeatureEnabled() {
    return process.env.PALANTIR_PROJECT_REPO !== '0';
  }

  function projectIsRepo(project) {
    try {
      return resolveProjectSource(project || {}).isRepo;
    } catch {
      return false;
    }
  }

  function isMissingFileError(err) {
    return err && (
      err.code === 'ENOENT'
      || err.code === 'ENOTDIR'
      || /no such file/i.test(err.message || '')
      || /not found/i.test(err.message || '')
    );
  }

  function emitRepoMcpWarning(run, type, payload) {
    const body = { type, ...payload };
    runService.addRunEvent(run.id, type, JSON.stringify(body));
    console.warn(`[lifecycle] ${type}: ${payload.message || payload.relpath || payload.reason || 'repo MCP warning'}`);
  }

  function validateRepoMcpRelpath(relpath, workspaceRoot) {
    if (!relpath || typeof relpath !== 'string') {
      throw new Error('mcp_config_relpath is required for repo_relpath MCP config');
    }
    if (path.isAbsolute(relpath) || path.win32.isAbsolute(relpath)) {
      throw new Error('mcp_config_relpath must be relative to the materialized workspace');
    }
    const parts = relpath.split(/[\\/]+/).filter(Boolean);
    if (parts.some((part) => part === '..')) {
      throw new Error('mcp_config_relpath escapes materialized workspace');
    }
    const joined = path.resolve(workspaceRoot, relpath);
    if (joined !== workspaceRoot && !joined.startsWith(workspaceRoot + path.sep)) {
      throw new Error('mcp_config_relpath escapes materialized workspace boundary');
    }
    return joined;
  }

  async function resolveProjectMcpObject({
    run,
    project,
    projectDir,
    projectMcpConfig,
    usesMaterializedRepoWorkspace,
    isRemoteNode,
  }) {
    if (!project) return null;

    const mcpSource = project.mcp_config_source || 'legacy_control_plane_path';
    if (mcpSource === 'legacy_control_plane_path') {
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
          return JSON.parse(fsM.readFileSync(realMcpPath, 'utf8'));
        } catch (err) {
          console.warn(`[lifecycle] Failed to read project MCP config: ${err.message}`);
        }
      }
      return null;
    }

    if (mcpSource !== 'repo_relpath') {
      // Unknown source (should be unreachable — projects.mcp_config_source has a
      // DB CHECK restricting it to the two known values). A typo that somehow
      // bypasses the CHECK must NOT silently disable a legacy mcp_config_path,
      // so surface it explicitly (Codex PR4 review NIT).
      emitRepoMcpWarning(run, 'mcp:unknown_source', {
        project_id: project.id,
        source: mcpSource,
        reason: 'unrecognized mcp_config_source; no project MCP config applied',
      });
      return null;
    }

    const relpath = project.mcp_config_relpath;
    if (!projectIsRepo(project) || !usesMaterializedRepoWorkspace || !run.workspace_path) {
      emitRepoMcpWarning(run, 'mcp:repo_relpath_unmaterialized', {
        project_id: project.id,
        relpath,
        reason: 'repo_relpath requires a materialized git workspace',
      });
      return null;
    }

    const workspaceRoot = path.resolve(run.workspace_path);
    const joined = validateRepoMcpRelpath(relpath, workspaceRoot);

    let text;
    try {
      if (isRemoteNode) {
        if (!nodeService || typeof nodeService.pickExecutor !== 'function') {
          throw new Error('nodeService.pickExecutor is required to read remote repo MCP config');
        }
        const executor = nodeService.pickExecutor(run.node_id || 'local');
        if (!executor || typeof executor.readFile !== 'function') {
          throw new Error('executor.readFile is required to read remote repo MCP config');
        }
        text = await executor.readFile(joined);
      } else {
        const fsM = require('node:fs');
        const realRoot = fsM.realpathSync(workspaceRoot);
        const realMcpPath = fsM.realpathSync(joined);
        if (realMcpPath !== realRoot && !realMcpPath.startsWith(realRoot + path.sep)) {
          throw new Error('mcp_config_relpath escapes materialized workspace boundary');
        }
        text = fsM.readFileSync(realMcpPath, 'utf8');
      }
    } catch (err) {
      // Warn payloads carry only relpath + err.code — NEVER the raw err.message,
      // which for read/ENOENT errors embeds the absolute pod/control-plane path
      // (e.g. "ENOENT ... open '/srv/.../workspace/.mcp.json'") and would leak
      // the pod filesystem layout into run events / DB (Codex PR4 R2 NIT).
      if (isMissingFileError(err)) {
        emitRepoMcpWarning(run, 'mcp:repo_relpath_missing', {
          project_id: project.id,
          relpath,
          code: err.code || null,
          message: 'repo MCP config file not found',
        });
        return null;
      }
      emitRepoMcpWarning(run, 'mcp:repo_relpath_read_failed', {
        project_id: project.id,
        relpath,
        code: err.code || null,
        message: 'failed to read repo MCP config',
      });
      // Re-throw a sanitized error (relpath only) so the downstream executeTask
      // 'error' event does not surface the absolute path from the original err.
      throw new Error(`Failed to read repo MCP config ${relpath}`);
    }

    try {
      return JSON.parse(text);
    } catch (err) {
      // JSON.parse errors are position-based (no filesystem path), so err.message
      // is safe to surface for debugging the malformed config.
      emitRepoMcpWarning(run, 'mcp:repo_relpath_parse_failed', {
        project_id: project.id,
        relpath,
        message: err.message,
      });
      throw new Error(`Failed to parse repo MCP config ${relpath}: ${err.message}`);
    }
  }

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

  function normalizeRepoSubdir(subdir) {
    if (!subdir) return null;
    const raw = String(subdir).trim();
    if (!raw) return null;
    if (path.isAbsolute(raw)) throw new Error('repo_subdir must be relative');
    const parts = raw.split(/[\\/]+/).filter(Boolean);
    if (parts.some((part) => part === '.' || part === '..')) {
      throw new Error('repo_subdir escapes repository root');
    }
    return parts.join(path.sep);
  }

  function resolveMaterializedRepoCwd(run, project) {
    if (!run?.workspace_path || !run.resolved_commit) return null;
    const sourceGeneration = Number(project?.source_generation || 0);
    if (Number(run.workspace_generation) !== sourceGeneration) return null;
    const subdir = normalizeRepoSubdir(run.repo_subdir_snapshot || project?.repo_subdir || null);
    return subdir ? path.join(run.workspace_path, subdir) : run.workspace_path;
  }

  function countMaterializingOnNode(nodeId) {
    if (runService && typeof runService.countMaterializingOnNode === 'function') {
      return runService.countMaterializingOnNode(nodeId || 'local');
    }
    return 0;
  }

  function countMaterializingGlobal() {
    if (runService && typeof runService.countMaterializingGlobal === 'function') {
      return runService.countMaterializingGlobal();
    }
    return 0;
  }

  function canMaterializeOnNode(nodeId) {
    if (!repoFeatureEnabled() || !materializationService) return false;
    const node = getDispatchNode(nodeId);
    if (!node) return false;
    if (Number(node.reachable) !== 1) return false;
    if (Number(node.cordoned || 0) === 1) return false;
    if (Number(node.can_execute) !== 1 || Number(node.files_only || 0) === 1) return false;
    if (countMaterializingOnNode(node.id || nodeId || 'local') >= MAX_MATERIALIZING_PER_NODE) return false;
    if (countMaterializingGlobal() >= MAX_MATERIALIZING_GLOBAL) return false;
    return true;
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

    if (runService && typeof runService.releaseWorkspaceRefByRun === 'function') {
      try {
        runService.releaseWorkspaceRefByRun(run.id);
      } catch (err) {
        console.warn(`[lifecycle] Workspace ref release failed for run ${run.id}: ${err.message}`);
      }
    }

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

    // G1: remove the goal output tee log (capture ran before this in the chain).
    // No-op when absent (non-goal / remote runs never created one).
    const goalLog = goalOutputLogPath(run.id);
    if (goalLog) {
      try { require('node:fs').unlinkSync(goalLog); } catch { /* absent → nothing to clean */ }
    }
    // G2 §5k-1: remove the deliverable-mode goal workspace (the deliverable
    // harvest stage copies it out FIRST, so this is the final sweep). No-op when
    // absent. Belt-and-suspenders against interim workspace leaks.
    const goalWs = goalWorkspaceDir(run.id);
    if (goalWs) {
      try { require('node:fs').rmSync(goalWs, { recursive: true, force: true }); } catch { /* best-effort */ }
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
  function deriveOperatorDispatchAttribution(pmRunId, task) {
    if (!pmRunId || typeof pmRunId !== 'string') {
      return { operator_instance_id: null, parent_run_id: null, unwatched: null };
    }

    let pmRun = null;
    try {
      pmRun = runService.getRun(pmRunId);
    } catch {
      return { operator_instance_id: null, parent_run_id: null, unwatched: null };
    }
    if (!pmRun || Number(pmRun.is_manager || 0) !== 1 || pmRun.manager_layer !== 'operator') {
      return { operator_instance_id: null, parent_run_id: null, unwatched: null };
    }
    if (!runService || typeof runService.resolveOperatorConversationId !== 'function') {
      return { operator_instance_id: null, parent_run_id: null, unwatched: null };
    }

    const resolved = runService.resolveOperatorConversationId(pmRun.conversation_id);
    if (!resolved?.instanceId) {
      return { operator_instance_id: null, parent_run_id: null, unwatched: null };
    }

    const taskProjectId = task?.project_id || null;
    if (taskProjectId) {
      const hasRef = typeof runService.operatorInstanceHasRef === 'function'
        ? runService.operatorInstanceHasRef(resolved.instanceId, taskProjectId)
        : (resolved.legacyProjectId || resolved.primaryProjectId || null) === taskProjectId;
      if (!hasRef) {
        return {
          operator_instance_id: null,
          parent_run_id: null,
          unwatched: {
            pm_run_id: pmRun.id,
            operator_instance_id: resolved.instanceId,
            task_id: task?.id || null,
            project_id: taskProjectId,
            reason: 'operator_instance_ref_missing',
          },
        };
      }
    }

    return { operator_instance_id: resolved.instanceId, parent_run_id: pmRun.id, unwatched: null };
  }

  async function executeTask(taskId, { agentProfileId, prompt, skillPackIds, presetId, pmRunId }) {
    const task = taskService.getTask(taskId);
    const profile = agentProfileService.getProfile(agentProfileId);
    let nodeId = 'local';
    let project = null;
    if (task.project_id) {
      project = projectService.getProject(task.project_id);
      nodeId = resolveProjectNode(project);
    }

    // Phase 10C: resolve preferred preset. Explicit argument wins over
    // task.preferred_preset_id so callers can override per-execute.
    const effectivePresetId = presetId || task.preferred_preset_id || null;
    const operatorAttribution = deriveOperatorDispatchAttribution(pmRunId, task);

    const run = runService.createRun({
      task_id: taskId,
      agent_profile_id: agentProfileId,
      prompt,
      node_id: nodeId,
      queued_args: buildQueuedArgs({ skillPackIds, presetId: effectivePresetId }),
      retry_count: 0,
      operator_instance_id: operatorAttribution.operator_instance_id,
      parent_run_id: operatorAttribution.parent_run_id,
    });

    if (operatorAttribution.unwatched) {
      try {
        runService.addRunEvent(run.id, 'dispatch:unwatched_codebase', JSON.stringify(operatorAttribution.unwatched));
      } catch { /* annotate-only */ }
    }

    if (repoFeatureEnabled() && projectIsRepo(project)) {
      await drainQueue(agentProfileId, { nodeId });
      const current = runService.getRun(run.id);
      if (current.status === 'queued') {
        runService.addRunEvent(run.id, 'queue:enqueued', JSON.stringify({
          profile_id: agentProfileId,
          node_id: nodeId,
          reason: 'repo_materialization_pending',
        }));
      }
      return current;
    }

    if (canDispatchOnNode(nodeId, agentProfileId, profile)) {
      return (await spawnQueuedRun(run.id)) || runService.getRun(run.id);
    }

    runService.addRunEvent(run.id, 'queue:enqueued', JSON.stringify({
      profile_id: agentProfileId,
      node_id: nodeId,
    }));
    return runService.getRun(run.id);
  }

  // G3 SERIOUS-2: compose the retry child's attempt-feedback from the PRIOR
  // attempt (the run that pointed its goal_retry_run_id at this child) — the
  // verdict reason + Gate 1 acceptance outcome + a bounded output tail. Returns
  // null when there is no prior attempt or nothing useful to say. Never throws.
  function buildGoalAttemptFeedback(childRun) {
    let parent = null;
    try { parent = runService.getGoalRetryParent(childRun.id); } catch { parent = null; }
    if (!parent) return null;
    const parts = [];
    if (parent.goal_verdict_reason) parts.push(`이전 판정 사유: ${parent.goal_verdict_reason}`);
    if (parent.acceptance_json) {
      try {
        const a = JSON.parse(parent.acceptance_json);
        if (a && a.gate) {
          const outcome = a.passed ? 'PASS' : (a.status === 'skipped' ? `SKIPPED(${a.reason || 'runner_unavailable'})` : 'FAIL');
          parts.push(`Gate 1 검증 [${a.name || a.kind || 'check'}]: ${outcome}`);
          const tail = (typeof a.output_tail === 'string' && a.output_tail) || (typeof a.reason === 'string' && !a.passed ? a.reason : null);
          if (tail) parts.push(`검증 출력(일부):\n${String(tail).slice(-800)}`);
        }
      } catch { /* acceptance unparseable — reason line still helps */ }
    }
    // G3c §5k-4: the prior attempt's Gate 1.5 judge reasons (why the rubric judge
    // rejected the content) — the highest-signal retry feedback for content tasks.
    if (parent.judge_json) {
      try {
        const j = JSON.parse(parent.judge_json);
        if (j && j.status === 'fail' && Array.isArray(j.reasons) && j.reasons.length) {
          parts.push(`판정(Gate 1.5) 실패 사유:\n- ${j.reasons.slice(0, 5).map((r) => String(r)).join('\n- ')}`);
        }
      } catch { /* judge reasons unparseable — other feedback still helps */ }
    }
    // Plain process failure (no gate/reason): still give the agent a signal that
    // it is retrying + the prior run's summary, so the loop is never fully blind.
    if (!parts.length) {
      if (parent.status === 'failed') parts.push('이전 시도가 실패로 종료되었습니다 (완료 기준 미충족).');
      if (parent.result_summary) parts.push(`이전 실행 요약(일부):\n${String(parent.result_summary).slice(-800)}`);
    }
    return parts.length ? parts.join('\n') : null;
  }

  // Reject a worker run BEFORE it is claimed (Codex P2/P3 review):
  //   - runService.rejectQueuedRun is an atomic CAS (queued→failed + retry_count
  //     in one UPDATE): idempotent, never fails a running/terminal run, emits the
  //     run:status/run:ended envelope. retry_count=MAX makes B-lite skip even a
  //     requeued run whose started_at was preserved.
  //   - A pre-claim reject leaves goal_active=0 (it is stamped only AFTER claim),
  //     so goalVerdictService.settle() ignores the run → no goal retry either.
  //     The run therefore never becomes a goal ATTEMPT; the specific event
  //     (worker:profile_invalid / run:budget_exceeded) carries the reason.
  //   Returns true iff it won the CAS (was still queued).
  function rejectQueuedWorker(runId, eventType, payload, reason) {
    const won = runService.rejectQueuedRun(runId, { reason, retryCount: MAX_RETRY });
    if (won) runService.addRunEvent(runId, eventType, JSON.stringify(payload));
    return won;
  }

  async function spawnQueuedRun(runId) {
    // P2-A2: fail-closed structured-field backstop BEFORE claim (non-retryable).
    // Catches raw-SQL-contaminated profiles that bypassed the save-time
    // validation.
    const _pending = runService.getRun(runId);
    if (_pending && _pending.status === 'queued' && !_pending.is_manager && _pending.agent_profile_id) {
      let _prof = null;
      try { _prof = agentProfileService.getProfile(_pending.agent_profile_id); } catch { _prof = null; }
      if (_prof) {
        try { validateStructuredModelEffort(_prof); }
        catch (err) {
          rejectQueuedWorker(runId, 'worker:profile_invalid', { reason: err.message }, 'worker_profile_invalid');
          return null;
        }
      }
    }
    // Phase 3 (cost cap): opt-in project budget constraint, enforced BEFORE claim
    // (non-retryable). REJECT over budget — never a silent model downgrade.
    // Opt-in: only when projects.budget_usd is a positive number → NULL is
    // byte-identical (no check). A cap is a soft, spend-governance guard, so a
    // LOOKUP error fails OPEN (spawn proceeds) — a budget-check bug must not halt
    // all of a project's work; only an actual over-budget state rejects.
    if (_pending && _pending.status === 'queued' && !_pending.is_manager && _pending.task_id) {
      // The LOOKUP is fail-open (a budget-check bug must not halt a project's
      // work), but the REJECT write must NOT be swallowed by that catch — so
      // compute over-budget inside try, then reject outside it.
      let _over = null;
      try {
        const _task = taskService.getTask(_pending.task_id);
        const _project = _task && _task.project_id ? projectService.getProject(_task.project_id) : null;
        // Opt-out is NULL ONLY. Any non-null budget_usd is a cap; 0 / negative
        // caps everything (spent >= cap always true), consistent with the
        // "NULL = no cap" invariant (Codex P3 review: `> 0` wrongly opted out 0).
        const _cap = _project && _project.budget_usd != null ? Number(_project.budget_usd) : null;
        if (_cap != null && Number.isFinite(_cap)) {
          const _spent = runService.sumProjectCost(_project.id);
          if (_spent >= _cap) _over = { project_id: _project.id, spent: _spent, budget_usd: _cap };
        }
      } catch { /* fail-open on lookup error — never block work on a budget-check bug */ }
      if (_over) {
        rejectQueuedWorker(runId, 'run:budget_exceeded', _over, 'budget_exceeded');
        return null;
      }
    }
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
    let prompt = run.prompt || '';
    const task = taskService.getTask(taskId);
    // Single goal-activation decision, stamped ONCE per run at spawn (Codex
    // holistic review): goalFeatureActive() is evaluated here and persisted to
    // runs.goal_active — every downstream per-run goal surface (capture,
    // workspace, Gate 1 acceptance, deliverable) reads that column instead of
    // re-evaluating the env gate, so a mid-flight config change cannot strand a
    // run. A goal task under goal-mode-off is a normal task (goal_active=0).
    // A retry child already carries goal_active=1 (stamped in the verdict tx);
    // HONOR that instead of re-evaluating the live flag, so a mid-lineage
    // PALANTIR_GOAL_MODE flip cannot strand a retry (spawn a non-goal prompt yet
    // still route into settle via its goal_active=1 row) — codex review MINOR-5.
    const goalActive = !!run.goal_active || !!(task && task.goal_enabled && goalFeatureActive());
    if (goalActive) {
      // The stamp MUST persist — capture + harvest read runs.goal_active, so a
      // swallowed failure would run the goal prompt/workspace yet be treated as
      // non-goal downstream (Codex review). Fail closed instead of executing in
      // that inconsistent state. (goal_active defaults to 0, so a non-goal run
      // needs no write.)
      try {
        runService.setGoalActive(run.id, 1);
      } catch (err) {
        runService.addRunEvent(run.id, 'goal:activation_persist_failed', JSON.stringify({ reason: err.message }));
        runService.setRetryCount(run.id, MAX_RETRY);
        runService.updateRunStatus(run.id, 'failed', { force: true, reason: 'goal_activation_persist_failed' });
        return null;
      }
      // G3c §5k-4: stamp the Gate 1.5 judge activation ONCE at spawn (mirrors
      // goal_active) so harvest reads a durable per-run decision, not a re-evaluated
      // flag. = goal-active + task opt-in + the judge flag. Fail-closed on a stamp
      // failure (a run that would be judged must not silently skip it).
      const judgeActive = !!(task && task.goal_judge_enabled) && goalJudgeActive();
      if (judgeActive) {
        try {
          runService.setGoalJudgeActive(run.id, 1);
        } catch (err) {
          runService.addRunEvent(run.id, 'goal:activation_persist_failed', JSON.stringify({ reason: err.message, stage: 'judge' }));
          runService.setRetryCount(run.id, MAX_RETRY);
          runService.updateRunStatus(run.id, 'failed', { force: true, reason: 'goal_activation_persist_failed' });
          return null;
        }
      }
    }
    // A goal-active worker gets the deterministic goal prompt (goal + acceptance
    // criteria + completion-report request). Non-goal / goal-mode-off tasks are
    // completely unchanged. G3: a retry child (retry_count>0) is told its real
    // attempt number and given the PRIOR attempt's failure feedback (verdict
    // reason + gate/test outcome) so the retried agent knows it is retrying and
    // why — otherwise the loop is blind (codex review SERIOUS-2).
    if (goalActive) {
      const attemptNumber = Number(run.retry_count || 0) + 1;
      const attemptFeedback = attemptNumber > 1 ? buildGoalAttemptFeedback(run) : null;
      prompt = compileGoalPrompt({
        task,
        attemptNumber,
        maxAttempts: task.goal_max_attempts,
        callerPrompt: run.prompt,
        attemptFeedback,
      });
    }
    const profile = agentProfileService.getProfile(agentProfileId);
    try {
      runService.setSessionSnapshot(run.id, {
        sessionModel: profile.model || null,
        sessionEffort: profile.reasoning_effort || null,
      });
    } catch { /* annotate-only */ }
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
    let usesMaterializedRepoWorkspace = false;
    if (task.project_id) {
      project = projectService.getProject(task.project_id);
      if (projectIsRepo(project)) {
        if (repoFeatureEnabled()) {
          projectDir = resolveMaterializedRepoCwd(run, project);
          if (!projectDir) {
            runService.addRunEvent(run.id, 'run:repo_materialize_unavailable', JSON.stringify({ project_id: project.id }));
            runService.updateRunStatus(run.id, 'failed', { force: true, reason: 'repo_materialize_unavailable' });
            return runService.getRun(run.id);
          }
          usesMaterializedRepoWorkspace = true;
        } else {
          runService.addRunEvent(run.id, 'run:repo_materialize_unavailable', JSON.stringify({ project_id: project.id }));
          runService.updateRunStatus(run.id, 'failed', { force: true, reason: 'repo_materialize_unavailable' });
          // Return the FAILED run row (not null) to match executeTask's contract:
          // callers (routes/tasks.js) respond `{ run }`, so the client sees the
          // failed status + reason rather than a misleading `{ run: null }` 201
          // (Codex R2 review NIT).
          return runService.getRun(run.id);
        }
      }
      if (!usesMaterializedRepoWorkspace && project?.directory) {
        if (isRemoteNode) {
          projectDir = project.directory;
        } else if (await nodeExecutor.fileExists(project.directory)) {
          projectDir = project.directory;
        } else {
          console.warn(`[lifecycle] Project directory not found: ${project.directory}, falling back to server cwd`);
        }
      }
      // P4-2/PR4: capture only the legacy control-plane MCP config path for
      // worker spawn fallback. repo_relpath feeds the merged object below and
      // is never passed to the worker as a pod/control-plane path.
      const mcpSource = project?.mcp_config_source || 'legacy_control_plane_path';
      if (mcpSource === 'legacy_control_plane_path' && project?.mcp_config_path) {
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
    try {
      projectMcpObj = await resolveProjectMcpObject({
        run,
        project,
        projectDir,
        projectMcpConfig,
        usesMaterializedRepoWorkspace,
        isRemoteNode,
      });
    } catch (err) {
      runService.updateRunStatus(run.id, 'failed', { force: true, reason: 'mcp_repo_relpath_failed' });
      runService.addRunEvent(run.id, 'error', JSON.stringify({ message: err.message }));
      _runProjectDirs.delete(run.id);
      throw err;
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
      if (projectDir && worktreeService && !isRemoteNode && !usesMaterializedRepoWorkspace) {
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
      // G2 §5k-1: deliverable mode = a goal-enabled run with NO git workspace
      // (no worktree, not materialized). Such a run gets an ISOLATED workspace as
      // its cwd instead of the server tree, so its artifacts never land in the
      // control-plane. fail-closed (Codex BLOCKER-2): if the workspace can't be
      // created — or the run is remote (§5k-1 remote provider is G2b) — mark the
      // run failed NON-retryable rather than executing in the fallback cwd.
      let cwd;
      const hasGitWorkspace = !!worktreePath || usesMaterializedRepoWorkspace;
      // deliverable mode uses the single per-run goal-activation decision stamped
      // above — no re-evaluation of the env gate.
      if (goalActive && !hasGitWorkspace && isRemoteNode) {
        // G2b §5k-1: remote deliverable goal workspace — created ON the node under
        // its operator-declared exposed_roots via the executor (two-step guarded
        // mkdir + no-follow validation). runId is a strict allowlist (server-
        // generated `run_<uuid8>`). Any missing prerequisite / mkdir failure is
        // fail-closed non-retryable (a retry re-fails identically), same contract
        // as the local provider.
        let roots = [];
        try { roots = Array.isArray(node.exposed_roots) ? node.exposed_roots : JSON.parse(node.exposed_roots || '[]'); } catch { roots = []; }
        const root = Array.isArray(roots) && roots[0] ? String(roots[0]).replace(/\/+$/, '') : null;
        const safeRunId = /^[A-Za-z0-9_-]{1,128}$/.test(String(run.id)) ? String(run.id) : null;
        const remoteExecutor = channelForNode(run.node_id);
        const remoteWs = (root && safeRunId) ? `${root}/.palantir-goal-workspaces/${safeRunId}` : null;
        if (!remoteWs || !remoteExecutor || typeof remoteExecutor.ensureRealDir !== 'function') {
          runService.addRunEvent(run.id, 'goal:workspace_remote_unsupported', JSON.stringify({
            node_id: run.node_id || 'local',
            reason: !root ? 'no_exposed_root' : !safeRunId ? 'bad_run_id' : 'no_provider',
          }));
          runService.setRetryCount(run.id, MAX_RETRY);
          runService.updateRunStatus(run.id, 'failed', { force: true, reason: 'goal_workspace_remote_unsupported' });
          return null;
        }
        try {
          await remoteExecutor.ensureRealDir(`${root}/.palantir-goal-workspaces`); // container first (B1)
          await remoteExecutor.ensureRealDir(remoteWs);
        } catch (err) {
          runService.addRunEvent(run.id, 'goal:workspace_failed', JSON.stringify({ reason: err.message, remote: true }));
          runService.setRetryCount(run.id, MAX_RETRY);
          runService.updateRunStatus(run.id, 'failed', { force: true, reason: 'goal_workspace_failed' });
          return null;
        }
        try { runService.setGoalWorkspacePath(run.id, remoteWs); } catch { /* annotate-only */ }
        cwd = remoteWs;
      } else if (goalActive && !hasGitWorkspace) {
        const dir = goalWorkspaceDir(run.id);
        try {
          if (!dir) throw new Error('invalid run id for goal workspace');
          require('node:fs').mkdirSync(dir, { recursive: true, mode: 0o700 });
        } catch (err) {
          runService.addRunEvent(run.id, 'goal:workspace_failed', JSON.stringify({ reason: err.message }));
          runService.setRetryCount(run.id, MAX_RETRY); // non-retryable — a retry re-fails identically
          runService.updateRunStatus(run.id, 'failed', { force: true, reason: 'goal_workspace_failed' });
          return null;
        }
        try { runService.setGoalWorkspacePath(run.id, dir); } catch { /* annotate-only */ }
        cwd = dir;
      } else {
        const operatorContext = deriveLegacyContext({ run, workspaceDir: worktreePath || projectDir });
        enforceWorkspace(operatorContext, 'spawn_cwd');
        cwd = resolveSpawnCwd({ workspaceDir: worktreePath || projectDir });
      }
      console.log(`[lifecycle] Executing task ${taskId} in cwd: ${cwd} (project: ${task.project_id || 'none'})`);

      // Route Claude Code workers through streamJsonEngine for rich event parsing.
      // Other agents (codex, gemini, etc.) use the tmux/subprocess executionEngine.
      // Codex P2 review: use the same case-insensitive command-based resolver
      // as adapterName / save-time validation (a custom `Claude` command must
      // not fall through to the tmux branch and drop the structured model).
      const isClaude = adapterName === 'claude';
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
              model: profile.model || undefined,
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
        // F-1: codex workers ALWAYS run at the standard service tier. Batch
        // worker runs must never inherit the user's ~/.codex/config.toml
        // service_tier="fast" (2.5× credits). Emit explicitly as a leaf `-c`
        // override (same placement as MCP flatten — before baseArgs' exec/-).
        // codex detection is command-based via resolveAdapterName (a non-codex
        // wrapper command must not get `-c`).
        if (adapterName === 'codex') {
          if (profile.reasoning_effort) extraArgs.push('-c', `model_reasoning_effort="${profile.reasoning_effort}"`);
          if (profile.model) extraArgs.push('-m', profile.model);
          extraArgs.push('-c', 'service_tier="default"');
        }
        const baseArgs = buildAgentArgs(profile, prompt, placeholders);
        if (adapterName === 'codex' && hasForbiddenWorkerTierArg(profile.args_template)) {
          runService.addRunEvent(run.id, 'worker:tier_forbidden', JSON.stringify({
            adapter: 'codex',
            reason: 'service_tier/features.fast_mode not allowed in worker args_template (batch is always standard)',
          }));
          throw new Error('worker args_template must not set service_tier/features.fast_mode');
        }
        const args = adapterName === 'codex' ? [...extraArgs, ...baseArgs] : baseArgs;
        // G1: for a LOCAL goal worker, tee stdout to a file so the final output
        // survives past the process-local buffer (§5k-2). Remote workers keep
        // their own node-side stdout log (read via executor at capture time), so
        // outputLogPath is local-only.
        let goalOutputLog = null;
        if (task && task.goal_enabled && !isRemoteNode) {
          goalOutputLog = goalOutputLogPath(run.id);
          if (goalOutputLog) {
            try {
              require('node:fs').mkdirSync(path.dirname(goalOutputLog), { recursive: true, mode: 0o700 });
            } catch { goalOutputLog = null; }
          }
        }
        result = await channelForNode(run.node_id).spawnWorker(run.id, {
          engine: 'cli',
          spec: {
            command: profile.command,
            args,
            cwd,
            env: parseEnvAllowlist(profile.env_allowlist, httpBearerEnvKeys),
            workerPath: isRemoteNode ? (node.node_prefix || undefined) : undefined,
            outputLogPath: goalOutputLog || undefined,
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

  function hasForbiddenWorkerTierArg(argsTemplate) {
    // Scan the RAW args_template string — BEFORE {prompt}/placeholder
    // substitution (Codex final-review R2). The tier can only be injected via
    // the author-written template STRUCTURE (a `-c` fragment); a substituted
    // {prompt} value is positional data that codex never parses as config, so
    // scanning the post-substitution args would falsely refuse a normal worker
    // whose PROMPT merely mentions "service_tier"/"fast_mode".
    //
    // Broad, case-insensitive substring denylist: a `-c` fragment can spell the
    // tier as valid TOML in many shapes — `service_tier="fast"`,
    // `'"service_tier" = "fast"'`, `features.fast_mode=true`. A tight token
    // regex misses quoted keys / spacing, and because the template-derived
    // baseArgs are appended AFTER the forced `service_tier="default"`
    // (extraArgs), any surviving tier token would last-win and re-enable fast
    // on a batch worker. No legitimate worker template ever needs to touch the
    // service tier, so reject these substrings outright (fail-closed).
    return /service_tier|fast_mode/i.test(String(argsTemplate || ''));
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
      operator_instance_id: run.operator_instance_id || null,
      parent_run_id: run.parent_run_id || null,
      retry_root_run_id: run.retry_root_run_id || run.id,
    });
    runService.addRunEvent(retryRun.id, 'queue:retry', JSON.stringify({
      profile_id: run.agent_profile_id,
    }));
    return retryRun;
  }

  function scheduleMaterializeRetry(profileId, nodeId, delayMs) {
    const timer = setTimeout(() => {
      _materializationTimers.delete(timer);
      scheduleDrain(profileId);
      scheduleDrainForNode(nodeId || 'local');
    }, Math.max(1, Number(delayMs || 1000)));
    if (typeof timer.unref === 'function') timer.unref();
    _materializationTimers.add(timer);
  }

  function emitMaterializeFailed(runId, nodeId, err, { transient }) {
    const message = String(err?.message || err || 'materialization failed').slice(0, 2000);
    let run = null;
    try { run = runService.getRun(runId); } catch { /* ignore */ }
    const payload = {
      run_id: runId,
      project_id: run?.project_id || null,
      node_id: nodeId || run?.node_id || 'local',
      error: message,
      transient: Boolean(transient),
    };
    if (eventBus) eventBus.emit('materialize:failed', payload);
  }

  function cleanupStaleMaterializationAttempt(run, token) {
    if (!token || !materializationService || typeof materializationService.cleanupAttemptResources !== 'function') return;
    Promise.resolve(materializationService.cleanupAttemptResources({
      run,
      nodeId: run.node_id || 'local',
      claimToken: token,
    })).catch((err) => {
      console.warn(`[lifecycle] Materialization cleanup failed for run ${run.id}: ${err.message}`);
    });
  }

  function failOrRequeueMaterializingRun(runId, nodeId, err, {
    token = null,
    forceTokenless = false,
    reason = 'materialize:failed',
    eventType = 'materialize:failed',
  } = {}) {
    let current;
    try {
      current = runService.getRun(runId);
    } catch {
      return null;
    }
    // Return truthy ONLY when we actually transition the run out of
    // materializing under our token. If the run already left materializing
    // (the attempt won the CAS race and became a materialized winner), do NOT
    // signal a transition — the caller (stuck sweep) must then skip the
    // token-scoped worktree/ref cleanup so the winner's resources survive
    // (Codex R4 review BLOCKER: cleanup must be state-scoped, not just
    // token-scoped).
    if (!current || current.status !== 'materializing') return null;

    const message = String(err?.message || err || 'materialization failed').slice(0, 2000);
    const attempts = Number(current.materialize_attempts || 0);
    if (attempts < MAX_MATERIALIZE_ATTEMPTS) {
      let requeued = null;
      if (token && typeof runService.requeueMaterializingRun === 'function') {
        requeued = runService.requeueMaterializingRun(runId, {
          error: message,
          backoffMs: 1000 * Math.max(1, attempts + 1),
          token,
          reason,
          eventType,
          transient: true,
        });
      } else if (forceTokenless && typeof runService.forceRequeueTokenlessMaterializingRun === 'function') {
        requeued = runService.forceRequeueTokenlessMaterializingRun(runId, {
          error: message,
          backoffMs: 1000 * Math.max(1, attempts + 1),
          reason,
          eventType,
          transient: true,
        });
      }
      if (requeued) emitMaterializeFailed(runId, nodeId, err, { transient: true });
      return requeued || null;
    }

    let failed = null;
    if (token && typeof runService.failMaterializingRun === 'function') {
      failed = runService.failMaterializingRun(runId, {
        error: message,
        token,
        reason,
        eventType,
      });
    } else if (forceTokenless && typeof runService.forceFailTokenlessMaterializingRun === 'function') {
      failed = runService.forceFailTokenlessMaterializingRun(runId, {
        error: message,
        reason,
        eventType,
      });
    }
    if (failed) emitMaterializeFailed(runId, nodeId, err, { transient: false });
    return failed || null;
  }

  function startMaterialization(runRow, profileId, nodeId) {
    if (!materializationService || !runRow?.project_id) return false;
    const runId = runRow.id;
    const status = runRow.status;
    let claim = null;
    if (status === 'queued') {
      claim = runService.claimQueuedRunForMaterialization(runId);
    } else if (status === 'materializing') {
      claim = typeof runService.restartMaterializationAttempt === 'function'
        ? runService.restartMaterializationAttempt(runId)
        : null;
    }
    if (!claim) return false;
    const claimToken = claim.token || null;

    setImmediate(() => {
      Promise.resolve()
        .then(() => {
          const current = runService.getRun(runId);
          const project = projectService.getProject(current.project_id);
          return materializationService.ensureWorkspace({
            project,
            nodeId: nodeId || current.node_id || 'local',
            runId,
            claimToken,
          });
        })
        .then((result) => {
          if (result?.pending) {
            scheduleMaterializeRetry(profileId, nodeId, result.backoffMs || 1000);
          } else if (result?.unsupported) {
            failOrRequeueMaterializingRun(runId, nodeId, result.error || 'repo materialization unsupported on this node', { token: claimToken });
            scheduleMaterializeRetry(profileId, nodeId, 1000);
          } else {
            scheduleDrain(profileId);
            scheduleDrainForNode(nodeId || 'local');
          }
        })
        .catch((err) => {
          console.warn(`[lifecycle] Materialization failed for run ${runId}: ${err.message}`);
          failOrRequeueMaterializingRun(runId, nodeId, err, { token: claimToken });
          scheduleDrain(profileId);
          scheduleMaterializeRetry(profileId, nodeId, 1000);
        });
    });
    return true;
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
    const queueScanStatuses = repoFeatureEnabled() ? ['queued', 'materializing'] : ['queued'];
    for (const status of queueScanStatuses) {
      for (const run of runService.listRuns({ status })) {
        if (run.is_manager || run.agent_profile_id !== profileId) continue;
        const nodeId = run.node_id || 'local';
        if (onlyNodeId && nodeId !== onlyNodeId) continue;
        if (!seen.has(nodeId)) {
          seen.add(nodeId);
          nodeIds.push(nodeId);
        }
      }
    }

    for (const nodeId of nodeIds) {
      if (repoFeatureEnabled() && materializationService) {
        while (canMaterializeOnNode(nodeId)) {
          const nextMaterialize = typeof runService.getOldestMaterializableOnNode === 'function'
            ? runService.getOldestMaterializableOnNode(nodeId, profileId)
            : null;
          if (!nextMaterialize) break;
          if (!startMaterialization(nextMaterialize, profileId, nodeId)) break;
        }
      }

      while (canDispatchOnNode(nodeId, profileId, profile)) {
        const next = repoFeatureEnabled() && typeof runService.getOldestQueuedReadyOnNode === 'function'
          ? runService.getOldestQueuedReadyOnNode(nodeId, profileId)
          : (typeof runService.getOldestQueuedOnNode === 'function'
            ? runService.getOldestQueuedOnNode(nodeId, profileId)
            : runService.getOldestQueued(profileId));
        if (!next) break;
        const spawned = await spawnQueuedRun(next.id);
        if (spawned) started++;
      }
    }
    return started;
  }

  async function drainAllQueues() {
    const profileIds = new Set();
    const statuses = repoFeatureEnabled() ? ['queued', 'materializing'] : ['queued'];
    for (const status of statuses) {
      for (const run of runService.listRuns({ status })) {
        if (run.is_manager || !run.agent_profile_id) continue;
        profileIds.add(run.agent_profile_id);
      }
    }

    let started = 0;
    for (const profileId of profileIds) {
      started += await drainQueue(profileId);
    }
    return started;
  }

  // G3: the goal verdict reconciler. Wired with scheduleDrain (retry child
  // wakeup) + taskService (transition) + eventBus (outbox effect emit). Driven
  // at run:harvested (settle) and at boot (sweep). scheduleDrain is a function
  // declaration (hoisted) so this construction can precede its definition.
  const goalVerdictService = createGoalVerdictService({
    runService,
    taskService,
    eventBus,
    scheduleDrain: (profileId) => scheduleDrain(profileId),
    verdictToTaskStatus: VERDICT_TO_TASK_STATUS,
  });

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
      sweepStuckMaterializations();
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

  function sweepStuckMaterializations() {
    if (!runService || typeof runService.listRuns !== 'function') return 0;
    let changed = 0;
    try {
      if (typeof runService.staleMaterializationLeases === 'function') {
        changed += runService.staleMaterializationLeases(MATERIALIZE_STUCK_THRESHOLD_MS);
      }

      const timestamp = nowMs();
      const runs = runService.listRuns({ status: 'materializing' }) || [];
      for (const run of runs) {
        try {
          if (!run || Number(run.is_manager || 0) === 1) continue;
          const started = Date.parse(run.materialize_started_at || '');
          if (!Number.isFinite(started)) continue;
          if (timestamp - started <= MATERIALIZE_STUCK_THRESHOLD_MS) continue;
          const token = run.materialize_claim_token || null;
          // Transition FIRST (token-CAS), then clean up. failOrRequeue returns
          // truthy only if it actually moved the run out of materializing under
          // our token; if the attempt won the race and became a materialized
          // winner meanwhile, the CAS is a no-op → skip cleanup so we never
          // delete the winner's token-scoped worktree/ref (Codex R4 BLOCKER).
          const updated = failOrRequeueMaterializingRun(run.id, run.node_id || 'local', 'materialization stuck', {
            token,
            forceTokenless: !token,
            reason: 'materialize:stuck',
            eventType: 'materialize:stuck',
          });
          if (updated) {
            if (token) cleanupStaleMaterializationAttempt(run, token);
            changed++;
          }
        } catch {
          // Stuck materialization cleanup is best-effort observability.
        }
      }
      return changed;
    } catch {
      return changed;
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

    // G3: a goal task's transition is driven STRICTLY by the newest goal run's
    // verdict (the lineage tip) — never by naive completed/failed aggregation,
    // which would fight the verdict (e.g. an error verdict → review, not failed)
    // and could prematurely fail a task that is mid-retry. Delegate to the single
    // authority so this path and the reconciler never diverge. Only goal tasks
    // take that path (checked from the runs we already fetched — no re-query on
    // the hot non-goal path).
    if (runs.some(r => r.goal_active)) { goalVerdictService.syncTaskStatus(taskId); return; }

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

    // G3: a periodic verdict-loop sweep so a settle/drain that failed transiently
    // (a brief DB lock, a missed post-commit drain) self-heals at runtime instead
    // of only on the next reboot. Skipped under the node test runner (would settle
    // seeded goal rows mid-test, as boot drain is), and unref'd so it never keeps
    // the process alive. sweep() is idempotent + never-throws.
    if (!process.env.NODE_TEST_CONTEXT && !goalSweepTimer) {
      goalSweepTimer = setInterval(() => {
        try { goalVerdictService.sweep(); } catch (err) {
          console.warn(`[lifecycle] Goal verdict periodic sweep failed: ${err.message}`);
        }
      }, GOAL_SWEEP_INTERVAL_MS);
      if (typeof goalSweepTimer.unref === 'function') goalSweepTimer.unref();
    }

    // Subscribe to run:ended so task status syncs immediately (not just on next health check),
    // and so worktrees get cleaned up regardless of which engine drove the termination
    // (tmux health check, streamJsonEngine exit handler, or explicit cancelRun all funnel here).
    // Stash the unsubscribe so stopMonitoring() can release the listener — without this,
    // tests that spin up multiple createApp() instances accumulate stale listeners.
    if (eventBus) {
      unsubscribeEventBus = eventBus.subscribe((event) => {
        // G3: run:harvested is the exactly-once, post-acceptance signal for a
        // goal attempt — harvest persisted runs.acceptance_json (or none, for a
        // failed run) BEFORE emitting this. Settle drives the verdict + retry +
        // task transition + outbox effects from that persisted state.
        if (event.channel === 'run:harvested') {
          const hr = event.data?.run;
          if (hr && hr.goal_active && !hr.is_manager) {
            try { goalVerdictService.settle(hr.id); } catch (err) {
              console.warn(`[lifecycle] Goal verdict settle failed for run ${hr.id}: ${err.message}`);
            }
          }
          return;
        }
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
          && !run.goal_active   // G3: goal runs retry via the verdict loop, not B-lite
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

        // A terminal (completed/failed) worker run is the review + goal-capture
        // point. Goal capture MUST run independently of harvestService being
        // wired (§5k-2) — a deployment with no harvestService still captures a
        // goal run's final_output. Harvest is then conditional, and cleanup
        // preserves the pre-G1 branching (harvest path → runtime files, no-harvest
        // path → worktree). captureGoalOutput never throws and no-ops for
        // non-goal runs, so it can chain ahead without touching that contract.
        const isReviewTerminal = ['completed', 'failed'].includes(toStatus);
        if (isReviewTerminal) {
          const projectDir = resolveProjectDirForRun(run);
          setImmediate(() => {
            Promise.resolve(captureGoalOutput(run))
              .then(() => (harvestService ? harvestService.harvestRun(run, { projectDir }) : undefined))
              .catch((err) => {
                console.warn(`[lifecycle] Harvest failed for run ${run.id}: ${err.message}`);
              })
              .finally(() => {
                const cleanup = harvestService ? cleanupRunRuntimeFiles(run) : cleanupRunWorktree(run);
                Promise.resolve(cleanup).catch((err) => {
                  console.warn(`[lifecycle] Cleanup failed for run ${run.id}: ${err.message}`);
                });
              });
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
    if (goalSweepTimer) {
      clearInterval(goalSweepTimer);
      goalSweepTimer = null;
    }
    if (unsubscribeEventBus) {
      try { unsubscribeEventBus(); } catch { /* ignore */ }
      unsubscribeEventBus = null;
    }
    for (const timer of _materializationTimers) {
      clearTimeout(timer);
    }
    _materializationTimers.clear();
  }

  // G1: read the tail (≤ cap bytes) of a goal worker's file-backed tee log.
  // Returns null when the file is absent/empty/unreadable so the caller falls
  // back to channel.getOutput. Sync + best-effort (never throws to the caller).
  function readGoalOutputLogTail(runId) {
    const p = goalOutputLogPath(runId);
    if (!p) return null;
    try {
      const fs = require('node:fs');
      const stat = fs.statSync(p);
      if (!stat.isFile() || stat.size === 0) return null;
      const readBytes = Math.min(stat.size, GOAL_FINAL_OUTPUT_MAX_BYTES);
      const start = stat.size - readBytes;
      const fd = fs.openSync(p, 'r');
      try {
        const buf = Buffer.alloc(readBytes);
        fs.readSync(fd, buf, 0, readBytes, start);
        // A non-zero tail offset may land inside a multi-byte codepoint — skip
        // any leading continuation bytes (0b10xxxxxx) so decode starts clean and
        // never emits a spurious leading U+FFFD.
        let offset = 0;
        if (start > 0) {
          while (offset < buf.length && (buf[offset] & 0xC0) === 0x80) offset++;
        }
        return buf.subarray(offset).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  // G1: capture a goal-enabled worker's final output → runs.final_output (byte-
  // capped) and parse its ```palantir-goal-report``` block → runs.goal_report.
  // Runs at run-terminal (alongside harvest). Output source, in priority:
  //   1. the file-backed tee at goalOutputLogPath (§5k-2 — restart-safe, local
  //      codex/tmux/subprocess), read tail-first;
  //   2. channel.getOutput (in-process buffer / remote node-side log via executor).
  // Contract: annotate-only, NEVER throws (mirrors harvest) and ONLY touches
  // goal-enabled runs, so every non-goal run is byte-for-byte unaffected.
  async function captureGoalOutput(run) {
    try {
      if (!run || run.is_manager || !run.task_id) return;
      // Single per-run gate: only a goal-ACTIVE run captures (Codex holistic
      // review — unified activation). goal_active was stamped at spawn.
      if (!run.goal_active) return;

      let raw = readGoalOutputLogTail(run.id);
      if (raw == null) {
        try {
          raw = await channelForNode(run.node_id).getOutput(run.id, GOAL_OUTPUT_LINES);
        } catch (err) {
          // getOutput can legitimately fail (buffer gone, remote unreachable) —
          // capture is best-effort. The report parser re-runs from harvest tail.
          raw = null;
        }
      }
      const finalOutput = capUtf8Bytes(raw, GOAL_FINAL_OUTPUT_MAX_BYTES);
      const report = parseGoalReport(finalOutput || '');
      runService.updateGoalCapture(run.id, {
        final_output: finalOutput,
        goal_report: report ? JSON.stringify(report) : null,
      });
      try {
        runService.addRunEvent(run.id, 'harvest:goal_capture', JSON.stringify({
          captured: finalOutput != null,
          bytes: finalOutput ? Buffer.byteLength(finalOutput, 'utf8') : 0,
          has_report: !!report,
          goal_status: report ? report.goal_status : null,
        }));
      } catch { /* annotate-only */ }
    } catch (err) {
      console.warn(`[lifecycle] Goal output capture failed for run ${run && run.id}: ${err.message}`);
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
    sweepStuckMaterializations,
    recoverOrphanSessions,
    cleanupOrphanMcpConfigs,
    cleanupStaleTerminalWorktrees,
    startMonitoring,
    stopMonitoring,
    sendAgentInput,
    cancelRun,
    // G3: boot sweeper — settle unverdicted terminal goal runs (crash mid-
    // harvest) + reconcile verdicted ones (redrive undelivered outbox effects).
    // MUST run before stale-worktree cleanup so a settle that needs a workspace
    // is not raced by the cleanup. Never throws.
    sweepGoalVerdicts: () => goalVerdictService.sweep(),
    checkTaskCompletion,
    _goalVerdictService: goalVerdictService,
  };
}

module.exports = { createLifecycleService };
