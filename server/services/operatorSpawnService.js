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
//        c. Resolve the operator adapter: instance preference first, then the
//           spec §7.2 fallback chain
//             instance.preferred_adapter → project.preferred_pm_adapter
//             → global default → 'codex'.
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
  resolveManagerApiEndpoints,
} = require('./managerSystemPrompt');
const { resolveSpawnCwd } = require('../utils/spawnCwd');
const { resolveCodexServiceTier } = require('./managerAdapters/codexAdapter'); // F-1
const { goalFeatureActive: defaultGoalFeatureActive } = require('./goalMode'); // G2 §6
const { resolveActorTokenPolicy, applyManagerCredentialPolicy } = require('./actorTokenPolicy');
const {
  parseClaudeArgsTemplate,
  resolveClaudePermissionMode,
} = require('./agentProfileService');
const { resolveAgentVendor } = require('../utils/agentVendor');
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

function mergeClaudeMcpConfigs(...configs) {
  const present = configs.filter(Boolean);
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : present;
}

function createOperatorSpawnService({
  runService,
  managerRegistry,
  managerAdapterFactory,
  projectService,
  projectBriefService,
  operatorProfileService, // optional in legacy test seams; production injects it
  agentProfileService, // optional — used for env_allowlist resolution
  skillPackService,    // optional — Phase 2: inject project skill pack list into PM prompt
  nodeService,         // optional — Fleet P4: run Operators on the project's bound node
  nodeUsageService,    // optional — probes remote CLI installation/auth for NULL preference fallback
  projectMaterializationService,
  modelPolicyService,
  isSpecialistAvailable = () => false, // MD-1: mid-turn specialist delegation prompt gate
  authResolverOpts = {},
  resolveManagerAuth = defaultResolveManagerAuth, // optional DI — tests inject to force canAuth
  actorTokens = resolveActorTokenPolicy(),
  managerCapabilityTokenService = null,
  managerApiEndpoints = null,
  goalFeatureActive = defaultGoalFeatureActive,
  logger,
}) {
  const log = logger || ((msg) => console.log(`[pmSpawn] ${msg}`));
  const actorSpawnBaseEnv = applyManagerCredentialPolicy(process.env);
  const promptApiEndpoints = managerApiEndpoints || resolveManagerApiEndpoints();
  const normalizedAuthResolverOpts = { ...authResolverOpts };
  for (const key of ['hasKeychain', 'hasCredentialsFile']) {
    if (key in normalizedAuthResolverOpts && typeof normalizedAuthResolverOpts[key] !== 'function') {
      const available = Boolean(normalizedAuthResolverOpts[key]);
      normalizedAuthResolverOpts[key] = () => available;
    }
  }
  if (actorTokens.humanToken && !managerCapabilityTokenService) {
    throw new Error('authenticated Operator spawn requires managerCapabilityTokenService');
  }
  // Async repo materialization leaves a window between the initial registry
  // probe and setActive(). Keep one promise per canonical instance slot so a
  // user send and a scheduler send cannot create two Operator runs.
  const spawnFlights = new Map();
  // Identity mutations (such as changing the CLI) must not race a lazy spawn.
  // The transition fence blocks new spawns, waits for an existing flight to
  // settle, then lets the caller reset/persist atomically from the service's
  // point of view.
  const instanceTransitions = new Set();

  async function withInstanceTransition(instanceId, action) {
    if (!instanceId) throw new Error('instanceId is required');
    if (typeof action !== 'function') throw new Error('transition action is required');
    const slotKey = conversationIdForProject(instanceId);
    if (instanceTransitions.has(slotKey)) {
      const err = new Error(`operator transition already in progress: ${instanceId}`);
      err.httpStatus = 409;
      throw err;
    }
    instanceTransitions.add(slotKey);
    try {
      const flight = spawnFlights.get(slotKey);
      if (flight) {
        try {
          await flight;
        } catch {
          // A failed spawn owns no usable runtime. The identity transition can
          // still reset residual state and persist the new preference.
        }
      }
      return await action();
    } finally {
      instanceTransitions.delete(slotKey);
    }
  }

  function isInstanceTransitioning(instanceId) {
    return Boolean(instanceId && instanceTransitions.has(conversationIdForProject(instanceId)));
  }

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

  // Resolve the adapter type to actually spawn. A durable Operator instance's
  // explicit preference wins; NULL preserves the legacy project → global →
  // Codex fallback chain. Stored preferences use 'claude'|'codex', while the
  // adapter factory expects the concrete key 'claude-code'|'codex'.
  function resolveOperatorAdapterType(project, operatorInstance = null) {
    const instancePreferred = operatorInstance && operatorInstance.preferred_adapter
      ? operatorInstance.preferred_adapter
      : null;
    const projectPreferred = project && project.preferred_pm_adapter
      ? project.preferred_pm_adapter
      : null;
    const globalDefault = process.env.PALANTIR_DEFAULT_PM_ADAPTER || null;
    const chosen = instancePreferred || projectPreferred || globalDefault || 'codex';
    if (chosen === 'codex') return 'codex';
    if (chosen === 'claude' || chosen === 'claude-code') return 'claude-code';
    const id = project && project.id != null ? project.id : 'unknown';
    log(`project=${id} unknown preferred=${chosen} → codex`);
    return 'codex';
  }

  function resolveManagerProfileRuntime(adapterType, profiles, { isRemoteNode = false } = {}) {
    const managerProfile = profiles.find(p => p.type === adapterType) || null;
    let envAllowlist;
    let mcpTools = [];
    let tools = [];
    let disallowedTools = [];
    let maxBudgetUsd = null;
    let profileMcpConfig = null;
    let strictMcpConfig = false;
    let safeMode = false;
    let bare = false;
    let disableSlashCommands = false;
    let noChrome = false;
    let settingSources = null;
    let settings = null;
    let permissionMode = adapterType === 'claude-code' ? 'bypassPermissions' : undefined;
    // The null-preference path evaluates BOTH adapters, so a rejected profile
    // for the adapter we end up discarding must not fail the spawn. Carry the
    // error and let the caller throw only for the adapter it actually selects.
    // This covers vendor mismatch AND a malformed args_template — both are 400s
    // that used to be raised only for the already-selected adapter.
    let profileError = null;
    if (managerProfile) {
      const expectedVendor = adapterType === 'claude-code' ? 'claude' : 'codex';
      const commandVendor = resolveAgentVendor(managerProfile.command);
      if (commandVendor !== expectedVendor) {
        const err = new Error(
          `Operator profile ${managerProfile.id} command vendor does not match ${adapterType}`,
        );
        err.httpStatus = 400;
        err.code = 'OPERATOR_PROFILE_VENDOR_MISMATCH';
        err.details = {
          profileId: managerProfile.id,
          profileType: managerProfile.type,
          command: managerProfile.command,
        };
        profileError = err;
      }
      if (!profileError && adapterType === 'claude-code') {
        try {
          permissionMode = resolveClaudePermissionMode(managerProfile);
          const templateOptions = parseClaudeArgsTemplate(managerProfile.args_template);
          tools = templateOptions.tools;
          disallowedTools = templateOptions.disallowedTools;
          maxBudgetUsd = templateOptions.maxBudgetUsd;
          profileMcpConfig = templateOptions.mcpConfig;
          strictMcpConfig = templateOptions.strictMcpConfig;
          safeMode = templateOptions.safeMode;
          bare = templateOptions.bare;
          disableSlashCommands = templateOptions.disableSlashCommands;
          noChrome = templateOptions.noChrome;
          settingSources = templateOptions.settingSources;
          settings = templateOptions.settings;
        } catch (err) {
          // A malformed profile must NOT silently downgrade to bypass defaults,
          // so keep the 400 — but only for the adapter that gets selected.
          if (err?.status === 400 || err?.httpStatus === 400) profileError = err;
          else throw err;
        }
      }
      if (managerProfile.env_allowlist) {
        try {
          const parsed = JSON.parse(managerProfile.env_allowlist);
          if (Array.isArray(parsed)) envAllowlist = parsed;
        } catch { /* use resolver defaults */ }
      }
      // P3-4: extract mcp_tools for PM adapter startup
      if (managerProfile.capabilities_json) {
        try {
          const caps = JSON.parse(managerProfile.capabilities_json);
          if (Array.isArray(caps.mcp_tools)) {
            mcpTools = caps.mcp_tools.filter(t => typeof t === 'string' && t.trim());
          }
        } catch { /* no MCP tools */ }
      }
    }
    const authCtx = resolveManagerAuth(adapterType, {
      envAllowlist,
      ...normalizedAuthResolverOpts,
      // A remote Claude Operator materializes `--bare` auth from the pod's
      // login store inside the executor. Do not read/materialize controller
      // credentials that will deliberately be discarded at this boundary.
      bare: !isRemoteNode && bare === true,
      settings,
    });
    return {
      adapterType,
      envAllowlist,
      mcpTools,
      authCtx,
      tools,
      disallowedTools,
      maxBudgetUsd,
      profileMcpConfig,
      strictMcpConfig,
      safeMode,
      bare,
      disableSlashCommands,
      noChrome,
      settingSources,
      settings,
      permissionMode,
      profileError,
    };
  }

  function remoteManagerAdapterCanStart(card) {
    if (!card || card.installed !== true) return false;
    if (card.id === 'codex') {
      // A successful Codex app-server usage probe proves both the CLI and its
      // node-local auth can start. Installation alone is not enough.
      return !card.error;
    }
    if (card.id === 'claude') {
      // Claude auth status is captured before the optional quota lookup. Keep
      // a logged-in CLI eligible even when only the quota endpoint is down.
      return Boolean(card.authStatus && card.authStatus.loggedIn !== false);
    }
    return false;
  }

  async function resolveRemoteDefaultAdapter(nodeId) {
    try {
      const snapshot = await nodeUsageService.getUsageSnapshot(nodeId);
      const cards = new Map((snapshot?.clis || []).map(card => [card?.id, card]));
      if (remoteManagerAdapterCanStart(cards.get('codex'))) return 'codex';
      if (remoteManagerAdapterCanStart(cards.get('claude'))) return 'claude-code';
    } catch (err) {
      log(`remote adapter availability probe failed node=${nodeId}: ${err.message}`);
    }
    // Probe uncertainty must not turn the legacy default into a hard failure.
    // The first real turn will still surface an actionable adapter error.
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
  function buildProjectScopedSystemSection({ project, profile, brief, operatorRunId }) {
    return buildSharedProjectScopedSection({
      project,
      profile,
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
  function ensureLiveOperatorResolved({ projectId, seedText }, remoteDefaultAdapter = null) {
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
      err.code = 'OPERATOR_TARGET_NOT_FOUND';
      err.retryable = false;
      throw err;
    }
    if (project.pm_enabled === 0) {
      const err = new Error(`PM is disabled for project ${projectId}`);
      err.httpStatus = 409;
      err.code = 'OPERATOR_DISABLED';
      err.retryable = false;
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
    if (instanceTransitions.has(slotKey)) {
      const err = new Error('operator identity transition in progress');
      err.httpStatus = 409;
      err.code = 'OPERATOR_BUSY';
      err.retryable = true;
      throw err;
    }

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
      err.code = 'OPERATOR_PARENT_MISSING';
      err.retryable = true;
      throw err;
    }

    let adapterPreferenceInstance = null;
    try {
      adapterPreferenceInstance = runService
        && typeof runService.getOperatorInstance === 'function'
        ? runService.getOperatorInstance(ensuredOperatorInstance.instanceId)
        : null;
    } catch (err) {
      log(`operator adapter preference read failed instance=${ensuredOperatorInstance.instanceId}: ${err.message}`);
    }
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
        err.code = 'OPERATOR_NODE_UNAVAILABLE';
        err.retryable = true;
        throw err;
      }
    }
    if (isRemoteNode && !promptApiEndpoints.remote) {
      try {
        runService.addRunEvent(activeTopRunId, 'operator:remote_base_url_unavailable', JSON.stringify({
          node_id: nodeId,
          project_id: projectId,
        }));
      } catch { /* ignore */ }
      const err = new Error(
        'remote Operator requires a Console URL reachable from its node; set PALANTIR_BASE_URL or bind the Console to a non-loopback host',
      );
      err.httpStatus = 409;
      err.code = 'OPERATOR_REMOTE_BASE_URL_UNAVAILABLE';
      err.retryable = false;
      throw err;
    }

    let profiles = [];
    try {
      if (agentProfileService) profiles = agentProfileService.listProfiles();
    } catch { /* use resolver defaults */ }

    const configuredPreference = Boolean(
      adapterPreferenceInstance?.preferred_adapter
      || project?.preferred_pm_adapter
      || process.env.PALANTIR_DEFAULT_PM_ADAPTER,
    );
    if (
      isRemoteNode
      && !configuredPreference
      && !remoteDefaultAdapter
      && nodeUsageService
      && typeof nodeUsageService.getUsageSnapshot === 'function'
    ) {
      // Remote Operators authenticate on their execution node, so the local
      // auth resolver cannot choose the fallback adapter. Probe the pod before
      // persisting the manager_adapter. Keep this in the existing spawn-flight
      // fence: concurrent first messages must share one probe and one spawn.
      let flight;
      flight = resolveRemoteDefaultAdapter(nodeId)
        .then((resolvedAdapter) => {
          if (spawnFlights.get(slotKey) === flight) spawnFlights.delete(slotKey);
          return ensureLiveOperatorResolved({ projectId, seedText }, resolvedAdapter);
        })
        .finally(() => {
          if (spawnFlights.get(slotKey) === flight) spawnFlights.delete(slotKey);
        });
      spawnFlights.set(slotKey, flight);
      return flight;
    }

    let adapterType = remoteDefaultAdapter
      || resolveOperatorAdapterType(project, adapterPreferenceInstance);
    let managerRuntime;
    if (!isRemoteNode && !configuredPreference) {
      // The null-preference contract keeps Codex first, but it is a fallback
      // order rather than an instruction to select an unusable adapter. Probe
      // each locally available manager credential path with that adapter's own
      // profile allowlist and pick the first one that can actually start.
      const candidates = ['codex', 'claude-code']
        .map(type => resolveManagerProfileRuntime(type, profiles, { isRemoteNode }));
      managerRuntime = candidates.find(candidate => candidate.authCtx.canAuth) || candidates[0];
      adapterType = managerRuntime.adapterType;
    } else {
      managerRuntime = resolveManagerProfileRuntime(adapterType, profiles, { isRemoteNode });
    }
    const adapter = managerAdapterFactory.getAdapter(adapterType);

    // P5-S4b: remote (pod) Claude Operators are now ENABLED + validated on a real
    // pod. The executor/nodePrefix routing below is adapter-generic (P4-S3b) and
    // the persistent Claude stream-json runs over the ssh duplex (P5-S0); the
    // S4a fail-closed gate that blocked isRemoteNode && 'claude-code' is removed.

    // Resolve env_allowlist, mcp_tools and the Claude profile options from the
    // SELECTED adapter's profile. The auth context was resolved at selection
    // time so the null-preference fallback and the eventual spawn use exactly
    // the same allowlist, bare flag and settings.
    const {
      envAllowlist,
      mcpTools: pmMcpTools,
      authCtx,
      tools,
      disallowedTools,
      maxBudgetUsd,
      profileMcpConfig,
      strictMcpConfig,
      safeMode,
      bare,
      disableSlashCommands,
      noChrome,
      settingSources,
      settings,
      permissionMode,
      profileError,
    } = managerRuntime;
    // Same contract as before the null-preference probe: a profile that
    // contradicts the adapter we are about to spawn (wrong command vendor, or a
    // malformed args_template) is a 400 — but only for the SELECTED adapter.
    if (profileError) throw profileError;
    // Resolve before the auth gate so migration diagnostics are observable
    // even when a legacy ambient auth mode is no longer sufficient.
    const spawnEnv = applyManagerCredentialPolicy(isRemoteNode ? {} : buildManagerSpawnEnv({
      baseEnv: actorSpawnBaseEnv,
      authEnv: authCtx.env,
      envAllowlist,
      vendor: adapterType,
      scrubHumanToken: actorTokens.separated || goalFeatureActive(),
      diagnosticContext: 'manager:fresh:operator',
    }));
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
    // Global actor credentials are stripped above. The run-bound Console
    // capability is added only after the run exists; it never enters this
    // reusable base environment or the persisted system prompt.

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
    // Mint a boot-local, run-bound capability. The prompt receives only an
    // environment-variable reference; the value crosses at the final manager
    // process seam and is absent from the persisted prompt file and argv.
    const token = managerCapabilityTokenService
      && typeof managerCapabilityTokenService.mint === 'function'
      ? managerCapabilityTokenService.mint(runId, {
          conversationId: slotKey,
          layer: 'operator',
        })
      : null;
    let operatorProfile = null;
    if (operatorProfileService && operatorInstanceId) {
      const currentInstance = runService.getOperatorInstance(operatorInstanceId);
      operatorProfile = operatorProfileService.getProfile(currentInstance.profile_id);
    }
    const baseSystemPrompt = buildManagerSystemPrompt({
      adapter,
      port,
      token: !!token,
      layer: 'operator',
      adapterType,
      specialistAvailable: isSpecialistAvailable(),
      apiBaseUrl: isRemoteNode ? promptApiEndpoints.remote : promptApiEndpoints.local,
    });
    const projectSection = buildProjectScopedSystemSection({
      project,
      profile: operatorProfile,
      brief,
      operatorRunId: runId,
    });
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
        const effectiveMcpConfig = adapterType === 'claude-code'
          ? mergeClaudeMcpConfigs(profileMcpConfig, project.mcp_config_path)
          : (project.mcp_config_path || undefined);
        try {
          runService.setSessionSnapshot(runId, {
            sessionModel: opEff.model,
            sessionEffort: opEff.effort,
            sessionPermissionMode: permissionMode || null,
            sessionClaudeOptions: adapterType === 'claude-code'
              ? {
                  tools,
                  disallowedTools,
                  maxBudgetUsd,
                  mcpConfig: effectiveMcpConfig || null,
                  strictMcpConfig,
                  ...(safeMode ? { safeMode: true } : {}),
                  ...(bare ? { bare: true } : {}),
                  ...(disableSlashCommands ? { disableSlashCommands: true } : {}),
                  ...(noChrome ? { noChrome: true } : {}),
                  ...(typeof settingSources === 'string'
                    ? { settingSources }
                    : {}),
                  ...(settings ? { settings } : {}),
                }
              : null,
          });
        } catch { /* annotate-only */ }

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
          env: applyManagerCredentialPolicy(
            isRemoteNode ? {} : spawnEnv,
            { managerToken: token, actorTokens },
          ),
          envAllowlist,
          permissionMode,
          tools: tools.length > 0 ? tools : undefined,
          disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined,
          maxBudgetUsd: maxBudgetUsd || undefined,
          strictMcpConfig: strictMcpConfig || undefined,
          safeMode: safeMode || undefined,
          bare: bare || undefined,
          disableSlashCommands: disableSlashCommands || undefined,
          noChrome: noChrome || undefined,
          settingSources: typeof settingSources === 'string'
            ? settingSources
            : undefined,
          settings: settings || undefined,
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
          mcpConfig: effectiveMcpConfig,
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

  function ensureLiveOperator(args) {
    return ensureLiveOperatorResolved(args);
  }

  return {
    ensureLiveOperator,
    resolveOperatorAdapterType,
    withInstanceTransition,
    isInstanceTransitioning,
  };
}

module.exports = { createOperatorSpawnService };
