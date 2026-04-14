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

function createLifecycleService({
  runService,
  taskService,
  agentProfileService,
  projectService,
  executionEngine,
  streamJsonEngine,
  worktreeService,
  eventBus,
  skillPackService,
  presetService,
  claudeVersionResolver,
}) {
  const HEARTBEAT_INTERVAL_MS = 30000;  // 30s
  const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min (increased from 10 min for long-running tasks)
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
  function cleanupRunWorktree(run) {
    if (!run?.id) return;
    if (worktreeService && run.worktree_path && run.branch) {
      const projectDir = resolveProjectDirForRun(run);
      if (projectDir) {
        try {
          worktreeService.removeWorktree(projectDir, run.worktree_path, run.branch, { runId: run.id });
        } catch (err) {
          console.warn(`[lifecycle] Worktree cleanup failed for run ${run.id}: ${err.message}`);
        }
      }
    }
    _runProjectDirs.delete(run.id);

    // Skill Packs: cleanup MCP config file
    if (run.mcp_config_path) {
      try {
        const fs = require('node:fs');
        if (fs.existsSync(run.mcp_config_path)) {
          fs.unlinkSync(run.mcp_config_path);
        }
      } catch (err) {
        console.warn(`[lifecycle] MCP config cleanup failed for run ${run.id}: ${err.message}`);
      }
    }
  }

  /**
   * Execute a task: create a Run, spawn the agent.
   */
  function executeTask(taskId, { agentProfileId, prompt, skillPackIds, presetId }) {
    const task = taskService.getTask(taskId);
    const profile = agentProfileService.getProfile(agentProfileId);

    // Check concurrency limit
    const runningCount = agentProfileService.getRunningCount(agentProfileId);
    if (runningCount >= profile.max_concurrent) {
      throw new Error(`Agent ${profile.name} at concurrency limit (${profile.max_concurrent})`);
    }

    // Phase 10C: resolve preferred preset. Explicit argument wins over
    // task.preferred_preset_id so callers can override per-execute.
    const effectivePresetId = presetId || task.preferred_preset_id || null;
    const adapterName = resolveAdapterName(profile);

    // Create run
    const run = runService.createRun({
      task_id: taskId,
      agent_profile_id: agentProfileId,
      prompt,
    });

    // Resolve project directory and MCP config for agent CWD
    let projectDir = null;
    let projectMcpConfig = null;
    if (task.project_id) {
      const project = projectService.getProject(task.project_id);
      if (project?.directory) {
        const fs = require('node:fs');
        if (fs.existsSync(project.directory)) {
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

        // Phase 10C: Tier 2 stays dormant. When the resolver returns
        // isolated=true (i.e. Claude adapter + isolated preset) we log a
        // pending marker so operators see preset requested `--bare` but
        // Phase 10C is only applying Tier 1. Phase 10D flips this on.
        if (presetResolution.isolated) {
          runService.addRunEvent(run.id, 'preset:tier2_pending', JSON.stringify({
            reason: 'Tier 2 isolation is implemented in Phase 10D; applying Tier 1 only',
            plugin_refs: (presetObj.plugin_refs || []),
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
    if (mergedMcp) {
      const fsW = require('node:fs');
      const pathW = require('node:path');
      if (!/^[a-zA-Z0-9_-]+$/.test(run.id)) {
        throw new Error(`Invalid run id for MCP config path: ${run.id}`);
      }
      const mcpConfigFilePath = pathW.resolve(process.cwd(), 'runtime', 'mcp', `${run.id}.json`);
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

    // Create an isolated git worktree for this run, when the project is a git repo.
    // Each run gets its own branch (palantir/run-<id>) so concurrent agents don't
    // collide on shared files. Falls back to projectDir if worktree creation fails
    // or the project isn't under git.
    let worktreePath = null;
    let branch = null;
    if (projectDir && worktreeService && worktreeService.isGitRepo(projectDir)) {
      try {
        const result = worktreeService.createWorktree(projectDir, runBranchName(run.id));
        if (result?.branch) {
          worktreePath = result.path;
          branch = result.branch;
        }
      } catch (err) {
        console.warn(`[lifecycle] Worktree creation failed for run ${run.id}: ${err.message}`);
      }
    }

    const cwd = worktreePath || projectDir || process.cwd();
    console.log(`[lifecycle] Executing task ${taskId} in cwd: ${cwd} (project: ${task.project_id || 'none'})`);

    // Route Claude Code workers through streamJsonEngine for rich event parsing.
    // Other agents (codex, gemini, etc.) use the tmux/subprocess executionEngine.
    const isClaude = (profile.command || '').includes('claude');

    try {
      let result;
      if (isClaude && streamJsonEngine) {
        // Use streamJsonEngine — same as Manager but isManager=false (single-shot worker)
        const mcpTools = parseMcpTools(profile.capabilities_json);

        // Preset/skill-pack composed prompt (Phase 10C §6.8).
        const systemPrompt = composedSystemPrompt || undefined;

        // MCP config file: unified (preset > project > skill pack) if
        // anything merged, else plain project MCP, else undefined.
        const effectiveMcpConfig = skillPackMcpConfigPath || projectMcpConfig || undefined;

        result = streamJsonEngine.spawnAgent(run.id, {
          prompt,
          cwd,
          env: parseEnvAllowlist(profile.env_allowlist),
          systemPrompt,
          permissionMode: 'bypassPermissions',
          allowedTools: mcpTools.length > 0 ? mcpTools : undefined,
          mcpConfig: effectiveMcpConfig,
          isManager: false,
        });
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
          fs.writeFileSync(promptFilePath, composedSystemPrompt, { mode: 0o600 });
          placeholders.system_prompt_file = promptFilePath;
        }
        // Phase 10C: Codex worker gets preset MCP injected via
        // `codex exec -c mcp_servers=<json>`. Only applied when the
        // merged MCP config is non-empty AND the profile command is
        // codex — opencode today has no equivalent flag, so we emit a
        // degrade warning and fall back to prompt-only (spec §7 Phase 10C).
        let extraArgs = [];
        if (mergedMcp && adapterName === 'codex') {
          const jsonStr = JSON.stringify(mergedMcp.mcpServers || {});
          extraArgs = ['-c', `mcp_servers=${jsonStr}`];
        } else if (mergedMcp && adapterName === 'opencode') {
          runService.addRunEvent(run.id, 'preset:mcp_unsupported', JSON.stringify({
            adapter: 'opencode',
            reason: 'opencode CLI has no MCP config flag — prompt-only injection applied',
          }));
        }
        const baseArgs = buildAgentArgs(profile, prompt, placeholders);
        const args = adapterName === 'codex' ? [...extraArgs, ...baseArgs] : baseArgs;
        result = executionEngine.spawnAgent(run.id, {
          command: profile.command,
          args,
          cwd,
          env: parseEnvAllowlist(profile.env_allowlist),
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
      // Synchronous cleanup so the worktree AND the in-memory _runProjectDirs entry
      // are released even if monitoring/subscriber were never started or have been
      // torn down. cleanupRunWorktree is idempotent — the run:ended subscriber that
      // updateRunStatus may also trigger will be a safe no-op the second time.
      cleanupRunWorktree({
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
   */
  function parseEnvAllowlist(allowlistJson) {
    try {
      const keys = JSON.parse(allowlistJson || '[]');
      const env = {};
      for (const key of keys) {
        if (process.env[key]) env[key] = process.env[key];
      }
      return env;
    } catch {
      return {};
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

  /**
   * Check health of all running runs.
   */
  function checkHealth() {
    // Re-entrancy guard: prevent overlapping health checks
    if (healthCheckRunning) return;
    healthCheckRunning = true;

    try {
      _doHealthCheck();
    } finally {
      healthCheckRunning = false;
    }
  }

  function _doHealthCheck() {
    const runningRuns = runService.listRuns({ status: 'running' });

    for (const run of runningRuns) {
      // Skip manager runs and streamJsonEngine workers — they manage their own lifecycle
      if (run.is_manager) continue;
      if (streamJsonEngine && streamJsonEngine.hasProcess(run.id)) {
        // streamJsonEngine handles exit via its own event handler (result → updateRunStatus)
        // Just check for orphaned processes where exit was missed
        if (!streamJsonEngine.isAlive(run.id)) {
          const exitCode = streamJsonEngine.detectExitCode(run.id);
          if (exitCode !== null) {
            const status = exitCode === 0 ? 'completed' : 'failed';
            try { runService.updateRunStatus(run.id, status, { force: true }); } catch {}
            if (run.task_id) checkTaskCompletion(run.task_id);
          }
        }
        continue;
      }

      const alive = executionEngine.isAlive(run.id);
      const exitCode = executionEngine.detectExitCode(run.id);

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
        const output = executionEngine.getOutput(run.id, 200);
        if (output) {
          runService.addRunEvent(run.id, 'final_output', JSON.stringify({ output: output.slice(-2000) }));
        }

        // Transition task if all runs for this task are complete
        if (run.task_id) {
          checkTaskCompletion(run.task_id);
        }

        // Cleanup tmux session and output tracking
        executionEngine.kill(run.id);
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
          });
        }
      } else {
        // Still alive — check if tmux output has changed (real activity indicator)
        const currentOutput = executionEngine.getOutput(run.id, 10);
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
              const alive = executionEngine.isAlive(run.id);
              if (!alive) {
                // Process is dead — finalize as completed/failed
                const exitCode = executionEngine.detectExitCode(run.id);
                const status = (exitCode === 0) ? 'completed' : 'failed';
                runService.updateRunStatus(run.id, status, { force: true, reason: 'process_dead_after_idle' });
                if (run.task_id) checkTaskCompletion(run.task_id);
                executionEngine.kill(run.id);
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
                  eventBus.emit('run:needs_input', {
                    runId: run.id,
                    run: runService.getRun(run.id),
                    from_status: fromStatus,
                    to_status: 'needs_input',
                    reason: 'idle_timeout',
                    task_id: run.task_id || null,
                    project_id: run.project_id || null,
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
      // Skip streamJsonEngine runs
      if (streamJsonEngine && streamJsonEngine.hasProcess(run.id)) continue;

      const alive = executionEngine.isAlive(run.id);
      if (alive) {
        // Check if output changed — agent may still be working
        const currentOutput = executionEngine.getOutput(run.id, 10);
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
        const exitCode = executionEngine.detectExitCode(run.id);
        const status = (exitCode === 0) ? 'completed' : 'failed';
        runService.updateRunStatus(run.id, status, { force: true });
        if (run.task_id) checkTaskCompletion(run.task_id);
        executionEngine.kill(run.id);
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
  function recoverOrphanSessions() {
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
          const alive = executionEngine.isAlive(runId);

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
            const exitCode = executionEngine.detectExitCode(runId);
            const status = (exitCode === 0) ? 'completed' : 'failed';
            runService.updateRunStatus(runId, status, { force: true });
            runService.updateRunResult(runId, {
              exit_code: exitCode,
              result_summary: status === 'completed'
                ? 'Agent completed (recovered after restart)'
                : `Agent exited with code ${exitCode} (recovered after restart)`,
            });
            executionEngine.kill(runId);
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
        if (run.task_id) checkTaskCompletion(run.task_id);
        if (!run.is_manager) cleanupRunWorktree(run);
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
  function sendAgentInput(runId, text) {
    const run = runService.getRun(runId);
    if (run.status !== 'running' && run.status !== 'needs_input') {
      throw new Error(`Cannot send input to run in status: ${run.status}`);
    }

    // Try streamJsonEngine first (for Claude workers), fall back to executionEngine
    const sent = (streamJsonEngine && streamJsonEngine.sendInput(runId, text))
      || executionEngine.sendInput(runId, text);
    if (sent) {
      runService.addRunEvent(runId, 'user_input', JSON.stringify({ text }));
      if (run.status === 'needs_input') {
        runService.updateRunStatus(runId, 'running', { force: true });
      }
    }
    return sent;
  }

  /**
   * Cancel a running agent.
   */
  function cancelRun(runId) {
    const run = runService.getRun(runId);
    // Don't cancel already-terminal runs
    if (['completed', 'failed', 'cancelled', 'stopped'].includes(run.status)) {
      return run;
    }
    // Use correct engine: streamJsonEngine for manager + claude workers, executionEngine for others
    const killedByStream = streamJsonEngine && streamJsonEngine.kill(runId);
    if (!killedByStream) {
      executionEngine.kill(runId);
    }
    runService.updateRunStatus(runId, 'cancelled', { force: true });
    if (run.task_id) {
      checkTaskCompletion(run.task_id);
    }
    return runService.getRun(runId);
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

  return {
    executeTask,
    checkHealth,
    recoverOrphanSessions,
    cleanupOrphanMcpConfigs,
    startMonitoring,
    stopMonitoring,
    sendAgentInput,
    cancelRun,
  };
}

module.exports = { createLifecycleService };
