// server/services/pmSpawnService.js
//
// v3 Phase 3a: lazy spawn + resume for project-scoped PM manager runs.
// Spec §7 (PM Lazy 생성 모델) + §9.5 (Phase 3a 작업 목록).
//
// Contract:
//
//   ensureLivePm({ projectId, activeTopRun })
//     → Returns the live PM run row for this project, spawning a fresh
//       one if none is registered. Callers (conversationService) invoke
//       this before `sendToManagerSlot('pm:<projectId>')` so the slot is
//       guaranteed populated.
//
// Behavior:
//
//   1. If `managerRegistry.probeActive('pm:<projectId>')` already returns
//      a live run → return it verbatim. No work.
//
//   2. Otherwise:
//        a. Refuse if `projects.pm_enabled === 0` (user opted out). The
//           router should have skipped the PM in that case, but belt-
//           and-suspenders keeps the invariant visible.
//        b. Refuse if there is no active Top run. A PM run's
//           `parent_run_id` MUST point at a live Top so parent-notice
//           routing works; allowing an orphan PM would silently break
//           lock-in #2.
//        c. Resolve the PM adapter: spec §7.2 fallback chain
//             project.preferred_pm_adapter → global default → 'codex'.
//           Phase 3a only actually supports 'codex' as an adapter that
//           can *spawn* a PM (claude PM requires the resume support
//           landing in Phase 3b). If the resolved adapter is 'claude'
//           we currently downgrade to 'codex' with a warning — this is
//           the pragmatic middle ground so existing user preferences
//           don't block PM activation.
//        d. Resolve codex auth (preflight) and build the filtered
//           subprocess env.
//        e. Build the PM system prompt with `layer: 'pm'`, and the
//           first-turn user context from project brief + any seed text.
//        f. Create a new runs row (`is_manager=true`, `manager_layer='pm'`,
//           `conversation_id='pm:<projectId>'`, `parent_run_id=<top>`,
//           `manager_adapter='codex'`).
//        g. Call `codexAdapter.startSession(runId, { ..., resumeThreadId,
//           onThreadStarted })`. If `project_briefs.pm_thread_id` exists
//           we pass it as `resumeThreadId` so first turn hits
//           `codex exec resume <id>`. The `onThreadStarted` callback
//           persists freshly-captured thread ids into
//           `project_briefs.pm_thread_id`.
//        h. `managerRegistry.setActive('pm:<projectId>', runId, adapter)`.
//        i. Mark the run row started.
//
// Not in scope (explicitly deferred to later phases):
//   - Claude PM resume (Phase 3b — needs streamJsonEngine --resume work)
//   - routerService deterministic 3-step matcher (Phase 3a spec lists it
//     separately; the UI today sends explicit pm:<projectId> ids so the
//     matcher isn't on the hot path yet).

const { resolveManagerAuth, buildManagerSpawnEnv } = require('./authResolver');
const {
  buildManagerSystemPrompt,
  buildInitialUserContext,
} = require('./managerSystemPrompt');

function createPmSpawnService({
  runService,
  managerRegistry,
  managerAdapterFactory,
  projectService,
  projectBriefService,
  agentProfileService, // optional — used for env_allowlist resolution
  authResolverOpts = {},
  logger,
}) {
  const log = logger || ((msg) => console.log(`[pmSpawn] ${msg}`));

  // Resolve the adapter type to actually spawn for this project. Spec §7.2
  // fallback. 'claude' preference falls through to 'codex' until Phase 3b.
  function resolvePmAdapterType(project) {
    const preferred = project && project.preferred_pm_adapter
      ? project.preferred_pm_adapter
      : null;
    const globalDefault = process.env.PALANTIR_DEFAULT_PM_ADAPTER || null;
    const chosen = preferred || globalDefault || 'codex';
    if (chosen !== 'codex') {
      log(`project=${project.id} preferred=${chosen} falls through to 'codex' (Phase 3b required for claude PM)`);
      return 'codex';
    }
    return 'codex';
  }

  // Build the project-scoped SYSTEM prompt section that gets appended to
  // the shared PM layer template. Spec §9.5: "system prompt 완전히 정적
  // (cached_input_tokens 보호)". The brief is stable per run so baking
  // it into the instructions file is safe — Codex caches the entire
  // system prompt, so every subsequent turn hits the cache.
  //
  // Putting the brief HERE (not in a seed runTurn) is the codex-R1 fix
  // for the "previous turn still running" race: we must not call
  // adapter.runTurn from pmSpawnService because the caller
  // (conversationService.sendToManagerSlot) is about to call runTurn
  // with the user's actual message. Two back-to-back turns on the same
  // Codex run id hit the single-turn guard at codexAdapter:spawnOneTurn.
  function buildProjectScopedSystemSection({ project, brief }) {
    const sections = [];
    sections.push(`## Project Scope\nname: ${project.name}\nid: ${project.id}${project.directory ? `\ndirectory: ${project.directory}` : ''}`);
    if (brief && brief.conventions) {
      sections.push(`## Project Conventions\n${brief.conventions}`);
    }
    if (brief && brief.known_pitfalls) {
      sections.push(`## Known Pitfalls\n${brief.known_pitfalls}`);
    }
    sections.push('## PM Role\nYou are this project\'s PM (project-scoped dispatcher). Every user turn is either: answer from the brief, dispatch a worker via /execute, or modify an in-flight worker via the worker intervention APIs above. Stay within this project\'s scope.');
    return sections.join('\n\n');
  }

  // Main entry point. Returns { run, spawned, resumed } — `run` is the
  // PM run row (always populated on success), `spawned` is true iff a
  // fresh run was created in this call, `resumed` is true iff we passed
  // a persisted thread id to the adapter (i.e. reused an existing Codex
  // vendor thread).
  function ensureLivePm({ projectId, seedText }) {
    if (!projectId) {
      const err = new Error('projectId is required');
      err.httpStatus = 400;
      throw err;
    }
    const slotKey = `pm:${projectId}`;

    // Fast path — already live.
    const alreadyLive = managerRegistry.probeActive(slotKey);
    if (alreadyLive) {
      return { run: alreadyLive, spawned: false, resumed: false };
    }

    // Project must exist + PM must be enabled.
    let project;
    try {
      project = projectService.getProject(projectId);
    } catch {
      const err = new Error(`project not found: ${projectId}`);
      err.httpStatus = 404;
      throw err;
    }
    if (project.pm_enabled === 0) {
      const err = new Error(`PM is disabled for project ${projectId}`);
      err.httpStatus = 409;
      throw err;
    }

    // Parent Top must exist — PM has to hang off an active Top so that
    // parent-notice routing (PM→Top) and `resolveParentSlot()` in
    // conversationService continue to work.
    const activeTopRunId = managerRegistry.getActiveRunId('top');
    if (!activeTopRunId) {
      const err = new Error('no active Top manager — start a Top session before invoking PM');
      err.httpStatus = 409;
      throw err;
    }

    const adapterType = resolvePmAdapterType(project);
    const adapter = managerAdapterFactory.getAdapter(adapterType);

    // Resolve env_allowlist from the agent profile of the same type if
    // one exists — mirrors routes/manager.js /start behavior. We do NOT
    // require agent_profile_id for PM spawns (the PM is a server-owned
    // construct, not a user-selected profile), so if no profile is found
    // we fall through to the resolver's defaults.
    let envAllowlist;
    try {
      if (agentProfileService) {
        const profiles = agentProfileService.listProfiles();
        const codexProfile = profiles.find(p => p.type === 'codex');
        if (codexProfile && codexProfile.env_allowlist) {
          const parsed = JSON.parse(codexProfile.env_allowlist);
          if (Array.isArray(parsed)) envAllowlist = parsed;
        }
      }
    } catch { /* ignore — fall through to defaults */ }

    const authCtx = resolveManagerAuth(adapterType, { envAllowlist, ...authResolverOpts });
    if (!authCtx.canAuth) {
      const err = new Error(`PM auth unavailable for adapter=${adapterType}`);
      err.httpStatus = 400;
      err.details = { sources: authCtx.sources, diagnostics: authCtx.diagnostics };
      throw err;
    }
    const spawnEnv = buildManagerSpawnEnv({ authEnv: authCtx.env, envAllowlist });

    // Load brief (possibly empty row) + check for a persisted thread id.
    const brief = projectBriefService
      ? (projectBriefService.getBrief(projectId) || projectBriefService.ensureBrief(projectId))
      : null;
    const resumeThreadId = brief && brief.pm_thread_id ? brief.pm_thread_id : null;

    // System prompt for the PM layer. Dynamic context (run/agent/project
    // list) is deliberately NOT included — Codex's model_instructions_file
    // caching relies on a stable system prompt across turns. The project
    // brief IS stable per run (per-project, not per-turn), so we bake it
    // directly into the instructions file to avoid a separate seed
    // runTurn (which would race with the user's first send; codex R1
    // finding #1). The whole blob is still cached across turns.
    const port = process.env.PORT || 4177;
    const token = process.env.PALANTIR_TOKEN;
    const baseSystemPrompt = buildManagerSystemPrompt({ adapter, port, token, layer: 'pm' });
    const projectSection = buildProjectScopedSystemSection({ project, brief });
    const systemPrompt = [baseSystemPrompt, projectSection].filter(Boolean).join('\n\n');

    // Create the run row FIRST so we have a stable runId to register and
    // to reference in onThreadStarted. parent_run_id = active Top.
    const run = runService.createRun({
      is_manager: true,
      manager_layer: 'pm',
      conversation_id: slotKey,
      parent_run_id: activeTopRunId,
      manager_adapter: adapterType,
      prompt: `PM ${project.name}`,
    });
    const runId = run.id;

    // Hook that persists a freshly captured thread id into the brief.
    // Runs at most once per session (codexAdapter guards with
    // threadStartedFired). For resume, the adapter fires this synchronously
    // inside startSession with the existing id — we DON'T want to overwrite
    // the brief in that case (it's already equal).
    const onThreadStarted = (threadId) => {
      if (!threadId) return;
      if (resumeThreadId && resumeThreadId === threadId) return;
      try {
        projectBriefService.setPmThread(projectId, {
          pm_thread_id: threadId,
          pm_adapter: adapterType === 'codex' ? 'codex' : 'claude',
        });
      } catch (err) {
        log(`setPmThread failed project=${projectId}: ${err.message}`);
      }
    };

    // Spawn. Codex is stateless, so startSession writes the instructions
    // file and records metadata; the first actual `codex exec` runs on
    // the first runTurn call — which is the user's own message, made by
    // conversationService.sendToManagerSlot right after ensureLivePm
    // returns. No seed runTurn is issued here (codex R1 finding #1: a
    // seed would race with the user send against codexAdapter's
    // single-turn guard).
    const cwd = project.directory || process.cwd();
    try {
      adapter.startSession(runId, {
        systemPrompt,
        cwd,
        env: spawnEnv,
        role: 'manager',
        resumeThreadId,
        onThreadStarted,
      });
    } catch (err) {
      // Adapter startup failed — mark the run as failed and bubble up
      // so conversationService can surface a 502.
      try { runService.updateRunStatus(runId, 'failed', { force: true }); } catch { /* ignore */ }
      try { runService.addRunEvent(runId, 'error', JSON.stringify({ message: err.message })); } catch { /* ignore */ }
      const wrap = new Error(`PM adapter startSession failed: ${err.message}`);
      wrap.httpStatus = 502;
      throw wrap;
    }

    // Mark the run as started so lifecycleService + UI see it.
    try {
      runService.markRunStarted(runId, { tmux_session: null, worktree_path: null, branch: null });
    } catch { /* ignore */ }

    // Register in the manager registry so sendToManagerSlot finds it.
    managerRegistry.setActive(slotKey, runId, adapter);

    const registered = runService.getRun(runId);
    return { run: registered, spawned: true, resumed: !!resumeThreadId };
  }

  return { ensureLivePm, resolvePmAdapterType };
}

module.exports = { createPmSpawnService };
