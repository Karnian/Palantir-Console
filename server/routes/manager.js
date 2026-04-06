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

function createManagerRouter({ runService, streamJsonEngine, eventBus, projectService, agentProfileService }) {
  const router = express.Router();

  // Track the active manager run ID (only one manager at a time)
  let activeManagerRunId = null;
  let startingManager = false; // guard against concurrent /start requests

  // On startup: mark any stale manager runs (from previous server instances) as stopped
  try {
    const staleManagers = runService.listRuns({ status: 'running' })
      .concat(runService.listRuns({ status: 'queued' }))
      .concat(runService.listRuns({ status: 'needs_input' }))
      .filter(r => r.is_manager);
    for (const r of staleManagers) {
      runService.updateRunStatus(r.id, 'stopped', { force: true });
    }
  } catch { /* ignore */ }

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
    // Atomic guard: set flag first, then check state, reset on bail-out
    if (startingManager) {
      return res.status(409).json({ error: 'Manager session is starting' });
    }
    startingManager = true;
    const existing = getActiveManager();
    if (existing) {
      startingManager = false;
      return res.status(409).json({
        error: 'Manager session already running',
        run: existing,
      });
    }

    const {
      prompt,
      model,
      cwd,
    } = req.body || {};

    // Validate cwd if provided — must be under home directory or current working dir
    let safeCwd = cwd || process.cwd();
    if (cwd) {
      const path = require('node:path');
      const os = require('node:os');
      safeCwd = path.resolve(cwd);
      const home = os.homedir();
      const cwdRoot = process.cwd();
      // Allowlist: must be under home dir or server's cwd
      if (safeCwd !== home && safeCwd !== cwdRoot &&
          !safeCwd.startsWith(home + path.sep) && !safeCwd.startsWith(cwdRoot + path.sep)) {
        throw new BadRequestError(`cwd must be under home directory or project root: ${safeCwd}`);
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

    // Build project and agent lists for context
    let projectList = '';
    let agentList = '';
    try {
      if (projectService) {
        const projects = projectService.listProjects();
        projectList = projects.map(p => `  - ${p.name} (id: ${p.id})${p.directory ? ` — dir: ${p.directory}` : ''}`).join('\n');
      }
      if (agentProfileService) {
        const agents = agentProfileService.listProfiles();
        agentList = agents.map(a => `  - ${a.name} [${a.type}] (id: ${a.id})`).join('\n');
      }
    } catch { /* ignore */ }

    // Build system prompt for the Manager role
    const systemPrompt = buildManagerSystemPrompt(runSummary, projectList, agentList);

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

    const { text, images } = req.body || {};
    if ((!text || typeof text !== 'string') && (!Array.isArray(images) || images.length === 0)) {
      throw new BadRequestError('text or images is required');
    }

    // Validate images if provided
    const validImages = Array.isArray(images)
      ? images.filter(img => img && typeof img.data === 'string' && typeof img.media_type === 'string')
      : undefined;

    const sent = streamJsonEngine.sendInput(activeManagerRunId, text || '', validImages);
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

    const rawAfter = req.query.after ? Number(req.query.after) : undefined;
    const afterId = (rawAfter != null && !Number.isNaN(rawAfter)) ? rawAfter : undefined;
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
function buildManagerSystemPrompt(runSummary, projectList, agentList) {
  const port = process.env.PORT || 4177;
  const base = `http://localhost:${port}`;
  const token = process.env.PALANTIR_TOKEN;
  const auth = token ? `-H 'Authorization: Bearer ${token}' ` : '';

  return `You are the Palantir Manager — a central orchestration agent for the Palantir Console.

Your role:
1. MONITOR all running worker agents and report their status
2. COORDINATE work across multiple projects and tasks
3. ANSWER questions about what agents are doing
4. DELEGATE new work by spawning worker agents via the Execute API
5. ALERT the user to issues that need attention (failures, stuck agents, etc.)

## CRITICAL: How to delegate work to worker agents

NEVER use your internal Claude Code tools (Agent, subagents like agent-olympus:*, etc.) to do delegated work.
Those internal subagents run inside YOUR process and are invisible to the Palantir Console UI.
ALL delegated work MUST go through the Palantir Console REST API so it appears in the Console dashboard.

When the user asks you to do work (coding, analysis, refactoring, etc.), you MUST spawn a Palantir Console worker agent.
Do NOT just create a task and update its status — that only creates a database record without running any agent.

**Correct workflow to spawn a worker:**
1. List available agent profiles: GET /api/agents
2. Create a task: POST /api/tasks
3. Execute the task (THIS spawns the actual agent process): POST /api/tasks/TASK_ID/execute with {"agent_profile_id":"AGENT_ID","prompt":"detailed instructions"}
4. Monitor the spawned run: GET /api/runs?task_id=TASK_ID

If no agent profiles exist, tell the user to create one first via the Agents page.
The /execute endpoint is what actually spawns a Claude Code (or other agent) subprocess. Without it, no agent runs.

IMPORTANT: NEVER call /execute without explicit user approval. Always confirm before spawning workers.
Do NOT auto-execute tasks just because their status is in_progress — status alone does not mean "run an agent".

You may use your own Bash/Read/Grep tools for quick lookups (checking status, reading files, etc.),
but any substantial work (coding, refactoring, analysis tasks) must be delegated via the API.

## Palantir Console REST API

The Palantir Console server runs at ${base}. Use Bash with curl to query it.
${token ? `\nIMPORTANT: All API requests require auth header: ${auth.trim()}` : ''}

### Runs (agent executions)
- List all runs: curl -s ${auth}${base}/api/runs | jq
- Filter by status: curl -s ${auth}"${base}/api/runs?status=running" | jq
- Filter by task: curl -s ${auth}"${base}/api/runs?task_id=TASK_ID" | jq
- Get single run: curl -s ${auth}${base}/api/runs/RUN_ID | jq
- Get run events: curl -s ${auth}${base}/api/runs/RUN_ID/events | jq

### Tasks
- List all tasks: curl -s ${auth}${base}/api/tasks | jq
- Filter by status: curl -s ${auth}"${base}/api/tasks?status=in_progress" | jq
- Create task: curl -s ${auth}-X POST ${base}/api/tasks -H 'Content-Type: application/json' -d '{"title":"...","description":"...","priority":"medium","project_id":"PROJECT_ID"}'
  Only include project_id if the task clearly belongs to an existing project. If unrelated, omit project_id (the task will be unassigned). Do NOT guess or force a project assignment.
- Update status: curl -s ${auth}-X PATCH ${base}/api/tasks/TASK_ID/status -H 'Content-Type: application/json' -d '{"status":"done"}'

### Projects
- List projects: curl -s ${auth}${base}/api/projects | jq

### Agent Profiles
- List agents: curl -s ${auth}${base}/api/agents | jq

### Worker Management (IMPORTANT: use /execute to actually spawn agents)
- Execute task with agent: curl -s ${auth}-X POST ${base}/api/tasks/TASK_ID/execute -H 'Content-Type: application/json' -d '{"agent_profile_id":"AGENT_ID","prompt":"detailed work instructions here"}'
- Send input to run: curl -s ${auth}-X POST ${base}/api/runs/RUN_ID/input -H 'Content-Type: application/json' -d '{"text":"..."}'
- Cancel run: curl -s ${auth}-X POST ${base}/api/runs/RUN_ID/cancel

Run statuses: queued, running, paused, needs_input, completed, failed, cancelled, stopped
Task statuses: backlog, todo, in_progress, review, done

Always be concise and action-oriented. When reporting status, use a structured format:
- 🟢 Running (count)
- 🟡 Needs Input (count)
- 🔴 Failed (count)
- ✅ Completed today (count)

Prioritize issues that need user attention (needs_input, failures) over routine updates.
Always query the actual Palantir API to get real data — never guess or assume.

${runSummary ? `\n## Current State (at session start)\n${runSummary}` : ''}
${projectList ? `\n## Available Projects\n${projectList}\nOnly assign project_id when the task clearly belongs to a project. Leave it out if unrelated.` : ''}
${agentList ? `\n## Available Agent Profiles\n${agentList}\nUse the agent id when calling /execute.` : ''}`;
}

module.exports = { createManagerRouter };
