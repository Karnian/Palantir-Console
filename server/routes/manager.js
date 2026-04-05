const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { BadRequestError } = require('../utils/errors');

/**
 * Manager Session API routes.
 *
 * The Manager is a Claude Code CLI subprocess running with stream-json protocol.
 * It orchestrates worker agents and the user communicates with it via chat.
 *
 * Routes:
 *   POST   /api/manager/start   — Start a new manager session
 *   POST   /api/manager/message — Send a message to the active manager
 *   GET    /api/manager/status  — Get current manager session status
 *   GET    /api/manager/events  — Get manager events (parsed NDJSON)
 *   POST   /api/manager/stop    — Stop the active manager session
 */

function createManagerRouter({ runService, streamJsonEngine, eventBus }) {
  const router = express.Router();

  // Track the active manager run ID (only one manager at a time)
  let activeManagerRunId = null;
  let startingManager = false; // guard against concurrent /start requests

  /**
   * Find the active manager run. Checks both in-memory and DB state.
   */
  function getActiveManager() {
    if (!activeManagerRunId) return null;

    // Check if still alive
    const alive = streamJsonEngine.isAlive(activeManagerRunId);
    if (!alive) {
      // Check if it completed naturally
      const exitCode = streamJsonEngine.detectExitCode(activeManagerRunId);
      if (exitCode !== null) {
        try {
          const status = exitCode === 0 ? 'completed' : 'failed';
          runService.updateRunStatus(activeManagerRunId, status, { force: true });
        } catch { /* already updated */ }
      }
      activeManagerRunId = null;
      return null;
    }

    try {
      return runService.getRun(activeManagerRunId);
    } catch {
      activeManagerRunId = null;
      return null;
    }
  }

  /**
   * POST /api/manager/start
   * Start a new manager session.
   * Body: { prompt?, model?, maxBudgetUsd?, cwd? }
   */
  router.post('/start', asyncHandler(async (req, res) => {
    // Check if manager already running — with race condition guard
    if (startingManager) {
      return res.status(409).json({ error: 'Manager session is starting' });
    }
    const existing = getActiveManager();
    if (existing) {
      return res.status(409).json({
        error: 'Manager session already running',
        run: existing,
      });
    }
    startingManager = true;

    const {
      prompt,
      model,
      cwd,
    } = req.body || {};

    // Validate cwd if provided — must be absolute path, no traversal
    let safeCwd = cwd || process.cwd();
    if (cwd) {
      const path = require('node:path');
      safeCwd = path.resolve(cwd);
      // Block obviously dangerous paths
      if (safeCwd === '/' || safeCwd.startsWith('/etc') || safeCwd.startsWith('/var') || safeCwd.startsWith('/usr')) {
        throw new BadRequestError(`cwd not allowed: ${safeCwd}`);
      }
    }

    // Create a run record via service (eventBus will fire)
    const run = runService.createRun({
      is_manager: true,
      prompt: prompt || 'Manager session',
    });
    const runId = run.id;

    // Build run summary for initial context
    const runSummary = buildRunSummary(runService);

    // Build system prompt for the Manager role
    const systemPrompt = buildManagerSystemPrompt(runSummary);

    try {
      const result = streamJsonEngine.spawnAgent(runId, {
        prompt: prompt || 'You are now active as the Palantir Manager. Await instructions.',
        cwd: safeCwd,
        systemPrompt,
        permissionMode: 'bypassPermissions',
        allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
        model: model || undefined,
        isManager: true,
      });

      // Mark as started
      runService.markRunStarted(runId, {
        tmux_session: null,
        worktree_path: null,
        branch: null,
      });

      activeManagerRunId = runId;

      if (eventBus) {
        eventBus.emit('manager:started', { runId });
      }

      const updatedRun = runService.getRun(runId);
      res.status(201).json({ run: updatedRun, pid: result.pid });
    } catch (error) {
      // Cleanup on failure
      try {
        runService.updateRunStatus(runId, 'failed', { force: true });
        runService.addRunEvent(runId, 'error', JSON.stringify({ message: error.message }));
      } catch { /* ignore */ }
      throw error;
    } finally {
      startingManager = false;
    }
  }));

  /**
   * POST /api/manager/message
   * Send a message to the active manager session.
   * Body: { text }
   */
  router.post('/message', asyncHandler(async (req, res) => {
    const manager = getActiveManager();
    if (!manager) {
      return res.status(404).json({ error: 'No active manager session' });
    }

    const { text } = req.body || {};
    if (!text || typeof text !== 'string') {
      throw new BadRequestError('text is required');
    }

    const sent = streamJsonEngine.sendInput(activeManagerRunId, text);
    if (!sent) {
      return res.status(502).json({ error: 'Failed to send message to manager' });
    }

    // If manager was in needs_input, transition back to running
    if (manager.status === 'needs_input') {
      runService.updateRunStatus(activeManagerRunId, 'running', { force: true });
    }

    res.json({ status: 'sent' });
  }));

  /**
   * GET /api/manager/status
   * Get current manager session status.
   */
  router.get('/status', asyncHandler(async (req, res) => {
    const manager = getActiveManager();
    if (!manager) {
      return res.json({ active: false, run: null });
    }

    const usage = streamJsonEngine.getUsage(activeManagerRunId);
    const sessionId = streamJsonEngine.getSessionId(activeManagerRunId);

    res.json({
      active: true,
      run: manager,
      usage,
      claudeSessionId: sessionId,
    });
  }));

  /**
   * GET /api/manager/events
   * Get manager events (assistant messages, tool uses, etc.)
   * Query: ?after=<eventIndex>
   */
  router.get('/events', asyncHandler(async (req, res) => {
    if (!activeManagerRunId) {
      return res.json({ events: [] });
    }

    const afterId = req.query.after ? Number(req.query.after) : undefined;
    const events = runService.getRunEvents(activeManagerRunId, afterId);
    res.json({ events });
  }));

  /**
   * GET /api/manager/output
   * Get raw text output from manager.
   */
  router.get('/output', asyncHandler(async (req, res) => {
    if (!activeManagerRunId) {
      return res.json({ output: null });
    }

    const lines = Math.min(Math.max(1, Number(req.query.lines || 100)), 2000);
    const output = streamJsonEngine.getOutput(activeManagerRunId, lines);
    res.json({ output, runId: activeManagerRunId });
  }));

  /**
   * POST /api/manager/stop
   * Stop the active manager session.
   */
  router.post('/stop', asyncHandler(async (req, res) => {
    if (!activeManagerRunId) {
      return res.json({ status: 'no_active_session' });
    }

    const runId = activeManagerRunId;
    streamJsonEngine.kill(runId);

    try {
      runService.updateRunStatus(runId, 'cancelled', { force: true });
    } catch { /* ignore */ }

    activeManagerRunId = null;

    if (eventBus) {
      eventBus.emit('manager:stopped', { runId });
    }

    res.json({ status: 'stopped', runId });
  }));

  return router;
}

/**
 * Build a summary of current runs/tasks for the Manager's initial context.
 */
function buildRunSummary(runService) {
  try {
    const allRuns = runService.listRuns({});
    if (!allRuns || allRuns.length === 0) return 'No runs found.';

    const running = allRuns.filter(r => r.status === 'running' && !r.is_manager);
    const needsInput = allRuns.filter(r => r.status === 'needs_input');
    const failed = allRuns.filter(r => r.status === 'failed');
    const completed = allRuns.filter(r => r.status === 'completed');

    const lines = [];
    lines.push(`- 🟢 Running: ${running.length}`);
    lines.push(`- 🟡 Needs Input: ${needsInput.length}`);
    lines.push(`- 🔴 Failed: ${failed.length}`);
    lines.push(`- ✅ Completed: ${completed.length}`);
    lines.push(`- Total runs: ${allRuns.length}`);

    if (failed.length > 0) {
      lines.push('\nRecent failures:');
      for (const r of failed.slice(0, 5)) {
        const name = r.prompt ? r.prompt.slice(0, 60) : r.id;
        lines.push(`  - [${r.id}] ${name} (exit: ${r.exit_code ?? '?'})`);
      }
    }

    if (running.length > 0) {
      lines.push('\nCurrently running:');
      for (const r of running) {
        const name = r.prompt ? r.prompt.slice(0, 60) : r.id;
        lines.push(`  - [${r.id}] ${name}`);
      }
    }

    if (needsInput.length > 0) {
      lines.push('\n⚠️ Waiting for input:');
      for (const r of needsInput) {
        const name = r.prompt ? r.prompt.slice(0, 60) : r.id;
        lines.push(`  - [${r.id}] ${name}`);
      }
    }

    return lines.join('\n');
  } catch {
    return 'Unable to load run summary.';
  }
}

/**
 * Build the system prompt for the Manager agent.
 * The Manager's role is to orchestrate worker agents and report status to the user.
 */
function buildManagerSystemPrompt(runSummary) {
  return `You are the Palantir Manager — a central orchestration agent for the Palantir Console.

Your role:
1. MONITOR all running worker agents and report their status
2. COORDINATE work across multiple projects and tasks
3. ANSWER questions about what agents are doing
4. DELEGATE new work to appropriate worker agents
5. ALERT the user to issues that need attention (failures, stuck agents, etc.)

## Palantir Console REST API

The Palantir Console server runs at http://localhost:4177. Use Bash with curl to query it:

### Runs (agent executions)
- List all runs: curl -s http://localhost:4177/api/runs | jq
- Filter by status: curl -s "http://localhost:4177/api/runs?status=running" | jq
- Filter by task: curl -s "http://localhost:4177/api/runs?task_id=TASK_ID" | jq
- Get single run: curl -s http://localhost:4177/api/runs/RUN_ID | jq
- Get run events: curl -s http://localhost:4177/api/runs/RUN_ID/events | jq

### Tasks
- List all tasks: curl -s http://localhost:4177/api/tasks | jq
- Filter by status: curl -s "http://localhost:4177/api/tasks?status=in_progress" | jq
- Create task: curl -s -X POST http://localhost:4177/api/tasks -H 'Content-Type: application/json' -d '{"title":"...","description":"...","priority":"medium"}'
- Update status: curl -s -X PATCH http://localhost:4177/api/tasks/TASK_ID/status -H 'Content-Type: application/json' -d '{"status":"done"}'

### Projects
- List projects: curl -s http://localhost:4177/api/projects | jq

### Agent Profiles
- List agents: curl -s http://localhost:4177/api/agents | jq

### Worker Management
- Execute task with agent: curl -s -X POST http://localhost:4177/api/tasks/TASK_ID/execute -H 'Content-Type: application/json' -d '{"agent_profile_id":"AGENT_ID","prompt":"..."}'
- Send input to run: curl -s -X POST http://localhost:4177/api/runs/RUN_ID/input -H 'Content-Type: application/json' -d '{"text":"..."}'
- Cancel run: curl -s -X POST http://localhost:4177/api/runs/RUN_ID/cancel

Run statuses: queued, running, paused, needs_input, completed, failed, cancelled
Task statuses: backlog, todo, in_progress, review, done

Always be concise and action-oriented. When reporting status, use a structured format:
- 🟢 Running (count)
- 🟡 Needs Input (count)
- 🔴 Failed (count)
- ✅ Completed today (count)

Prioritize issues that need user attention (needs_input, failures) over routine updates.
Always query the actual Palantir API to get real data — never guess or assume.

${runSummary ? `\n## Current State (at session start)\n${runSummary}` : ''}`;
}

module.exports = { createManagerRouter };
