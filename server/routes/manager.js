const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { BadRequestError } = require('../utils/errors');
const { resolveManagerAuth, buildManagerSpawnEnv } = require('../services/authResolver');
const {
  buildManagerSystemPrompt: buildManagerSystemPromptModule,
  buildInitialUserContext,
} = require('../services/managerSystemPrompt');

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

// PR3/PR4: map agent profile type → manager adapter type. Profiles whose
// type is not in this set cannot back a manager session.
const PROFILE_TYPE_TO_ADAPTER = {
  'claude-code': 'claude-code',
  'codex': 'codex',
};

function createManagerRouter({ runService, streamJsonEngine, managerAdapterFactory, eventBus, projectService, agentProfileService }) {
  const router = express.Router();

  // PR1a: ManagerAdapter seam. The factory is the single entrypoint for
  // engine operations; routes never call streamJsonEngine directly anymore.
  // streamJsonEngine is still in the param list for back-compat with tests
  // that construct the router directly without passing the factory.
  if (!managerAdapterFactory) {
    const { createManagerAdapterFactory } = require('../services/managerAdapters');
    managerAdapterFactory = createManagerAdapterFactory({ streamJsonEngine, runService });
  }

  // Track the active manager run ID (only one manager at a time)
  let activeManagerRunId = null;
  let activeManagerAdapter = null;
  let startingManager = false; // guard against concurrent /start requests

  // On startup: mark any stale manager runs (from previous server instances) as stopped.
  // PR1a: route disposeSession() through every adapter so external resources
  // (Codex temp files in PR4, etc.) get cleaned up — not just the Claude
  // subprocess. Today no resources exist, so this is a no-op for Claude.
  try {
    const staleManagers = runService.listRuns({ status: 'running' })
      .concat(runService.listRuns({ status: 'queued' }))
      .concat(runService.listRuns({ status: 'needs_input' }))
      .filter(r => r.is_manager);
    for (const r of staleManagers) {
      try {
        const adapter = managerAdapterFactory.getAdapter(r.manager_adapter || 'claude-code');
        adapter.disposeSession(r.id);
      } catch { /* ignore */ }
      runService.updateRunStatus(r.id, 'stopped', { force: true });
    }
  } catch { /* ignore */ }

  /**
   * Find the active manager run. Checks both in-memory and DB state.
   */
  function getActiveManager() {
    if (!activeManagerRunId) return null;

    const adapter = activeManagerAdapter || managerAdapterFactory.getAdapter('claude-code');

    // Check if still alive
    const alive = adapter.isSessionAlive(activeManagerRunId);
    if (!alive) {
      // Check if it completed naturally
      const exitCode = adapter.detectExitCode
        ? adapter.detectExitCode(activeManagerRunId)
        : null;
      if (exitCode !== null) {
        try {
          const status = exitCode === 0 ? 'completed' : 'failed';
          runService.updateRunStatus(activeManagerRunId, status, { force: true });
        } catch { /* already updated */ }
      }
      // PR1b: ensure normalized session_ended fires even on natural exit, and
      // free adapter-local bookkeeping. The adapter's hook is idempotent.
      try {
        if (adapter.emitSessionEndedIfNeeded) {
          adapter.emitSessionEndedIfNeeded(activeManagerRunId, 'natural-exit');
        }
      } catch { /* ignore */ }
      activeManagerRunId = null;
      activeManagerAdapter = null;
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
      agent_profile_id: agentProfileIdFromBody,
    } = req.body || {};

    // PR3: resolve which adapter to use from agent_profile_id.
    // Backward-compat: if no profile id is sent, default to 'claude-code' for
    // one minor version so existing UI keeps working. The default will be
    // removed once the picker (PR3 frontend) is in production.
    let resolvedProfile = null;
    let adapterType = 'claude-code';
    try {
      const profileId = agentProfileIdFromBody || 'claude-code';
      if (agentProfileService) {
        resolvedProfile = agentProfileService.getProfile(profileId);
        const mapped = PROFILE_TYPE_TO_ADAPTER[resolvedProfile.type];
        if (!mapped) {
          startingManager = false;
          return res.status(400).json({
            error: 'manager_adapter_unsupported',
            profileId: resolvedProfile.id,
            profileType: resolvedProfile.type,
            supported: Object.keys(PROFILE_TYPE_TO_ADAPTER),
          });
        }
        adapterType = mapped;
      }
    } catch (err) {
      startingManager = false;
      return res.status(400).json({
        error: 'manager_profile_not_found',
        profileId: agentProfileIdFromBody || 'claude-code',
        message: err.message,
      });
    }

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

    // PR2/PR3: preflight auth using the chosen adapter type and the profile's
    // env_allowlist (PR3). If canAuth=false, fail fast with structured info
    // before any DB row is created.
    //
    // Fail-closed on malformed env_allowlist: a user who hand-edits the row
    // and corrupts it must NOT silently re-enable all default credentials.
    let envAllowlist;
    if (resolvedProfile && resolvedProfile.env_allowlist) {
      try {
        const parsed = JSON.parse(resolvedProfile.env_allowlist);
        if (!Array.isArray(parsed)) {
          throw new Error('env_allowlist must be a JSON array');
        }
        envAllowlist = parsed;
      } catch (parseErr) {
        startingManager = false;
        return res.status(400).json({
          error: 'manager_profile_env_allowlist_invalid',
          profileId: resolvedProfile.id,
          message: parseErr.message,
          raw: resolvedProfile.env_allowlist,
        });
      }
    } else {
      // No profile resolved (back-compat path with no agent_profile_id) —
      // fall through to the resolver's defaults.
      envAllowlist = undefined;
    }
    const authCtx = resolveManagerAuth(adapterType, { envAllowlist });
    if (!authCtx.canAuth) {
      startingManager = false;
      return res.status(400).json({
        error: 'manager_auth_unavailable',
        adapter: adapterType,
        profileId: resolvedProfile ? resolvedProfile.id : null,
        sources: authCtx.sources,
        diagnostics: authCtx.diagnostics,
      });
    }

    // Create a run record via service (eventBus will fire)
    const run = runService.createRun({
      is_manager: true,
      prompt: prompt || 'Manager session',
      agent_profile_id: resolvedProfile ? resolvedProfile.id : null,
      manager_adapter: adapterType,
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

    // PR4: build system prompt via the dedicated module so each adapter can
    // contribute its own guardrails section. The dynamic context (run summary,
    // project/agent lists) is NOT in the system prompt anymore — it goes in
    // the first user message so Codex's model_instructions_file caching is
    // preserved across turns.
    const adapter = managerAdapterFactory.getAdapter(adapterType);
    const port = process.env.PORT || 4177;
    const token = process.env.PALANTIR_TOKEN;
    const systemPrompt = buildManagerSystemPromptModule({ adapter, port, token });
    const initialUserContext = buildInitialUserContext({
      runSummary,
      projectList,
      agentList,
      userPrompt: prompt || 'You are now active as the Palantir Manager. Await instructions.',
    });

    // PR4: finally propagate the filtered env to the spawned subprocess.
    // buildManagerSpawnEnv strips credential-like vars that are NOT on the
    // profile's env_allowlist, then layers resolved auth env on top. Tool
    // CLIs still inherit PATH/HOME/etc., but cross-vendor credentials can
    // no longer leak.
    const spawnEnv = buildManagerSpawnEnv({
      authEnv: authCtx.env,
      envAllowlist,
    });

    try {
      const { sessionRef } = adapter.startSession(runId, {
        // For Claude (persistent process) the prompt argument is the FIRST
        // user message piped via stdin during spawn. For Codex (stateless)
        // it is ignored — we'll send the same content as the first runTurn
        // immediately below.
        prompt: initialUserContext,
        cwd: safeCwd,
        systemPrompt,
        model: model || undefined,
        env: spawnEnv,
      });
      const result = sessionRef;

      // Mark as started
      runService.markRunStarted(runId, {
        tmux_session: null,
        worktree_path: null,
        branch: null,
      });

      activeManagerRunId = runId;
      activeManagerAdapter = adapter;

      // PR4 / D2: for Codex, startSession is the LIGHT path (just writes the
      // instructions file). The first turn is launched here so the user sees
      // the manager pick up the initial context immediately.
      if (adapter.capabilities && adapter.capabilities.persistentProcess === false) {
        try {
          adapter.runTurn(runId, { text: initialUserContext });
        } catch (err) {
          console.warn(`[manager] failed to launch first Codex turn: ${err.message}`);
        }
      }

      if (eventBus) {
        eventBus.emit('manager:started', { runId });
      }

      const updatedRun = runService.getRun(runId);
      res.status(201).json({ run: updatedRun, pid: result && result.pid });
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

    const adapter = activeManagerAdapter || managerAdapterFactory.getAdapter('claude-code');
    const { accepted } = adapter.runTurn(activeManagerRunId, { text: text || '', images: validImages });
    if (!accepted) {
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

    const adapter = activeManagerAdapter || managerAdapterFactory.getAdapter('claude-code');
    const usage = adapter.getUsage(activeManagerRunId);
    const sessionId = adapter.getSessionId(activeManagerRunId);

    // PR1a is pure indirection — keep response shape identical to pre-refactor.
    // PR3 will add adapter type once /start accepts agent_profile_id.
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
    const adapter = activeManagerAdapter || managerAdapterFactory.getAdapter('claude-code');
    const output = adapter.getOutput ? adapter.getOutput(activeManagerRunId, lines) : null;
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
    const adapter = activeManagerAdapter || managerAdapterFactory.getAdapter('claude-code');
    adapter.disposeSession(runId);

    try {
      runService.updateRunStatus(runId, 'cancelled', { force: true });
    } catch { /* ignore */ }

    activeManagerRunId = null;
    activeManagerAdapter = null;

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

// PR4: the inline buildManagerSystemPrompt() that used to live here was moved
// to server/services/managerSystemPrompt.js so each adapter can contribute its
// own guardrails section and so the dynamic context (run summary, project /
// agent lists) can be sent as the first user message — protecting Codex's
// model_instructions_file caching. Do not re-add the inline version.

module.exports = { createManagerRouter };
