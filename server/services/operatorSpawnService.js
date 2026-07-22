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
//       this before `sendToManagerSlot('operator:<projectId>')` so the slot is
//       guaranteed populated.
//
// Behavior:
//
//   1. If `managerRegistry.probeActive('operator:<projectId>')` already returns
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
//        c. Resolve the operator adapter: spec §7.2 fallback chain
//             project.preferred_pm_adapter → global default → 'codex'.
//           A 'claude' preference maps to the 'claude-code' adapter type
//           (P5-S4a). Codex + Claude operators both spawn; a REMOTE
//           (pod) Claude operator is gated off until P5-S4b (see the
//           isRemoteNode/'claude-code' fail-closed check below).
//        d. Resolve auth for the resolved adapter (preflight) and build
//           the filtered subprocess env — using the SAME-type agent
//           profile's env_allowlist (Claude vs Codex creds differ).
//        e. Build the operator system prompt with `layer: 'operator'`, and the
//           first-turn user context from project brief + any seed text.
//        f. Create a new runs row (`is_manager=true`, `manager_layer='operator'`,
//           `conversation_id='operator:<projectId>'`, `parent_run_id=<top>`,
//           `manager_adapter=<'codex'|'claude-code'>`).
//        g. Call `adapter.startSession(runId, { ... })`. Codex uses
//           `resumeThreadId`/`onThreadStarted` (thread id → pm_thread_id);
//           Claude uses `onSessionStarted` (system:init's claude_session_id)
//           to mark the run started. Both callbacks are passed; each adapter
//           consumes its own.
//        h. `managerRegistry.setActive('operator:<projectId>', runId, adapter)`.
//        i. Mark the run row started.
//
// Not in scope (explicitly deferred to later phases):
//   - Legacy routerService deterministic 3-step matcher (Phase 3a spec lists it
//     separately; the UI today sends explicit operator:<projectId> ids so the
//     matcher isn't on the hot path yet).

const { resolveManagerAuth: defaultResolveManagerAuth, buildManagerSpawnEnv } = require('./authResolver');
const {
  buildManagerSystemPrompt,
  buildInitialUserContext,
} = require('./managerSystemPrompt');
const { resolveSpawnCwd } = require('../utils/spawnCwd');
const { resolveCodexServiceTier } = require('./managerAdapters/codexAdapter'); // F-1
const { goalFeatureActive } = require('./goalMode'); // G2 §6
const { conversationIdForProject } = require('../utils/conversationId'); // PM→Operator Phase 0 producer seam
const { deriveLegacyContext, enforceWorkspace } = require('../utils/operatorContext');
const { resolveProjectSource } = require('./projectSource');
const { buildProjectScopedSystemSection: buildSharedProjectScopedSection } = require('./operatorPromptSections'); // A2b: single source, shared with boot-resume
const {
  repoFeatureEnabled,
  repoSourceHash,
  cwdFromWorkspacePath,
  resolveMaterializedRepoCwd,
  repoThreadSourceReset,
} = require('../utils/repoOperatorThread');

// Bounded wait for a peer's single-flight cache clone (see the pending loop in
// ensureLiveOperator). ~10s total across growing backoff (≤1s/step) before the
// operator spawn gives up with a 409 pending_timeout (client may retry).
const MATERIALIZE_PENDING_MAX_ATTEMPTS = 15;

function createOperatorSpawnService({
  runService,
  managerRegistry,
  managerAdapterFactory,
  projectService,
  projectBriefService,
  agentProfileService, // optional — used for env_allowlist resolution
  skillPackService,    // optional — Phase 2: inject project skill pack list into PM prompt
  nodeService,         // optional — Fleet P4: run Operators on the project's bound node
  projectMaterializationService,
  modelPolicyService,
  isSpecialistAvailable = () => false, // MD-1: mid-turn specialist delegation prompt gate
  authResolverOpts = {},
  resolveManagerAuth = defaultResolveManagerAuth, // optional DI — tests inject to force canAuth
  logger,
}) {
  const log = logger || ((msg) => console.log(`[pmSpawn] ${msg}`));
  // Async repo materialization leaves a window between the initial registry
  // probe and setActive(). Keep one promise per canonical instance slot so a
  // user send and a scheduler send cannot create two Operator runs.
  const spawnFlights = new Map();

  function failOperatorRun(runId, eventType, payload, message, httpStatus = 502) {
    try { runService.updateRunStatus(runId, 'failed', { force: true }); } catch { /* ignore */ }
    try { runService.addRunEvent(runId, eventType, JSON.stringify(payload || {})); } catch { /* ignore */ }
    const err = new Error(message);
    err.httpStatus = httpStatus;
    throw err;
  }

  async function materializeOperatorWorkspace({ runId, project, nodeId }) {
    if (!projectMaterializationService || typeof projectMaterializationService.ensureWorkspace !== 'function') {
      failOperatorRun(
        runId,
        'operator:materialize_failed',
        { project_id: project.id, reason: 'service_unavailable' },
        'repo materialization service is unavailable',
      );
    }
    const claimed = runService.claimQueuedRunForMaterialization(runId);
    if (!claimed?.token) {
      failOperatorRun(
        runId,
        'operator:materialize_failed',
        { project_id: project.id, reason: 'claim_failed' },
        'repo materialization claim failed',
      );
    }
    // A pending result means ANOTHER run (worker) holds the single-flight cache
    // lease and is cloning the same (project,node,generation). A real clone can
    // take several seconds, so a 3×100ms window would 409 the operator spawn
    // while the peer clone is still in flight. Wait longer (bounded, growing
    // backoff → ~10s) so the operator attaches to the freshly-cached repo once
    // the peer finishes, instead of forcing a manual retry (Codex PR5 NIT).
    let lastPending = null;
    for (let attempt = 0; attempt < MATERIALIZE_PENDING_MAX_ATTEMPTS; attempt += 1) {
      let result;
      try {
        result = await projectMaterializationService.ensureWorkspace({
          project,
          nodeId,
          runId,
          claimToken: claimed.token,
        });
      } catch (err) {
        failOperatorRun(
          runId,
          'operator:materialize_failed',
          { project_id: project.id, message: err.message },
          `repo materialization failed: ${err.message}`,
        );
      }
      if (result?.unsupported) {
        failOperatorRun(
          runId,
          'operator:repo_remote_unsupported',
          { project_id: project.id, node_id: nodeId || 'local' },
          'repo materialization is unsupported on remote nodes',
        );
      }
      if (result?.ready) {
        const current = result.run || runService.getRun(runId);
        const workspacePath = result.workspacePath || current.workspace_path || null;
        const cwd = result.cwd ||
          resolveMaterializedRepoCwd(current, project) ||
          cwdFromWorkspacePath(workspacePath, project);
        if (!workspacePath || !cwd) {
          failOperatorRun(
            runId,
            'operator:materialize_failed',
            { project_id: project.id, reason: 'workspace_missing' },
            'repo materialization completed without a workspace path',
          );
        }
        return { workspacePath, cwd };
      }
      if (result?.pending) {
        lastPending = result;
        const backoffMs = Math.min(Number(result.backoffMs || 100) * (attempt + 1), 1000);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      failOperatorRun(
        runId,
        'operator:materialize_failed',
        { project_id: project.id, reason: 'not_ready' },
        'repo materialization did not produce a ready workspace',
      );
    }
    failOperatorRun(
      runId,
      'operator:materialize_failed',
      { project_id: project.id, reason: 'pending_timeout', backoff_ms: lastPending?.backoffMs || null },
      'repo materialization is still pending',
      409,
    );
  }

  // Resolve the adapter type to actually spawn for this project. Spec §7.2
  // fallback. Project preferences use the persisted value ('claude'|'codex'),
  // while the adapter factory expects the concrete adapter key
  // ('claude-code'|'codex').
  function resolveOperatorAdapterType(project) {
    const preferred = project && project.preferred_pm_adapter
      ? project.preferred_pm_adapter
      : null;
    const globalDefault = process.env.PALANTIR_DEFAULT_PM_ADAPTER || null;
    const chosen = preferred || globalDefault || 'codex';
    if (chosen === 'codex') return 'codex';
    if (chosen === 'claude' || chosen === 'claude-code') return 'claude-code';
    const id = project && project.id != null ? project.id : 'unknown';
    log(`project=${id} unknown preferred=${chosen} → codex`);
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
  // A2b: delegate to the shared builder (server/services/operatorPromptSections)
  // so the fresh-spawn and boot-resume paths assemble byte-identical sections
  // from one source (Codex R2 BLOCKER 3). operatorRunId is baked so the Operator
  // can self-identify its pm_run_id for /api/dispatch-audit.
  function buildProjectScopedSystemSection({ project, brief, operatorRunId }) {
    return buildSharedProjectScopedSection({
      project,
      brief,
      operatorRunId,
      skillPackService,
      logger: (err) => log(`Failed to load skill packs for project=${project.id}: ${err.message}`),
    });
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

    let ensuredOperatorInstance = null;
    try {
      if (runService && typeof runService.ensurePrimaryOperatorInstanceForProject === 'function') {
        ensuredOperatorInstance = runService.ensurePrimaryOperatorInstanceForProject(projectId);
      }
    } catch (err) {
      log(`operator instance ensure failed project=${projectId}: ${err.message}`);
    }
    if (!ensuredOperatorInstance?.instanceId) {
      const err = new Error(`operator instance unavailable for project ${projectId}`);
      err.httpStatus = 500;
      throw err;
    }
    const slotKey = ensuredOperatorInstance?.instanceConversationId
      || conversationIdForProject(ensuredOperatorInstance.instanceId);

    // Fast path — already live. Legacy callers that still probe
    // operator:<projectId> converge to this same instance slot in managerRegistry.
    const alreadyLive = managerRegistry.probeActive(slotKey);
    if (alreadyLive) {
      return { run: alreadyLive, spawned: false, resumed: false };
    }
    const existingFlight = spawnFlights.get(slotKey);
    if (existingFlight) return existingFlight;

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
    const projectSource = resolveProjectSource(project);
    const isRepoProject = projectSource.isRepo;
    if (isRemoteNode && nodeService && typeof nodeService.getNode === 'function') {
      let node = null;
      try {
        node = nodeService.getNode(nodeId);
      } catch {
        node = null;
      }
      if (Number(node?.cordoned) === 1) {
        try {
          runService.addRunEvent(activeTopRunId, 'operator:spawn_blocked_cordoned', JSON.stringify({ node_id: nodeId, project_id: projectId }));
        } catch { /* ignore */ }
        const err = new Error('node is cordoned — uncordon before spawning an operator');
        err.httpStatus = 409;
        throw err;
      }
    }

    // P5-S4b: remote (pod) Claude Operators are now ENABLED + validated on a real
    // pod. The executor/nodePrefix routing below is adapter-generic (P4-S3b) and
    // the persistent Claude stream-json runs over the ssh duplex (P5-S0); the
    // S4a fail-closed gate that blocked isRemoteNode && 'claude-code' is removed.

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
        const managerProfile = profiles.find(p => p.type === adapterType);
        if (managerProfile) {
          if (managerProfile.env_allowlist) {
            const parsed = JSON.parse(managerProfile.env_allowlist);
            if (Array.isArray(parsed)) envAllowlist = parsed;
          }
          // P3-4: extract mcp_tools for PM adapter startup
          if (managerProfile.capabilities_json) {
            try {
              const caps = JSON.parse(managerProfile.capabilities_json);
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
    // G2 §6 (Codex BLOCKER-1): scrub PALANTIR_TOKEN from the Operator's spawn
    // env in goal mode so it cannot read the human token and spoof the gate.
    const spawnEnv = buildManagerSpawnEnv({ authEnv: authCtx.env, envAllowlist, scrubHumanToken: goalFeatureActive() });

    // Load brief content (conventions/pitfalls) plus the thread handle. W-P3
    // moves thread ownership to operator_instances; project_briefs remains a
    // read-only legacy bridge when an instance has no thread value yet.
    const brief = projectBriefService
      ? (projectBriefService.getBrief(projectId) || projectBriefService.ensureBrief(projectId))
      : null;
    let operatorInstanceResolution = null;
    try {
      if (runService && typeof runService.resolveOperatorConversationId === 'function') {
        operatorInstanceResolution = runService.resolveOperatorConversationId(slotKey);
      }
    } catch (err) {
      log(`operator instance lookup failed project=${projectId}: ${err.message}`);
    }
    let operatorInstanceId = operatorInstanceResolution && operatorInstanceResolution.instanceId
      ? operatorInstanceResolution.instanceId
      : (ensuredOperatorInstance?.instanceId || null);
    let instanceThread = null;
    try {
      instanceThread = operatorInstanceId && runService && typeof runService.getOperatorInstance === 'function'
        ? runService.getOperatorInstance(operatorInstanceId)
        : null;
    } catch (err) {
      log(`operator instance read failed instance=${operatorInstanceId}: ${err.message}`);
    }
    const instanceThreadState = instanceThread && instanceThread.thread_id
      ? {
          pm_thread_id: instanceThread.thread_id,
          pm_adapter: instanceThread.pm_adapter,
          pm_thread_node_id: instanceThread.node_id,
          pm_thread_cwd: instanceThread.cwd,
          pm_thread_source_generation: instanceThread.source_generation,
          pm_thread_source_hash: instanceThread.source_hash,
          pm_thread_workspace_path: instanceThread.workspace_path,
        }
      : null;
    const bridgeThreadState = !instanceThreadState && brief && brief.pm_thread_id ? brief : null; // W-P3 R1 BLOCKER: instance ROW may exist (W-P1 backfill/ensure) with NULL thread — fall back on missing thread STATE, not missing row
    const threadState = instanceThreadState || bridgeThreadState || null;
    const threadStateSource = instanceThreadState ? 'instance' : (bridgeThreadState ? 'bridge' : null);
    if (!operatorInstanceId) {
      try {
        if (runService && typeof runService.ensurePrimaryOperatorInstanceForProject === 'function') {
          const ensured = runService.ensurePrimaryOperatorInstanceForProject(projectId);
          operatorInstanceId = ensured && ensured.instanceId ? ensured.instanceId : null;
        }
      } catch (err) {
        log(`operator instance ensure failed project=${projectId}: ${err.message}`);
      }
    }
    const briefAdapter = threadState ? threadState.pm_adapter : null;
    let briefHandle = threadState && threadState.pm_thread_id ? threadState.pm_thread_id : null;
    const threadNode = threadState && threadState.pm_thread_node_id ? threadState.pm_thread_node_id : null;
    const expectedBriefAdapter = adapterType === 'codex' ? 'codex' : 'claude';
    let threadRebindReset = null;
    let threadSourceReset = null;
    const clearPersistedThreadState = () => {
      if (threadStateSource !== 'instance' || !operatorInstanceId) return;
      try {
        if (runService && typeof runService.setOperatorInstanceThread === 'function') {
          runService.setOperatorInstanceThread(operatorInstanceId, {});
        }
      } catch (err) {
        log(`clearOperatorInstanceThread failed instance=${operatorInstanceId}: ${err.message}`);
      }
    };
    if (briefHandle && (threadNode || 'local') !== (nodeId || 'local')) {
      threadRebindReset = { from_node: threadNode, to_node: nodeId || 'local' };
      briefHandle = null;
      clearPersistedThreadState();
    }
    if (briefHandle && isRepoProject) {
      threadSourceReset = repoThreadSourceReset(threadState, project);
      if (threadSourceReset) {
        briefHandle = null;
        clearPersistedThreadState();
      }
    }
    if (briefHandle && briefAdapter !== expectedBriefAdapter) {
      briefHandle = null;
      clearPersistedThreadState();
    }
    const resumeThreadId = adapterType === 'codex' && briefHandle && briefAdapter === 'codex'
      ? briefHandle
      : null;
    const resumeSessionId = adapterType === 'claude-code' && briefHandle && briefAdapter === 'claude'
      ? briefHandle
      : null;
    const resumeRepoWorkspace = isRepoProject && (resumeThreadId || resumeSessionId)
      ? {
          workspacePath: threadState.pm_thread_workspace_path,
          cwd: threadState.pm_thread_cwd || cwdFromWorkspacePath(threadState.pm_thread_workspace_path, project),
        }
      : null;

    // Create the run row FIRST so we have a stable runId. The runId is
    // baked into the project-scoped system prompt so the PM can
    // self-identify when calling POST /api/dispatch-audit (codex R3 fix
    // for the "PM has no way to know its own run id" contract gap).
    // parent_run_id = active Top.
    const run = runService.createRun({
      is_manager: true,
      manager_layer: 'operator',
      conversation_id: slotKey,
      operator_instance_id: operatorInstanceId,
      parent_run_id: activeTopRunId,
      manager_adapter: adapterType,
      prompt: `PM ${project.name}`,
      node_id: nodeId,
    });
    const runId = run.id;
    if (threadRebindReset) {
      try { runService.addRunEvent(runId, 'operator:thread_rebind_reset', JSON.stringify(threadRebindReset)); } catch { /* ignore */ }
    }
    if (threadSourceReset) {
      try { runService.addRunEvent(runId, 'operator:thread_source_reset', JSON.stringify(threadSourceReset)); } catch { /* ignore */ }
    }
    if (isRemoteNode && !process.env.PALANTIR_BASE_URL) {
      try { runService.addRunEvent(runId, 'operator:remote_base_url_localhost', JSON.stringify({ node_id: nodeId })); } catch { /* ignore */ }
    }

    const finishSpawn = (materializedRepoWorkspace = null) => {
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
    // G2 §6: in goal mode the Operator's API-call examples must reference the
    // separated PM token, never the human PALANTIR_TOKEN. Non-goal → unchanged.
    const goalActive = goalFeatureActive();
    const token = goalActive ? process.env.PALANTIR_PM_TOKEN : process.env.PALANTIR_TOKEN;
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
      if (threadStateSource === 'instance' && resumeThreadId && resumeThreadId === threadId) return;
      try {
        const fields = {
          pm_thread_id: threadId,
          pm_adapter: adapterType === 'codex' ? 'codex' : 'claude',
          pm_thread_node_id: isRemoteNode ? nodeId : null,
          pm_thread_cwd: materializedRepoWorkspace || isRemoteNode ? cwd : null,
        };
        if (materializedRepoWorkspace) {
          fields.pm_thread_source_generation = Number(project.source_generation || 0);
          fields.pm_thread_source_hash = repoSourceHash(project);
          fields.pm_thread_workspace_path = materializedRepoWorkspace.workspacePath;
        }
        if (runService && typeof runService.setOperatorInstanceThread === 'function') {
          runService.setOperatorInstanceThread(operatorInstanceId, fields);
        }
      } catch (err) {
        log(`setOperatorInstanceThread failed instance=${operatorInstanceId}: ${err.message}`);
      }
    };
    const onSessionStarted = (sessionId) => {
      markPmRunStartedOnce();
      if (!sessionId) return;
      // Skip a redundant brief write when we just RESUMED this exact session
      // (mirrors the codex onThreadStarted guard) — avoids a spurious
      // updated_at bump on every resume. (Codex P5-S4c NIT.)
      if (threadStateSource === 'instance' && resumeSessionId && resumeSessionId === sessionId) return;
      try {
        const fields = {
          pm_thread_id: sessionId,
          pm_adapter: 'claude',
          pm_thread_node_id: isRemoteNode ? nodeId : null,
          pm_thread_cwd: materializedRepoWorkspace || isRemoteNode ? cwd : null,
        };
        if (materializedRepoWorkspace) {
          fields.pm_thread_source_generation = Number(project.source_generation || 0);
          fields.pm_thread_source_hash = repoSourceHash(project);
          fields.pm_thread_workspace_path = materializedRepoWorkspace.workspacePath;
        }
        if (runService && typeof runService.setOperatorInstanceThread === 'function') {
          runService.setOperatorInstanceThread(operatorInstanceId, fields);
        }
      } catch (err) {
        log(`setOperatorInstanceThread(claude) failed instance=${operatorInstanceId}: ${err.message}`);
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
      if (materializedRepoWorkspace) {
        cwd = materializedRepoWorkspace.cwd;
      } else if (isRemoteNode) {
        cwd = project.directory || null;
      } else {
        const operatorContext = deriveLegacyContext({ run, workspaceDir: project.directory });
        enforceWorkspace(operatorContext, 'spawn_cwd');
        cwd = resolveSpawnCwd({ workspaceDir: project.directory });
      }
      try {
        const opVendor = adapterType === 'codex' ? 'codex' : 'claude';
        const opEff = modelPolicyService
          ? modelPolicyService.resolveEffective({ layer: 'operator', vendor: opVendor, projectId: project.id, env: process.env })
          : { model: null, effort: null };
        try { runService.setSessionSnapshot(runId, { sessionModel: opEff.model, sessionEffort: opEff.effort }); } catch { /* annotate-only */ }

        const startOpts = {
          systemPrompt,
          cwd,
          model: opEff.model || undefined,
          reasoning_effort: opEff.effort || undefined,
          // A REMOTE Operator must NOT receive the control-plane's spawnEnv
          // (buildManagerSpawnEnv is process.env-based): shipping the Mac's PATH
          // to the pod overrides the pathPrefix and breaks codex resolution (127
          // 'codex: No such file or directory'), and leaks control-plane creds.
          // The pod provides its own env + ~/.codex auth; codex is resolved via
          // nodePrefix→PATH. Local keeps the filtered spawnEnv. (Real-Pi finding;
          // S3a review SERIOUS-3.)
          env: isRemoteNode ? {} : spawnEnv,
          role: 'manager',
          nodeId,
          resumeThreadId,
          resumeSessionId,
          // F-1: per-turn Codex tier resolver — re-reads this instance's
          // fast_mode each turn so a live ⚡ toggle applies on the next turn
          // without a re-spawn. Ignored by the Claude adapter.
          serviceTier: operatorInstanceId
            ? () => (modelPolicyService
              ? modelPolicyService.resolveServiceTier({
                layer: 'operator',
                projectId: project.id,
                instanceFastMode: runService.getOperatorInstance(operatorInstanceId)?.fast_mode,
                env: process.env,
              })
              : resolveCodexServiceTier(runService.getOperatorInstance(operatorInstanceId)?.fast_mode))
            : (modelPolicyService
              ? modelPolicyService.resolveServiceTier({
                layer: 'operator',
                projectId: project.id,
                env: process.env,
              })
              : resolveCodexServiceTier(null)),
          onThreadStarted,
          onSessionStarted,
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
      return { run: registered, spawned: true, resumed: !!(resumeThreadId || resumeSessionId) };
    };

    if (isRepoProject) {
      if (!repoFeatureEnabled()) {
        failOperatorRun(
          runId,
          'operator:materialize_failed',
          { project_id: project.id, reason: 'feature_disabled' },
          'project repo materialization is disabled',
          409,
        );
      }
      if (isRemoteNode) {
        failOperatorRun(
          runId,
          'operator:repo_remote_unsupported',
          { project_id: project.id, node_id: nodeId || 'local' },
          'repo materialization is unsupported on remote nodes',
        );
      }
      if (resumeRepoWorkspace) {
        return finishSpawn(resumeRepoWorkspace);
      }
      let flight;
      flight = materializeOperatorWorkspace({ runId, project, nodeId })
        .then((workspace) => finishSpawn(workspace))
        .finally(() => {
          if (spawnFlights.get(slotKey) === flight) spawnFlights.delete(slotKey);
        });
      spawnFlights.set(slotKey, flight);
      return flight;
    }

    return finishSpawn();
  }

  return { ensureLiveOperator, resolveOperatorAdapterType };
}

module.exports = { createOperatorSpawnService };
