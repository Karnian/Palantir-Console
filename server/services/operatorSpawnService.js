// server/services/operatorSpawnService.js
//
// v3 Phase 3a: lazy spawn + resume for project-scoped PM manager runs.
// Spec §7 (PM Lazy 생성 모델) + §9.5 (Phase 3a 작업 목록).
//
// Contract:
//
//   ensureLiveOperator({ projectId, activeTopRun })
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

const { resolveManagerAuth: defaultResolveManagerAuth, buildManagerSpawnEnv } = require('./authResolver');
const {
  buildManagerSystemPrompt,
  buildInitialUserContext,
} = require('./managerSystemPrompt');
const { resolveSpawnCwd } = require('../utils/spawnCwd');
const { conversationIdForProject } = require('../utils/conversationId'); // PM→Operator Phase 0 producer seam
const { deriveLegacyContext, enforceWorkspace } = require('../utils/operatorContext');

function createOperatorSpawnService({
  runService,
  managerRegistry,
  managerAdapterFactory,
  projectService,
  projectBriefService,
  agentProfileService, // optional — used for env_allowlist resolution
  skillPackService,    // optional — Phase 2: inject project skill pack list into PM prompt
  nodeService,         // optional — Fleet P4: run Operators on the project's bound node
  isSpecialistAvailable = () => false, // MD-1: mid-turn specialist delegation prompt gate
  authResolverOpts = {},
  resolveManagerAuth = defaultResolveManagerAuth, // optional DI — tests inject to force canAuth
  logger,
}) {
  const log = logger || ((msg) => console.log(`[pmSpawn] ${msg}`));

  // Resolve the adapter type to actually spawn for this project. Spec §7.2
  // fallback. 'claude' preference falls through to 'codex' until Phase 3b.
  function resolveOperatorAdapterType(project) {
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
  // adapter.runTurn from operatorSpawnService because the caller
  // (conversationService.sendToManagerSlot) is about to call runTurn
  // with the user's actual message. Two back-to-back turns on the same
  // Codex run id hit the single-turn guard at codexAdapter:spawnOneTurn.
  function buildProjectScopedSystemSection({ project, brief, operatorRunId }) {
    const sections = [];
    // Include operatorRunId so the PM can self-identify when calling
    // /api/dispatch-audit (codex R3 blocker: the audit route requires
    // pm_run_id for staleness attribution but the PM previously had no
    // way to obtain its own run id).
    sections.push(`## Project Scope\nname: ${project.name}\nid: ${project.id}${project.directory ? `\ndirectory: ${project.directory}` : ''}${operatorRunId ? `\npm_run_id: ${operatorRunId}` : ''}`);
    if (brief && brief.conventions) {
      sections.push(`## Project Conventions\n${brief.conventions}`);
    }
    if (brief && brief.known_pitfalls) {
      sections.push(`## Known Pitfalls\n${brief.known_pitfalls}`);
    }
    // Phase 2: inject project auto_apply skill packs list (name + description)
    // so the PM knows which skills are available and can choose task-appropriate ones.
    // This is baked into the static system prompt (Codex caching-safe: stable per PM session).
    if (skillPackService) {
      try {
        const bindings = skillPackService.listProjectBindings(project.id);
        const autoApply = bindings.filter(b => b.auto_apply !== 0);
        if (autoApply.length > 0) {
          const lines = autoApply.map(b =>
            `- ${b.skill_pack_name}${b.skill_pack_description ? `: ${b.skill_pack_description}` : ''} (id: ${b.skill_pack_id})`
          );
          sections.push(`## Project Skill Packs (auto_apply)\nThese skills are automatically applied to every worker in this project. You do NOT need to include them in skill_pack_ids.\n${lines.join('\n')}`);
        }
      } catch (err) { log(`Failed to load skill packs for project=${project.id}: ${err.message}`); }
    }
    sections.push('## PM Role\nYou are this project\'s PM (project-scoped dispatcher). Every user turn is either: answer from the brief, dispatch a worker via /execute, or modify an in-flight worker via the worker intervention APIs above. When you record a dispatch audit claim, use the pm_run_id value shown above in the Project Scope section as your pm_run_id envelope field. Stay within this project\'s scope.\n\nWhen spawning workers, choose skill packs that match the task\'s nature. Use your project\'s auto_apply skills as a baseline, and add extra skills via skill_pack_ids when the task needs specialized capabilities beyond the defaults.');
    return sections.join('\n\n');
  }

  // Main entry point. Returns { run, spawned, resumed } — `run` is the
  // PM run row (always populated on success), `spawned` is true iff a
  // fresh run was created in this call, `resumed` is true iff we passed
  // a persisted thread id to the adapter (i.e. reused an existing Codex
  // vendor thread).
  function ensureLiveOperator({ projectId, seedText }) {
    if (!projectId) {
      const err = new Error('projectId is required');
      err.httpStatus = 400;
      throw err;
    }
    const slotKey = conversationIdForProject(projectId); // pm: → operator: in Phase 2

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

    const adapterType = resolveOperatorAdapterType(project);
    const adapter = managerAdapterFactory.getAdapter(adapterType);
    const nodeId = (nodeService && typeof nodeService.resolveNode === 'function')
      ? (nodeService.resolveNode(project) || 'local')
      : 'local';
    const isRemoteNode = !!(nodeId && nodeId !== 'local');

    // Resolve env_allowlist and mcp_tools from the agent profile of the same
    // type if one exists — mirrors routes/manager.js /start behavior. We do
    // NOT require agent_profile_id for PM spawns (the PM is a server-owned
    // construct, not a user-selected profile), so if no profile is found we
    // fall through to the resolver's defaults.
    let envAllowlist;
    let pmMcpTools = [];
    try {
      if (agentProfileService) {
        const profiles = agentProfileService.listProfiles();
        const codexProfile = profiles.find(p => p.type === 'codex');
        if (codexProfile) {
          if (codexProfile.env_allowlist) {
            const parsed = JSON.parse(codexProfile.env_allowlist);
            if (Array.isArray(parsed)) envAllowlist = parsed;
          }
          // P3-4: extract mcp_tools for PM adapter startup
          if (codexProfile.capabilities_json) {
            try {
              const caps = JSON.parse(codexProfile.capabilities_json);
              if (Array.isArray(caps.mcp_tools)) {
                pmMcpTools = caps.mcp_tools.filter(t => typeof t === 'string' && t.trim());
              }
            } catch { /* ignore */ }
          }
        }
      }
    } catch { /* ignore — fall through to defaults */ }

    const authCtx = resolveManagerAuth(adapterType, { envAllowlist, ...authResolverOpts });
    // A REMOTE Operator authenticates on the POD (its own ~/.codex), not the
    // control plane, and gets env:{} at runtime — so control-plane Codex auth is
    // irrelevant and must NOT preflight-block a remote spawn (the pod may be
    // logged in while the controller has no CODEX_API_KEY/~/.codex). Local
    // Operators still require it. (Codex S3b review; matches the env:{} fix.)
    if (!isRemoteNode && !authCtx.canAuth) {
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
    let resumeThreadId = brief && brief.pm_thread_id ? brief.pm_thread_id : null;
    const threadNode = brief && brief.pm_thread_node_id ? brief.pm_thread_node_id : null;
    let threadRebindReset = null;
    if (resumeThreadId && (threadNode || 'local') !== (nodeId || 'local')) {
      threadRebindReset = { from_node: threadNode, to_node: nodeId || 'local' };
      resumeThreadId = null;
      try {
        if (projectBriefService && typeof projectBriefService.clearPmThread === 'function') {
          projectBriefService.clearPmThread(projectId);
        }
      } catch (err) {
        log(`clearPmThread failed project=${projectId}: ${err.message}`);
      }
    }

    // Create the run row FIRST so we have a stable runId. The runId is
    // baked into the project-scoped system prompt so the PM can
    // self-identify when calling POST /api/dispatch-audit (codex R3 fix
    // for the "PM has no way to know its own run id" contract gap).
    // parent_run_id = active Top.
    const run = runService.createRun({
      is_manager: true,
      manager_layer: 'operator',
      conversation_id: slotKey,
      parent_run_id: activeTopRunId,
      manager_adapter: adapterType,
      prompt: `PM ${project.name}`,
      node_id: nodeId,
    });
    const runId = run.id;
    if (threadRebindReset) {
      try { runService.addRunEvent(runId, 'operator:thread_rebind_reset', JSON.stringify(threadRebindReset)); } catch { /* ignore */ }
    }
    if (isRemoteNode && !process.env.PALANTIR_BASE_URL) {
      try { runService.addRunEvent(runId, 'operator:remote_base_url_localhost', JSON.stringify({ node_id: nodeId })); } catch { /* ignore */ }
    }

    let executor;
    let nodePrefix;
    if (isRemoteNode) {
      try {
        const node = nodeService.getNode(nodeId);
        executor = nodeService.pickExecutor(nodeId);
        if (!executor) throw new Error(`No executor available for node ${nodeId}`);
        nodePrefix = node && node.node_prefix ? node.node_prefix : undefined;
      } catch (err) {
        try { runService.updateRunStatus(runId, 'failed', { force: true }); } catch { /* ignore */ }
        try { runService.addRunEvent(runId, 'error', JSON.stringify({ message: err.message })); } catch { /* ignore */ }
        const wrap = new Error(`PM node executor unavailable: ${err.message}`);
        wrap.httpStatus = 502;
        throw wrap;
      }
    }

    // System prompt for the PM layer. Dynamic context (run/agent/project
    // list) is deliberately NOT included — Codex's model_instructions_file
    // caching relies on a stable system prompt across turns. The project
    // brief IS stable per run (per-project, not per-turn), so we bake it
    // directly into the instructions file to avoid a separate seed
    // runTurn (which would race with the user's first send; codex R1
    // finding #1). The whole blob is still cached across turns.
    const port = process.env.PORT || 4177;
    const token = process.env.PALANTIR_TOKEN;
    const baseSystemPrompt = buildManagerSystemPrompt({ adapter, port, token, layer: 'operator', adapterType, specialistAvailable: isSpecialistAvailable() });
    const projectSection = buildProjectScopedSystemSection({ project, brief, operatorRunId: runId });
    const systemPrompt = [baseSystemPrompt, projectSection].filter(Boolean).join('\n\n');

    // Hook that persists a freshly captured thread id into the brief AND
    // flips the PM run row from queued → running. Fires exactly once per
    // session (codexAdapter guards with threadStartedFired). For resume,
    // the adapter fires this synchronously inside startSession with the
    // existing id — we DON'T want to overwrite the brief in that case
    // (it's already equal), but we DO still want to mark the run started
    // immediately because a resumed Codex session IS live from the
    // caller's point of view.
    //
    // P2-1 fix: markRunStarted was previously called unconditionally
    // right after startSession returned. For Codex (stateless adapter —
    // the `codex exec` process is not spawned until the first runTurn)
    // that was a lie: the PM was advertised as `running` before any turn
    // actually executed, so the UI `pmRunActive` badge turned "Active"
    // pre-flight. The correct "execution actually started" boundary is
    // thread.started (fresh spawn) or synchronous resume. We piggyback
    // on this callback so the semantics match adapter reality without
    // adding a second state flag. If the first runTurn fails before
    // emitting thread.started, the run stays in `queued` — which is
    // also correct (we never actually started).
    let markStartedOnce = false;
    function markPmRunStartedOnce() {
      if (markStartedOnce) return;
      markStartedOnce = true;
      try {
        runService.markRunStarted(runId, {
          tmux_session: null,
          worktree_path: null,
          branch: null,
        });
      } catch (err) {
        log(`markRunStarted failed run=${runId}: ${err.message}`);
      }
    }
    const onThreadStarted = (threadId) => {
      if (!threadId) return;
      markPmRunStartedOnce();
      if (resumeThreadId && resumeThreadId === threadId) return;
      try {
        projectBriefService.setPmThread(projectId, {
          pm_thread_id: threadId,
          pm_adapter: adapterType === 'codex' ? 'codex' : 'claude',
          pm_thread_node_id: isRemoteNode ? nodeId : null,
          pm_thread_cwd: isRemoteNode ? cwd : null,
        });
      } catch (err) {
        log(`setPmThread failed project=${projectId}: ${err.message}`);
      }
    };

    // Spawn. Codex is stateless, so startSession writes the instructions
    // file and records metadata; the first actual `codex exec` runs on
    // the first runTurn call — which is the user's own message, made by
    // conversationService.sendToManagerSlot right after ensureLiveOperator
    // returns. No seed runTurn is issued here (codex R1 finding #1: a
    // seed would race with the user send against codexAdapter's
    // single-turn guard).
    // P-B2b: thread the operator context through the coder-PM spawn path and
    // enforce the workspace surface. A coder PM is always legacy (folder +
    // dispatcher), so isEnforced===false → provable no-op (byte-identical). The
    // seam is proven to compose with the real run + project.directory here.
    let cwd;
    if (isRemoteNode) {
      cwd = project.directory || null;
    } else {
      const operatorContext = deriveLegacyContext({ run, workspaceDir: project.directory });
      enforceWorkspace(operatorContext, 'spawn_cwd');
      cwd = resolveSpawnCwd({ workspaceDir: project.directory });
    }
    try {
      const startOpts = {
        systemPrompt,
        cwd,
        // A REMOTE Operator must NOT receive the control-plane's spawnEnv
        // (buildManagerSpawnEnv is process.env-based): shipping the Mac's PATH
        // to the pod overrides the pathPrefix and breaks codex resolution (127
        // 'codex: No such file or directory'), and leaks control-plane creds.
        // The pod provides its own env + ~/.codex auth; codex is resolved via
        // nodePrefix→PATH. Local keeps the filtered spawnEnv. (Real-Pi finding;
        // S3a review SERIOUS-3.)
        env: isRemoteNode ? {} : spawnEnv,
        role: 'manager',
        resumeThreadId,
        onThreadStarted,
        mcpTools: pmMcpTools.length > 0 ? pmMcpTools : undefined,
        // P4-2: pass project-scoped MCP config file path to the adapter.
        // Claude adapter forwards this to streamJsonEngine as --mcp-config.
        // Codex adapter accepts only object-shaped MCP config for dotted
        // -c flattening, so it skips path strings and annotates the run.
        mcpConfig: project.mcp_config_path || undefined,
      };
      if (isRemoteNode) {
        startOpts.executor = executor;
        startOpts.nodePrefix = nodePrefix;
      }
      adapter.startSession(runId, startOpts);
    } catch (err) {
      // Adapter startup failed — mark the run as failed and bubble up
      // so conversationService can surface a 502.
      try { runService.updateRunStatus(runId, 'failed', { force: true }); } catch { /* ignore */ }
      try { runService.addRunEvent(runId, 'error', JSON.stringify({ message: err.message })); } catch { /* ignore */ }
      const wrap = new Error(`PM adapter startSession failed: ${err.message}`);
      wrap.httpStatus = 502;
      throw wrap;
    }

    // P2-1: markRunStarted is NO LONGER called here. The onThreadStarted
    // callback above now owns that transition:
    //   - resume path: onThreadStarted fires synchronously inside
    //     adapter.startSession, so the run is already 'running' by the
    //     time we reach this line.
    //   - fresh spawn path: onThreadStarted fires on the first turn's
    //     vendor 'thread.started' event, so the run stays in 'queued'
    //     until the first real `codex exec` subprocess actually starts.
    //     That matches the UI `pmRunActive` semantic (run.status ===
    //     'running' === adapter has a live execution context).

    // Register in the manager registry so sendToManagerSlot finds it.
    managerRegistry.setActive(slotKey, runId, adapter);

    const registered = runService.getRun(runId);
    return { run: registered, spawned: true, resumed: !!resumeThreadId };
  }

  return { ensureLiveOperator, resolveOperatorAdapterType };
}

module.exports = { createOperatorSpawnService };
