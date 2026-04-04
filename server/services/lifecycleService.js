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
  executionEngine,
  worktreeService,
  eventBus,
}) {
  const HEARTBEAT_INTERVAL_MS = 30000;  // 30s
  const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
  let heartbeatTimer = null;
  let healthCheckRunning = false; // Re-entrancy guard

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

    // Create worktree if project has a directory
    let worktreePath = null;
    let branch = null;
    if (task.project_id) {
      // We'd need project directory — for now use cwd
    }

    // Build agent command args
    const args = buildAgentArgs(profile, prompt);
    const cwd = worktreePath || task.directory || process.cwd();

    try {
      const result = executionEngine.spawnAgent(run.id, {
        command: profile.command,
        args,
        cwd,
        env: parseEnvAllowlist(profile.env_allowlist),
      });

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
      throw error;
    }
  }

  /**
   * Build command arguments from agent profile template.
   */
  function buildAgentArgs(profile, prompt) {
    if (!profile.args_template) return [prompt];

    const template = profile.args_template;
    // Replace {prompt} placeholder
    const rendered = template.replace(/\{prompt\}/g, prompt);
    // Split by spaces but respect quoted strings
    return rendered.match(/(?:[^\s"]+|"[^"]*")+/g) || [prompt];
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
      const alive = executionEngine.isAlive(run.id);
      const exitCode = executionEngine.detectExitCode(run.id);

      if (!alive || exitCode !== null) {
        // Agent has terminated
        const status = (exitCode === 0) ? 'completed' : 'failed';
        runService.updateRunStatus(run.id, status, { force: true });

        if (exitCode !== null) {
          runService.updateRunResult(run.id, {
            exit_code: exitCode,
            result_summary: status === 'completed' ? 'Agent completed successfully' : `Agent exited with code ${exitCode}`,
          });
        }

        // Capture final output
        const output = executionEngine.getOutput(run.id, 50);
        if (output) {
          runService.addRunEvent(run.id, 'final_output', JSON.stringify({ output: output.slice(-2000) }));
        }

        // Transition task if all runs for this task are complete
        if (run.task_id) {
          checkTaskCompletion(run.task_id);
        }

        // Cleanup tmux session
        executionEngine.kill(run.id);

        if (eventBus) {
          eventBus.emit('run:completed', { run: runService.getRun(run.id) });
        }
      } else {
        // Still alive — check for idle timeout
        const events = runService.getRunEvents(run.id);
        const lastEvent = events[events.length - 1];
        const lastActivity = lastEvent ? new Date(lastEvent.created_at).getTime() : new Date(run.started_at || run.created_at).getTime();
        const idleTime = Date.now() - lastActivity;

        if (idleTime > IDLE_TIMEOUT_MS) {
          // Agent has been idle too long — mark as needs_input for user attention
          runService.updateRunStatus(run.id, 'needs_input', { force: true });
          runService.addRunEvent(run.id, 'idle_timeout', JSON.stringify({
            message: `Agent idle for ${Math.round(idleTime / 60000)} minutes`,
            idleMs: idleTime,
          }));
          if (eventBus) {
            eventBus.emit('run:needs_input', { runId: run.id, taskId: run.task_id });
          }
        } else {
          // Normal heartbeat
          runService.addRunEvent(run.id, 'heartbeat', null);
        }
      }
    }

    // Check for queued runs that need input
    const queuedRuns = runService.listRuns({ status: 'needs_input' });
    for (const run of queuedRuns) {
      if (eventBus) {
        eventBus.emit('run:needs_input', { runId: run.id, taskId: run.task_id });
      }
    }
  }

  /**
   * Check if all runs for a task are complete, and transition task accordingly.
   */
  function checkTaskCompletion(taskId) {
    const runs = runService.listRuns({ task_id: taskId });
    const allComplete = runs.every(r => ['completed', 'failed', 'cancelled'].includes(r.status));

    if (allComplete && runs.length > 0) {
      const hasSuccess = runs.some(r => r.status === 'completed');
      const newStatus = hasSuccess ? 'review' : 'todo'; // failed runs → back to todo
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
  }

  /**
   * Send input to a running agent.
   */
  function sendAgentInput(runId, text) {
    const run = runService.getRun(runId);
    if (run.status !== 'running' && run.status !== 'needs_input') {
      throw new Error(`Cannot send input to run in status: ${run.status}`);
    }

    const sent = executionEngine.sendInput(runId, text);
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
    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      return run;
    }
    executionEngine.kill(runId);
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
