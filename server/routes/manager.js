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
      maxBudgetUsd = 5,
      cwd,
      apiKey,
    } = req.body || {};

    // Store API key in process env if provided (persists for future spawns)
    if (apiKey) {
      process.env.ANTHROPIC_API_KEY = apiKey;
    }

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

    // Build system prompt for the Manager role
    const systemPrompt = buildManagerSystemPrompt();

    try {
      const result = streamJsonEngine.spawnAgent(runId, {
        prompt: prompt || 'You are now active as the Palantir Manager. Await instructions.',
        cwd: safeCwd,
        systemPrompt,
        permissionMode: 'bypassPermissions',
        allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
        maxBudgetUsd,
        model: model || 'sonnet',
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
      return res.json({ active: false, run: null, hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY) });
    }

    const usage = streamJsonEngine.getUsage(activeManagerRunId);
    const sessionId = streamJsonEngine.getSessionId(activeManagerRunId);

    res.json({
      active: true,
      run: manager,
      usage,
      claudeSessionId: sessionId,
      hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
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
 * Build the system prompt for the Manager agent.
 * The Manager's role is to orchestrate worker agents and report status to the user.
 */
function buildManagerSystemPrompt() {
  return `You are the Palantir Manager — a central orchestration agent for the Palantir Console.

Your role:
1. MONITOR all running worker agents and report their status
2. COORDINATE work across multiple projects and tasks
3. ANSWER questions about what agents are doing
4. DELEGATE new work to appropriate worker agents
5. ALERT the user to issues that need attention (failures, stuck agents, etc.)

You have access to the Palantir Console API via tools. Use them to:
- Check task and run status
- View agent outputs
- Create new tasks and trigger agent runs
- Send input to agents that need it

Always be concise and action-oriented. When reporting status, use a structured format:
- 🟢 Running (count)
- 🟡 Needs Input (count)
- 🔴 Failed (count)
- ✅ Completed today (count)

Prioritize issues that need user attention (needs_input, failures) over routine updates.`;
}

module.exports = { createManagerRouter };
