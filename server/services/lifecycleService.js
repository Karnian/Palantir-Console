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
}) {
  const HEARTBEAT_INTERVAL_MS = 30000;  // 30s
  const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
  let heartbeatTimer = null;
  let healthCheckRunning = false; // Re-entrancy guard
  let unsubscribeEventBus = null; // for stopMonitoring teardown
  const _outputHashes = new Map(); // Track tmux output changes per run
  // runId → projectDir snapshot captured at executeTask time. Used as a fallback
  // for worktree cleanup when the run→task→project chain has been broken (e.g. the
  // task or project was deleted while the run was still in flight).
  const _runProjectDirs = new Map();

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
          worktreeService.removeWorktree(projectDir, run.worktree_path, run.branch);
        } catch (err) {
          console.warn(`[lifecycle] Worktree cleanup failed for run ${run.id}: ${err.message}`);
        }
      }
    }
    _runProjectDirs.delete(run.id);
  }

  /**
   * Execute a task: create a Run, spawn the agent.
   */
  function executeTask(taskId, { agentProfileId, prompt }) {
    const task = taskService.getTask(taskId);
    const profile = agentProfileService.getProfile(agentProfileId);

    // Check concurrency limit
    const runningCount = agentProfileService.getRunningCount(agentProfileId);
    if (runningCount >= profile.max_concurrent) {
      throw new Error(`Agent ${profile.name} at concurrency limit (${profile.max_concurrent})`);
    }

    // Create run
    const run = runService.createRun({
      task_id: taskId,
      agent_profile_id: agentProfileId,
      prompt,
    });

    // Resolve project directory for agent CWD
    let projectDir = null;
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
    }

    // Snapshot the project dir against the run id so cleanup still works even if
    // the task or project is deleted before the run terminates.
    if (projectDir) _runProjectDirs.set(run.id, projectDir);

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
        result = streamJsonEngine.spawnAgent(run.id, {
          prompt,
          cwd,
          env: parseEnvAllowlist(profile.env_allowlist),
          permissionMode: 'bypassPermissions',
          isManager: false,
        });
      } else {
        // Non-Claude agents: use tmux/subprocess engine
        const args = buildAgentArgs(profile, prompt);
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
  function buildAgentArgs(profile, prompt) {
    if (!profile.args_template) return [prompt];

    const template = profile.args_template;
    // Split template into parts first, then replace {prompt} placeholder as single arg
    const parts = template.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const args = [];
    for (const part of parts) {
      if (part === '{prompt}') {
        // Prompt is always a single argument — never split by spaces
        args.push(prompt);
      } else if (part.includes('{prompt}')) {
        // Replace placeholder within a larger string
        args.push(part.replace(/\{prompt\}/g, prompt));
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
          // Output unchanged — check idle timeout
          const events = runService.getRunEvents(run.id);
          const lastEvent = events[events.length - 1];
          const lastActivity = lastEvent ? new Date(lastEvent.created_at).getTime() : new Date(run.started_at || run.created_at).getTime();
          const idleTime = Date.now() - lastActivity;

          if (idleTime > IDLE_TIMEOUT_MS) {
            const fromStatus = run.status;
            runService.updateRunStatus(run.id, 'needs_input', { force: true, reason: 'idle_timeout' });
            runService.addRunEvent(run.id, 'idle_timeout', JSON.stringify({
              message: `Agent idle for ${Math.round(idleTime / 60000)} minutes`,
              idleMs: idleTime,
            }));
            if (eventBus) {
              // v3 Phase 5: run:needs_input is a PRIORITY alert —
              // the client should surface it via tab title / sound /
              // OS notification. Payload now carries the semantic
              // envelope fields and the priority marker so clients
              // don't have to hardcode a list of "important" channels.
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
          } else {
            runService.addRunEvent(run.id, 'heartbeat', null);
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

  return {
    executeTask,
    checkHealth,
    recoverOrphanSessions,
    startMonitoring,
    stopMonitoring,
    sendAgentInput,
    cancelRun,
  };
}

module.exports = { createLifecycleService };
