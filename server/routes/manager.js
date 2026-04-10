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

// P3-4: parse mcp_tools from capabilities_json. Mirrors the helper in
// lifecycleService.js — kept local to avoid a circular dependency.
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

// authResolverOpts is forwarded into resolveManagerAuth for every preflight
// so tests can inject `hasKeychain` (and any future DI hooks) without
// monkey-patching child_process. Production callers leave this empty and
// get the real keychain probe.
function createManagerRouter({ runService, streamJsonEngine, managerAdapterFactory, managerRegistry, conversationService, eventBus, projectService, projectBriefService, agentProfileService, pmCleanupService, authResolverOpts = {} }) {
  const router = express.Router();

  // PR1a: ManagerAdapter seam. The factory is the single entrypoint for
  // engine operations; routes never call streamJsonEngine directly anymore.
  // streamJsonEngine is still in the param list for back-compat with tests
  // that construct the router directly without passing the factory.
  if (!managerAdapterFactory) {
    const { createManagerAdapterFactory } = require('../services/managerAdapters');
    managerAdapterFactory = createManagerAdapterFactory({ streamJsonEngine, runService });
  }

  // v3 Phase 1.5: active manager tracking moved into managerRegistry so the
  // new /api/conversations router can share state with this one. Tests that
  // construct the router directly still get a fresh registry via the
  // fallback factory below.
  if (!managerRegistry) {
    const { createManagerRegistry } = require('../services/managerRegistry');
    managerRegistry = createManagerRegistry({ runService });
  }
  if (!conversationService) {
    const { createConversationService } = require('../services/conversationService');
    conversationService = createConversationService({
      runService,
      managerRegistry,
      managerAdapterFactory,
      lifecycleService: null, // routes/manager.js does not need worker delivery
    });
    // Test-path: wire slot-clear → notice scrub so the standalone router
    // constructed by manager.test.js gets the same Phase 2 semantics as
    // app.js's production wiring.
    if (typeof managerRegistry.onSlotCleared === 'function') {
      managerRegistry.onSlotCleared(({ runId }) => {
        try { conversationService.clearParentNotices(runId); } catch { /* ignore */ }
      });
    }
  }

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
      try { conversationService.clearParentNotices(r.id); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  /**
   * Find the active Top manager run. Checks managerRegistry + DB state.
   * v3 Phase 1.5: this is now a thin wrapper around managerRegistry.
   */
  function getActiveManager() {
    return managerRegistry.probeActive('top');
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
    const authCtx = resolveManagerAuth(adapterType, { envAllowlist, ...authResolverOpts });
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

    // Build project and agent lists for context.
    // v3 Phase 1: projectList now includes brief hints (conventions/pitfalls
    // preview + pm_enabled / preferred_pm_adapter). agentList exposes
    // capabilities_json + max_concurrent so the dispatcher can make
    // data-driven choices instead of free-text guessing (spec principle 3).
    let projectList = '';
    let agentList = '';
    let projectBriefsSection = '';
    try {
      if (projectService) {
        const projects = projectService.listProjects();
        const lines = [];
        const briefLines = [];
        for (const p of projects) {
          const pmBits = [];
          if (p.pm_enabled === 0) pmBits.push('PM disabled');
          if (p.preferred_pm_adapter) pmBits.push(`prefers ${p.preferred_pm_adapter}`);
          const pmSuffix = pmBits.length > 0 ? ` {${pmBits.join(', ')}}` : '';
          lines.push(`  - ${p.name} (id: ${p.id})${p.directory ? ` — dir: ${p.directory}` : ''}${pmSuffix}`);

          // Include brief hints if available. Truncate long text aggressively —
          // the manager's context window matters.
          if (projectBriefService) {
            try {
              const brief = projectBriefService.getBrief(p.id);
              if (brief && (brief.conventions || brief.known_pitfalls)) {
                const sectionParts = [];
                if (brief.conventions) {
                  sectionParts.push(`  - conventions: ${String(brief.conventions).slice(0, 400)}`);
                }
                if (brief.known_pitfalls) {
                  sectionParts.push(`  - pitfalls: ${String(brief.known_pitfalls).slice(0, 400)}`);
                }
                if (sectionParts.length > 0) {
                  briefLines.push(`### ${p.name} (id: ${p.id})`);
                  briefLines.push(sectionParts.join('\n'));
                }
              }
            } catch { /* ignore per-project brief errors */ }
          }
        }
        projectList = lines.join('\n');
        if (briefLines.length > 0) {
          projectBriefsSection = briefLines.join('\n');
        }
      }
      if (agentProfileService) {
        const agents = agentProfileService.listProfiles();
        agentList = agents.map(a => {
          const bits = [`${a.name} [${a.type}] (id: ${a.id})`];
          // v3 Phase 1: expose dormant fields.
          let caps = null;
          try {
            caps = a.capabilities_json ? JSON.parse(a.capabilities_json) : null;
          } catch { /* ignore malformed */ }
          if (caps && typeof caps === 'object' && Object.keys(caps).length > 0) {
            const keys = Object.keys(caps).slice(0, 6).join(',');
            bits.push(`caps: ${keys}`);
          }
          if (a.max_concurrent != null) {
            bits.push(`max_concurrent: ${a.max_concurrent}`);
          }
          return `  - ${bits.join(' | ')}`;
        }).join('\n');
      }
    } catch { /* ignore */ }

    // PR4: build system prompt via the dedicated module so each adapter can
    // contribute its own guardrails section. The dynamic context (run summary,
    // project/agent lists) is NOT in the system prompt anymore — it goes in
    // the first user message so Codex's model_instructions_file caching is
    // preserved across turns.
    // v3 Phase 0: layer='top' (all current manager starts are Top layer).
    const adapter = managerAdapterFactory.getAdapter(adapterType);
    const port = process.env.PORT || 4177;
    const token = process.env.PALANTIR_TOKEN;
    const systemPrompt = buildManagerSystemPromptModule({ adapter, port, token, layer: 'top' });
    const initialUserContext = buildInitialUserContext({
      runSummary,
      projectList,
      projectBriefsSection,
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

    // P3-4: extract MCP tool patterns from the agent profile's capabilities_json
    // so Manager (Top layer) can access MCP tools. The claudeAdapter.startSession
    // merges these into the base allowedTools list.
    const mcpTools = parseMcpTools(resolvedProfile && resolvedProfile.capabilities_json);

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
        mcpTools: mcpTools.length > 0 ? mcpTools : undefined,
        // v3 Phase 0: all current manager starts are Top layer. PM layer
        // (Phase 3a) will pass role='manager' with layer='pm' system prompt.
        // role='manager' is the default in codexAdapter so this is belt-and-suspenders.
        role: 'manager',
      });
      const result = sessionRef;

      // Mark as started
      runService.markRunStarted(runId, {
        tmux_session: null,
        worktree_path: null,
        branch: null,
      });

      // v3 Phase 1.5: register in shared registry so /api/conversations
      // can also see this session. Conversation id = 'top' for singleton.
      managerRegistry.setActive('top', runId, adapter);

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
    // v3 Phase 1.5: delegate to conversationService so the Top and
    // /api/conversations/top paths share the SAME parent-notice drain
    // semantics. If a worker direct chat left a pending notice on the
    // active Top run id, it will be consumed here regardless of which
    // entry point the client used.
    const { text, images } = req.body || {};
    try {
      const result = conversationService.sendMessage('top', { text, images });
      return res.json(result);
    } catch (err) {
      if (err && err.httpStatus === 400) {
        throw new BadRequestError(err.message);
      }
      if (err && err.httpStatus) {
        return res.status(err.httpStatus).json({ error: err.message });
      }
      throw err;
    }
  }));

  /**
   * POST /api/manager/pm/:projectId/message
   * v3 Phase 2: send a message to a project-scoped PM manager.
   *
   * Thin alias over conversationService.sendMessage('pm:<projectId>', ...).
   * Phase 2 wires the runtime slot + parent-notice router; lazy PM spawn
   * on first message is a Phase 3a concern. Until then, callers that hit
   * this route when no PM is active will get 404 — this is intentional.
   */
  router.post('/pm/:projectId/message', asyncHandler(async (req, res) => {
    const { projectId } = req.params;
    if (!projectId) {
      throw new BadRequestError('projectId is required');
    }
    const { text, images } = req.body || {};
    try {
      const result = conversationService.sendMessage(`pm:${projectId}`, { text, images });
      return res.json(result);
    } catch (err) {
      if (err && err.httpStatus === 400) {
        throw new BadRequestError(err.message);
      }
      if (err && err.httpStatus) {
        return res.status(err.httpStatus).json({ error: err.message });
      }
      throw err;
    }
  }));

  /**
   * POST /api/manager/pm/:projectId/reset
   * v3 Phase 3a: single-owner PM teardown (spec §5 책임 분담표). The
   * user clicks "Reset PM" (or the client forces a reset during adapter
   * switch) and this route delegates to pmCleanupService.reset, which
   * disposes the live adapter session, clears pm_thread_id/pm_adapter on
   * the project brief, and drops the managerRegistry slot. The NEXT
   * message to this project's PM will lazy-spawn a fresh Codex thread.
   */
  router.post('/pm/:projectId/reset', asyncHandler(async (req, res) => {
    const { projectId } = req.params;
    if (!projectId) {
      throw new BadRequestError('projectId is required');
    }
    if (!pmCleanupService) {
      return res.status(501).json({ error: 'pmCleanupService not wired' });
    }
    try {
      const result = pmCleanupService.reset(projectId);
      return res.json({ status: 'reset', projectId, ...result });
    } catch (err) {
      if (err && err.httpStatus) {
        return res.status(err.httpStatus).json({ error: err.message });
      }
      throw err;
    }
  }));

  /**
   * GET /api/manager/status
   * Get current manager session status.
   */
  router.get('/status', asyncHandler(async (req, res) => {
    // v3 Phase 1.5: layer-aware status shape.
    //   { active, run, usage, claudeSessionId, top: {...}, pms: [] }
    // `active`/`run`/`usage`/`claudeSessionId` preserve the legacy shape so
    // existing Frontend code keeps working during the hooks.js migration.
    // The `top` + `pms` keys are the new 1.5 shape that useConversations()
    // will switch to.
    const manager = getActiveManager();
    if (!manager) {
      return res.json({ active: false, run: null, top: null, pms: [] });
    }

    const adapter = managerRegistry.getActiveAdapter('top')
      || managerAdapterFactory.getAdapter(manager.manager_adapter || 'claude-code');
    const usage = adapter.getUsage(manager.id);
    const sessionId = adapter.getSessionId(manager.id);

    const topSnapshot = {
      conversationId: 'top',
      run: manager,
      usage,
      claudeSessionId: sessionId,
    };

    // v3 Phase 2: project-scoped PM slots are a 1st-class runtime target.
    // Each entry mirrors the top snapshot shape so the client can render
    // a unified card list without branching on layer. The registry is the
    // source of truth for "which PM run is live right now"; the DB row is
    // fetched for status/metadata. probeActive takes care of liveness +
    // cleanup along the way.
    const snapshot = managerRegistry.snapshot();
    const pms = [];
    for (const pmEntry of snapshot.pms) {
      const pmRun = managerRegistry.probeActive(pmEntry.conversationId);
      if (!pmRun) continue;
      const pmAdapter = managerRegistry.getActiveAdapter(pmEntry.conversationId)
        || managerAdapterFactory.getAdapter(pmRun.manager_adapter || 'claude-code');
      pms.push({
        conversationId: pmEntry.conversationId,
        run: pmRun,
        usage: pmAdapter.getUsage ? pmAdapter.getUsage(pmRun.id) : null,
        claudeSessionId: pmAdapter.getSessionId ? pmAdapter.getSessionId(pmRun.id) : null,
      });
    }

    res.json({
      active: true,
      run: manager,
      usage,
      claudeSessionId: sessionId,
      top: topSnapshot,
      pms,
    });
  }));

  /**
   * GET /api/manager/events
   * Get manager events (assistant messages, tool uses, etc.)
   * Query: ?after=<eventIndex>
   */
  router.get('/events', asyncHandler(async (req, res) => {
    const activeTopRunId = managerRegistry.getActiveRunId('top');
    if (!activeTopRunId) {
      return res.json({ events: [] });
    }

    const rawAfter = req.query.after ? Number(req.query.after) : undefined;
    const afterId = (rawAfter != null && !Number.isNaN(rawAfter)) ? rawAfter : undefined;
    const events = runService.getRunEvents(activeTopRunId, afterId);
    res.json({ events });
  }));

  /**
   * GET /api/manager/output
   * Get raw text output from manager.
   */
  router.get('/output', asyncHandler(async (req, res) => {
    const activeTopRunId = managerRegistry.getActiveRunId('top');
    if (!activeTopRunId) {
      return res.json({ output: null });
    }

    const lines = Math.min(Math.max(1, Number(req.query.lines || 100)), 2000);
    const adapter = managerRegistry.getActiveAdapter('top')
      || managerAdapterFactory.getAdapter('claude-code');
    const output = adapter.getOutput ? adapter.getOutput(activeTopRunId, lines) : null;
    res.json({ output, runId: activeTopRunId });
  }));

  /**
   * POST /api/manager/stop
   * Stop the active manager session.
   */
  router.post('/stop', asyncHandler(async (req, res) => {
    const runId = managerRegistry.getActiveRunId('top');
    if (!runId) {
      return res.json({ status: 'no_active_session' });
    }

    const adapter = managerRegistry.getActiveAdapter('top')
      || managerAdapterFactory.getAdapter('claude-code');
    adapter.disposeSession(runId);

    try {
      runService.updateRunStatus(runId, 'cancelled', { force: true });
    } catch { /* ignore */ }

    managerRegistry.clearActive('top');
    // v3 Phase 1.5: drop any lingering parent-notice queue entries for this
    // run id. A future Top manager will have a different run id so there is
    // no risk of cross-session leakage, but we prefer explicit cleanup.
    try { conversationService.clearParentNotices(runId); } catch { /* ignore */ }

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
