const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { BadRequestError } = require('../utils/errors');
const { resolveManagerAuth, buildManagerSpawnEnv } = require('../services/authResolver');
const {
  buildManagerSystemPrompt: buildManagerSystemPromptModule,
  buildTopIdentitySection,
  buildInitialUserContext,
  resolveManagerApiEndpoints,
} = require('../services/managerSystemPrompt');
const { resolveSpawnCwd } = require('../utils/spawnCwd');
const { resolveProjectSource } = require('../services/projectSource');
const { buildFinalOperatorSystemPrompt } = require('../services/operatorPromptSections'); // A2b: shared with operatorSpawnService
const { resolveCodexServiceTier } = require('../services/managerAdapters/codexAdapter'); // F-1
const { goalFeatureActive: defaultGoalFeatureActive } = require('../services/goalMode'); // G2 §6
const { resolveActorTokenPolicy, applyManagerCredentialPolicy } = require('../services/actorTokenPolicy');
const {
  parseClaudeArgsTemplate,
  resolveClaudePermissionMode,
} = require('../services/agentProfileService');
const { resolveAgentVendor } = require('../utils/agentVendor');
const {
  repoFeatureEnabled,
  cwdFromWorkspacePath,
  repoThreadSourceReset,
} = require('../utils/repoOperatorThread');
const {
  isProjectLayer,
  parseProjectConversationId,
  conversationIdForProject,
} = require('../utils/conversationId'); // PM→Operator rename Phase 0: dual-read

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

// #431: boot resume must resolve the SAME profile env_allowlist a fresh spawn
// does, or an allowlisted custom variable silently disappears after a restart.
//
// A malformed provider policy is a hard spawn failure. Falling back to an
// undefined allowlist would re-enable adapter defaults and widen the boundary.
function invalidResumePolicy(message, cause) {
  const policyError = new Error(`invalid provider env policy: ${message}`);
  policyError.code = 'PROVIDER_ENV_POLICY_INVALID';
  if (cause) policyError.cause = cause;
  return policyError;
}

function resolveResumeAgentProfile(
  agentProfileService,
  { profileId, adapterType } = {},
) {
  if (!agentProfileService) {
    if (profileId) {
      throw invalidResumePolicy(`persisted profile ${profileId} cannot be resolved`);
    }
    return null;
  }
  try {
    if (profileId) {
      if (typeof agentProfileService.getProfile !== 'function') {
        throw new Error('profile service cannot resolve a persisted profile id');
      }
      return agentProfileService.getProfile(profileId);
    }
    if (typeof agentProfileService.listProfiles === 'function') {
      return agentProfileService.listProfiles()
        .find((candidate) => candidate.type === adapterType) || null;
    }
    return null;
  } catch (err) {
    if (err?.code === 'PROVIDER_ENV_POLICY_INVALID') throw err;
    throw invalidResumePolicy(
      `profile ${profileId || adapterType || 'unknown'} is missing or unreadable: ${err.message}`,
      err,
    );
  }
}

// #457: a declared environment provider supersedes the raw env_allowlist
// column. The policy carries the same effective key set PLUS provenance and the
// default-auth / blocked-key decisions the resolver needs, so boot resume must
// read it rather than re-parsing the column.
function resolveResumeEnvPolicy(agentProfileService, options = {}) {
  let profile = null;
  try {
    const snapshot = resolveSessionEnvPolicySnapshot(options.sessionClaudeOptionsJson);
    if (snapshot) {
      // The snapshot is the env authority. A still-present pinned profile is
      // inspected only to preserve the fail-closed poisoned-row guard; none of
      // its current keys are used to recompute or widen the saved decision.
      validatePersistedResumeProfile(agentProfileService, options.profileId);
      return snapshot;
    }
    profile = resolveResumeAgentProfile(agentProfileService, options);
    if (!profile) return undefined;
    if (typeof agentProfileService.resolveEnvPolicy === 'function') {
      const policy = agentProfileService.resolveEnvPolicy(profile);
      if (!policy.valid) throw new Error('env policy contains invalid JSON');
      return {
        envAllowlist: policy.effectiveKeys,
        providers: policy.providers,
        allowDefaultAuth: policy.allowDefaultAuth,
        blockedEnvKeys: policy.blockedKeys,
      };
    }
    const parsed = JSON.parse(profile.env_allowlist || '[]');
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return {
      envAllowlist: parsed,
      providers: [],
      allowDefaultAuth: parsed.length === 0,
      blockedEnvKeys: [],
    };
  } catch (err) {
    console.warn(
      `[security] manager_env_allowlist_unreadable ${JSON.stringify({
        profile_id: profile?.id || options.profileId || null,
        adapter: options.adapterType,
        reason: err && err.message,
      })}`
    );
    throw invalidResumePolicy(err && err.message, err);
  }
}

function resolveSessionEnvPolicySnapshot(sessionClaudeOptionsJson) {
  if (sessionClaudeOptionsJson == null) return null;
  let options;
  try {
    options = JSON.parse(sessionClaudeOptionsJson);
  } catch (err) {
    throw invalidResumePolicy(`invalid session options snapshot: ${err.message}`, err);
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw invalidResumePolicy('invalid session options snapshot');
  }
  if (!Object.prototype.hasOwnProperty.call(options, 'envPolicy')) return null;
  const snapshot = options.envPolicy;
  if (
    !snapshot
    || typeof snapshot !== 'object'
    || Array.isArray(snapshot)
    || snapshot.version !== 1
    || (snapshot.effectiveKeys !== null && !Array.isArray(snapshot.effectiveKeys))
    || !Array.isArray(snapshot.providers)
    || typeof snapshot.allowDefaultAuth !== 'boolean'
    || !Array.isArray(snapshot.blockedKeys)
    || (snapshot.effectiveKeys || []).some((key) => typeof key !== 'string')
    || snapshot.blockedKeys.some((key) => typeof key !== 'string')
  ) {
    throw invalidResumePolicy('invalid session env policy snapshot');
  }
  for (const provider of snapshot.providers) {
    if (
      !provider
      || typeof provider !== 'object'
      || Array.isArray(provider)
      || typeof provider.active !== 'boolean'
      || !Array.isArray(provider.envKeys)
      || !Array.isArray(provider.approvedSecretKeys)
      || provider.envKeys.some((key) => typeof key !== 'string')
      || provider.approvedSecretKeys.some((key) => typeof key !== 'string')
    ) {
      throw invalidResumePolicy('invalid provider entry in session env policy snapshot');
    }
  }
  return {
    envAllowlist: snapshot.effectiveKeys === null
      ? undefined
      : [...snapshot.effectiveKeys],
    providers: JSON.parse(JSON.stringify(snapshot.providers)),
    allowDefaultAuth: snapshot.allowDefaultAuth,
    blockedEnvKeys: [...snapshot.blockedKeys],
    fromSnapshot: true,
  };
}

function validatePersistedResumeProfile(agentProfileService, profileId) {
  if (!profileId) return;
  if (!agentProfileService || typeof agentProfileService.getProfile !== 'function') {
    throw invalidResumePolicy(`persisted profile ${profileId} cannot be validated`);
  }
  let profile;
  try {
    profile = agentProfileService.getProfile(profileId);
  } catch (err) {
    // ON DELETE SET NULL normally removes the id. Still accept a raw/imported
    // stale id whose row is gone when an authoritative snapshot exists.
    if (err?.status === 404) return;
    throw invalidResumePolicy(`persisted profile ${profileId} is unreadable: ${err.message}`, err);
  }
  try {
    if (typeof agentProfileService.resolveEnvPolicy === 'function') {
      const policy = agentProfileService.resolveEnvPolicy(profile);
      if (!policy?.valid) throw new Error('env policy contains invalid JSON');
      return;
    }
    const parsed = JSON.parse(profile.env_allowlist || '[]');
    if (!Array.isArray(parsed)) throw new Error('env_allowlist must be an array');
  } catch (err) {
    throw invalidResumePolicy(`persisted profile ${profileId} is poisoned: ${err.message}`, err);
  }
}

// The array form the rest of the resume path (and its regression test) expects.
// Kept for the narrow resume regression tests and legacy callers. Invalid
// policy now throws so no caller can silently regain default auth.
function resolveResumeEnvAllowlist(agentProfileService, options = {}) {
  return resolveResumeEnvPolicy(agentProfileService, options)?.envAllowlist;
}

function resolveResumePermissionMode(agentProfileService, options = {}) {
  if (options.adapterType !== 'claude-code') return undefined;
  if (options.sessionPermissionMode) return options.sessionPermissionMode;
  if (options.hasEnvPolicySnapshot) return 'bypassPermissions';
  const profile = resolveResumeAgentProfile(agentProfileService, options);
  return profile
    ? resolveClaudePermissionMode(profile)
    : 'bypassPermissions';
}

function resolveResumeClaudeTemplateOptions(agentProfileService, options = {}) {
  if (options.adapterType !== 'claude-code') return null;
  if (options.sessionClaudeOptionsJson != null) {
    const parsed = JSON.parse(options.sessionClaudeOptionsJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid Claude session options snapshot');
    }
    if (parsed.legacyUnresumable === true) {
      throw new Error(
        'pre-migration Claude session has no trustworthy runtime options snapshot',
      );
    }
    return {
      tools: Array.isArray(parsed.tools) ? parsed.tools : [],
      disallowedTools: Array.isArray(parsed.disallowedTools)
        ? parsed.disallowedTools
        : [],
      maxBudgetUsd: parsed.maxBudgetUsd ?? null,
      mcpConfig: parsed.mcpConfig ?? null,
      strictMcpConfig: parsed.strictMcpConfig === true,
      safeMode: parsed.safeMode === true,
      bare: parsed.bare === true,
      disableSlashCommands: parsed.disableSlashCommands === true,
      noChrome: parsed.noChrome === true,
      settingSources: typeof parsed.settingSources === 'string'
        ? parsed.settingSources
        : null,
      settings: typeof parsed.settings === 'string'
        ? parsed.settings
        : null,
    };
  }
  const profile = resolveResumeAgentProfile(agentProfileService, options);
  return profile ? parseClaudeArgsTemplate(profile.args_template) : null;
}

function mergeClaudeMcpConfigs(...configs) {
  const present = configs.filter(Boolean);
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : present;
}

// authResolverOpts is forwarded into resolveManagerAuth for every preflight
// so tests can inject `hasKeychain` (and any future DI hooks) without
// monkey-patching child_process. Production callers leave this empty and
// get the real keychain probe.
function createManagerRouter({ runService, streamJsonEngine, managerAdapterFactory, managerRegistry, conversationService, eventBus, projectService, projectBriefService, agentProfileService, operatorProfileService, operatorCleanupService, operatorSpawnService, skillPackService, nodeService, operatorInstanceService, modelPolicyService, isSpecialistAvailable = () => false, authResolverOpts = {}, actorTokens = resolveActorTokenPolicy(), managerCapabilityTokenService = null, managerApiEndpoints = null, goalFeatureActive = defaultGoalFeatureActive }) {
  const router = express.Router();
  const actorSpawnBaseEnv = applyManagerCredentialPolicy(process.env);
  const promptApiEndpoints = managerApiEndpoints || resolveManagerApiEndpoints();
  if (actorTokens.humanToken && !managerCapabilityTokenService) {
    throw new Error('authenticated manager router requires managerCapabilityTokenService');
  }
  const managerTokenFor = (run, layer, conversationId) => {
    if (managerCapabilityTokenService && typeof managerCapabilityTokenService.mint === 'function') {
      return managerCapabilityTokenService.mint(run.id || run, {
        conversationId,
        layer,
      });
    }
    return null;
  };

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
        try { conversationService.clearTurnContext(runId); } catch { /* ignore */ }
      });
    }
  }

  let startingManager = false; // guard against concurrent /start requests

  // On startup: attempt to RESUME stale manager runs from previous server
  // instances. If a run has a persisted session/thread id, we try to
  // reconnect instead of killing it. Only runs that cannot be resumed are
  // marked 'stopped' (the previous behavior).
  //
  // Resume support:
  //   - Claude (top): uses `--resume <claude_session_id>` to reconnect the
  //     CLI conversation. The session_id is persisted in runs.claude_session_id.
  //   - Codex (pm): uses `codex exec resume <thread_id>`. The thread_id is
  //     persisted in project_briefs.pm_thread_id.
  //
  // Resume happens synchronously at module load time (before any HTTP
  // request). Failures are silent — the run is simply marked 'stopped'.
  const _resumeResults = { attempted: 0, resumed: 0, stopped: 0 };
  try {
    const staleManagers = runService.listRuns({ status: 'running' })
      .concat(runService.listRuns({ status: 'queued' }))
      .concat(runService.listRuns({ status: 'needs_input' }))
      .filter(r => r.is_manager);

    // Phase 1: resume Top managers (claude-code with session_id).
    // Phase 2: resume PM managers (codex with thread_id).
    // We process Tops first because PMs need an active Top for
    // parent-notice routing.
    // dual-read (PM→Operator rename Phase 0): a project-operator run is layer 'pm' OR 'operator'.
    const pms = staleManagers.filter(r => isProjectLayer(r.manager_layer));
    const tops = staleManagers.filter(r => !isProjectLayer(r.manager_layer));

    for (const r of tops) {
      _resumeResults.attempted++;
      let resumed = false;
      const adapterType = r.manager_adapter || 'claude-code';

      if (adapterType === 'claude-code' && r.claude_session_id) {
        try {
          const adapter = managerAdapterFactory.getAdapter('claude-code');
          // Rebuild system prompt + env for the resumed session.
          const port = process.env.PORT || 4177;
          const token = managerTokenFor(r, r.manager_layer || 'top', r.conversation_id || 'top');
          const systemPrompt = [
            buildManagerSystemPromptModule({ adapter, port, token: !!token, layer: 'top', adapterType, specialistAvailable: isSpecialistAvailable(), apiBaseUrl: promptApiEndpoints.local }),
            buildTopIdentitySection({ topRunId: r.id }), // MD-2a: resumed Top's own run id
          ].filter(Boolean).join('\n\n');
          const envPolicy = resolveResumeEnvPolicy(agentProfileService, {
            profileId: r.agent_profile_id,
            adapterType,
            sessionClaudeOptionsJson: r.session_claude_options_json,
          });
          const envAllowlist = envPolicy?.envAllowlist;
          const permissionMode = resolveResumePermissionMode(agentProfileService, {
            profileId: r.agent_profile_id,
            adapterType,
            sessionPermissionMode: r.session_permission_mode,
            hasEnvPolicySnapshot: envPolicy?.fromSnapshot === true,
          });
          const templateOptions = resolveResumeClaudeTemplateOptions(agentProfileService, {
            profileId: r.agent_profile_id,
            adapterType,
            sessionClaudeOptionsJson: r.session_claude_options_json,
          });
          const authCtx = resolveManagerAuth(adapterType, {
            envAllowlist,
            providerEnv: envPolicy?.providers,
            allowDefaultAuth: envPolicy?.allowDefaultAuth,
            blockedEnvKeys: envPolicy?.blockedEnvKeys,
            ...authResolverOpts,
            bare: templateOptions?.bare === true,
            settings: templateOptions?.settings,
          });
          const resolvedSpawnEnv = buildManagerSpawnEnv({
            baseEnv: actorSpawnBaseEnv,
            authEnv: authCtx.env,
            envAllowlist,
            vendor: adapterType,
            scrubHumanToken: actorTokens.separated,
            diagnosticContext: 'manager:resume:top',
            providerEnv: envPolicy?.providers,
          });
          if (authCtx.canAuth) {
            const spawnEnv = applyManagerCredentialPolicy(
              resolvedSpawnEnv,
              { managerToken: token, actorTokens },
            );
            const safeCwd = resolveSpawnCwd({});
            adapter.startSession(r.id, {
              cwd: safeCwd,
              systemPrompt,
              env: spawnEnv,
              envAllowlist,
              permissionMode,
              tools: templateOptions?.tools.length > 0
                ? templateOptions.tools
                : undefined,
              disallowedTools: templateOptions?.disallowedTools.length > 0
                ? templateOptions.disallowedTools
                : undefined,
              maxBudgetUsd: templateOptions?.maxBudgetUsd || undefined,
              mcpConfig: templateOptions?.mcpConfig || undefined,
              strictMcpConfig: templateOptions?.strictMcpConfig || undefined,
              safeMode: templateOptions?.safeMode || undefined,
              bare: templateOptions?.bare || undefined,
              disableSlashCommands: templateOptions?.disableSlashCommands || undefined,
              noChrome: templateOptions?.noChrome || undefined,
              settingSources: typeof templateOptions?.settingSources === 'string'
                ? templateOptions.settingSources
                : undefined,
              settings: templateOptions?.settings || undefined,
              resumeSessionId: r.claude_session_id,
              model: r.session_model || undefined,
              reasoning_effort: r.session_effort || undefined,
            });
            managerRegistry.setActive('top', r.id, adapter);
            // Ensure run status is 'running'.
            try { runService.updateRunStatus(r.id, 'running', { force: true }); } catch { /* ignore */ }
            resumed = true;
            console.log(`[boot] Resumed top manager run=${r.id} session=${r.claude_session_id}`);
          }
        } catch (err) {
          if (err?.code === 'PROVIDER_ENV_POLICY_INVALID') {
            try {
              runService.addRunEvent(r.id, 'manager:resume_env_policy_invalid', JSON.stringify({
                adapter: adapterType,
                reason: err.message,
              }));
            } catch { /* best-effort boot diagnostic */ }
          }
          console.warn(`[boot] Failed to resume top manager run=${r.id}: ${err.message}`);
        }
      }

      if (!resumed) {
        try {
          const adapter = managerAdapterFactory.getAdapter(adapterType);
          Promise.resolve(adapter.disposeSession(r.id)).catch(() => { /* boot fallback */ });
        } catch { /* ignore */ }
        runService.updateRunStatus(r.id, 'stopped', { force: true });
        try { conversationService.clearParentNotices(r.id); } catch { /* ignore */ }
        _resumeResults.stopped++;
      } else {
        _resumeResults.resumed++;
      }
    }

    for (const r of pms) {
      _resumeResults.attempted++;
      let resumed = false;
      const adapterType = r.manager_adapter || 'codex';

      // Extract projectId from conversation_id. Canonical operator runs store
      // conversation_id = 'operator:oi_*' (operatorSpawnService slotKey), which
      // parseProjectConversationId() intentionally returns null for — so
      // resolve via the single operator resolver FIRST (handles both
      // 'operator:oi_*' and legacy 'operator:<projectId>'), then fall back to
      // parseProjectConversationId when the resolver is unavailable (e.g. unit
      // harnesses) — it covers the legacy 'operator:<projectId>' form. (Very old
      // 'pm:<id>' ids are rewritten to 'operator:' by migration 045/046, which
      // runs before this router boots, so no residual 'pm:' reaches here — both
      // resolver and parser return null for it, which is fine.) Without the
      // resolver-first order, post-W-P5 canonical operators never enter the
      // resume branch below (projectId=null) and get marked stopped on boot.
      // Check the DURABLE attribution first. `r.conversation_id` may be a legacy
      // 'operator:<projectId>' alias, which resolves to whatever instance is
      // primary NOW — after an archive that is the REPLACEMENT instance, so the
      // check below would pass and this old run would be resumed onto a new
      // thread/profile and registered in the new slot. `r.operator_instance_id`
      // is the instance that actually owned this run.
      let archivedOwner = false;
      if (
        r.operator_instance_id
        && operatorInstanceService
        && typeof operatorInstanceService.getInstance === 'function'
      ) {
        let owner = null;
        try { owner = operatorInstanceService.getInstance(r.operator_instance_id); } catch { owner = null; }
        if (owner?.archived_at) {
          console.warn(`[boot] Skipping run of archived Operator run=${r.id} instance=${r.operator_instance_id}`);
          archivedOwner = true;
        }
      }
      let bootResolved = null;
      if (!archivedOwner && runService && typeof runService.resolveOperatorConversationId === 'function') {
        try { bootResolved = runService.resolveOperatorConversationId(r.conversation_id); }
        catch { bootResolved = null; }
      }
      if (
        bootResolved?.instanceId
        && operatorInstanceService
        && typeof operatorInstanceService.assertActiveInstance === 'function'
      ) {
        try {
          operatorInstanceService.assertActiveInstance(bootResolved.instanceId);
        } catch (err) {
          console.warn(`[boot] Skipping archived/missing Operator run=${r.id}: ${err.message}`);
          bootResolved = null;
        }
      }
      let projectId = bootResolved
        ? (bootResolved.primaryProjectId || bootResolved.legacyProjectId || null)
        : null;
      if (!projectId && !archivedOwner) {
        const parsedConv = parseProjectConversationId(r.conversation_id);
        projectId = parsedConv ? parsedConv.projectId : null;
      }

      if (projectId && (adapterType === 'codex' || adapterType === 'claude-code') && projectBriefService) {
        try {
          const brief = projectBriefService.getBrief(projectId);
          let operatorInstanceId = null;
          let instanceThread = null;
          try {
            // Reuse the instance already resolved from r.conversation_id — for a
            // canonical 'operator:oi_*' run this is the exact owning instance
            // (more precise than re-deriving the project's primary). Fall back
            // to a fresh resolve from the legacy conversation id otherwise.
            if (bootResolved && bootResolved.instanceId) {
              operatorInstanceId = bootResolved.instanceId;
            } else if (runService && typeof runService.resolveOperatorConversationId === 'function') {
              const resolved = runService.resolveOperatorConversationId(conversationIdForProject(projectId));
              operatorInstanceId = resolved && resolved.instanceId ? resolved.instanceId : null;
            }
            if (operatorInstanceId && typeof runService.getOperatorInstance === 'function') {
              instanceThread = runService.getOperatorInstance(operatorInstanceId);
            }
          } catch (err) {
            console.warn(`[boot] Failed to read operator instance thread project=${projectId}: ${err.message}`);
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
          const clearPersistedThreadState = () => {
            if (threadStateSource !== 'instance' || !operatorInstanceId) return;
            if (runService && typeof runService.setOperatorInstanceThread === 'function') {
              runService.setOperatorInstanceThread(operatorInstanceId, {});
            }
          };
          if (threadState && threadState.pm_thread_id) {
            const adapter = managerAdapterFactory.getAdapter(adapterType);
            // We need the active Top for parent-notice routing.
            const activeTopRunId = managerRegistry.getActiveRunId('top');
            if (activeTopRunId) {
              let project;
              try { project = projectService.getProject(projectId); } catch { /* ignore */ }
              if (project) {
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
                    try { runService.addRunEvent(r.id, 'operator:resume_skipped_cordoned', JSON.stringify({ node_id: nodeId })); } catch { /* ignore */ }
                    throw new Error('PM node is cordoned');
                  }
                }
                const briefAdapter = threadState.pm_adapter || null;
                const expectedBriefAdapter = adapterType === 'codex' ? 'codex' : 'claude';
                const threadNode = threadState.pm_thread_node_id ? threadState.pm_thread_node_id : null;
                let resumeHandle = threadState.pm_thread_id;
                if (resumeHandle && (threadNode || 'local') !== (nodeId || 'local')) {
                  try {
                    clearPersistedThreadState();
                  } catch (err) {
                    console.warn(`[boot] Failed to clear stale PM thread project=${projectId}: ${err.message}`);
                  }
                  try {
                    runService.addRunEvent(r.id, 'operator:thread_rebind_reset', JSON.stringify({ from_node: threadNode, to_node: nodeId || 'local' }));
                  } catch { /* ignore */ }
                  resumeHandle = null;
                }
                if (resumeHandle && isRepoProject) {
                  const threadSourceReset = repoThreadSourceReset(threadState, project);
                  if (threadSourceReset) {
                    try {
                      clearPersistedThreadState();
                    } catch (err) {
                      console.warn(`[boot] Failed to clear source-mismatched PM thread project=${projectId}: ${err.message}`);
                    }
                    try {
                      runService.addRunEvent(r.id, 'operator:thread_source_reset', JSON.stringify(threadSourceReset));
                    } catch { /* ignore */ }
                    resumeHandle = null;
                  }
                }
                if (resumeHandle && briefAdapter !== expectedBriefAdapter) {
                  try {
                    clearPersistedThreadState();
                  } catch (err) {
                    console.warn(`[boot] Failed to clear adapter-mismatched PM thread project=${projectId}: ${err.message}`);
                  }
                  resumeHandle = null;
                }
                if (!resumeHandle) {
                  throw new Error('PM session handle is not resumable for this project node/adapter');
                }
                if (isRepoProject && !repoFeatureEnabled()) {
                  try {
                    runService.addRunEvent(r.id, 'operator:materialize_failed', JSON.stringify({ project_id: projectId, reason: 'feature_disabled' }));
                  } catch { /* ignore */ }
                  throw new Error('repo Operator resume requires the repo feature enabled (PALANTIR_PROJECT_REPO must not be 0)');
                }
                if (isRepoProject && isRemoteNode) {
                  try {
                    runService.addRunEvent(r.id, 'operator:repo_remote_unsupported', JSON.stringify({ project_id: projectId, node_id: nodeId || 'local' }));
                  } catch { /* ignore */ }
                  throw new Error('repo materialization is unsupported on remote nodes');
                }
                if (isRemoteNode && !promptApiEndpoints.remote) {
                  try {
                    runService.addRunEvent(r.id, 'operator:remote_base_url_unavailable', JSON.stringify({
                      node_id: nodeId,
                      project_id: projectId,
                    }));
                  } catch { /* ignore */ }
                  throw new Error(
                    'remote Operator requires a Console URL reachable from its node; set PALANTIR_BASE_URL or bind the Console to a non-loopback host',
                  );
                }
                let executor;
                let nodePrefix;
                if (isRemoteNode) {
                  const node = nodeService.getNode(nodeId);
                  executor = nodeService.pickExecutor(nodeId);
                  if (!executor) throw new Error(`No executor available for node ${nodeId}`);
                  nodePrefix = node && node.node_prefix ? node.node_prefix : undefined;
                }
                const port = process.env.PORT || 4177;
                // A separated actor token applies to all resumed managers, not
                // only goal mode.
                const goalActive = goalFeatureActive();
                const token = managerTokenFor(r, r.manager_layer || 'operator', r.conversation_id);
                const baseSystemPrompt = buildManagerSystemPromptModule({
                  adapter,
                  port,
                  token: !!token,
                  layer: 'operator',
                  adapterType,
                  specialistAvailable: isSpecialistAvailable(),
                  apiBaseUrl: isRemoteNode ? promptApiEndpoints.remote : promptApiEndpoints.local,
                });
                // A2b: shared builder — the resumed Operator's project-scoped
                // sections are assembled by the SAME function as fresh spawn
                // (server/services/operatorPromptSections), so the two paths can
                // never drift (Codex R2 BLOCKER 3).
                const systemPrompt = buildFinalOperatorSystemPrompt({
                  baseSystemPrompt,
                  project,
                  profile: operatorProfileService && instanceThread?.profile_id
                    ? operatorProfileService.getProfile(instanceThread.profile_id)
                    : null,
                  brief,
                  operatorRunId: r.id,
                  skillPackService,
                  logger: (err) => console.warn(`[boot] Failed to load skill packs for PM resume project=${projectId}: ${err.message}`),
                });
                // Adapter-generic: the boot-resume loop now admits claude-code
                // (P5-S4c) — resolve auth for the run's ACTUAL adapter, not a
                // hardcoded 'codex' (a local Claude Operator would otherwise be
                // stopped/misauthed via Codex auth). (Codex P5-S4c BLOCKER.)
                // Runs created before #457 have no pinned profile id. Preserve
                // their pre-existing adapter fallback so upgrades do not stop
                // every live Operator, but make that mutable legacy state
                // observable. New runs persist the complete env decision; a
                // deleted profile is then safe, while an existing poisoned row
                // remains a hard failure.
                const envPolicy = resolveResumeEnvPolicy(agentProfileService, {
                  profileId: r.agent_profile_id,
                  adapterType,
                  sessionClaudeOptionsJson: r.session_claude_options_json,
                });
                if (!r.agent_profile_id && !envPolicy?.fromSnapshot) {
                  try {
                    runService.addRunEvent(
                      r.id,
                      'operator:resume_profile_unpinned',
                      JSON.stringify({
                        operator_instance_id: operatorInstanceId || r.operator_instance_id || null,
                        adapter: adapterType,
                      }),
                    );
                  } catch { /* best-effort legacy-state diagnostic */ }
                }
                if (
                  isRemoteNode
                  && envPolicy?.providers?.some((provider) => provider.gateEnvKey)
                ) {
                  const err = new Error(
                    'remote provider gate rejected: gates are controller-scoped and cannot authorize node-sourced credentials',
                  );
                  err.code = 'REMOTE_PROVIDER_GATE_UNSUPPORTED';
                  throw err;
                }
                const envAllowlist = envPolicy?.envAllowlist;
                const permissionMode = resolveResumePermissionMode(agentProfileService, {
                  profileId: r.agent_profile_id,
                  adapterType,
                  sessionPermissionMode: r.session_permission_mode,
                  hasEnvPolicySnapshot: envPolicy?.fromSnapshot === true,
                });
                const templateOptions = resolveResumeClaudeTemplateOptions(
                  agentProfileService,
                  {
                    profileId: r.agent_profile_id,
                    adapterType,
                    sessionClaudeOptionsJson: r.session_claude_options_json,
                  },
                );
                const authCtx = resolveManagerAuth(adapterType, {
                  envAllowlist,
                  providerEnv: envPolicy?.providers,
                  allowDefaultAuth: envPolicy?.allowDefaultAuth,
                  blockedEnvKeys: envPolicy?.blockedEnvKeys,
                  ...authResolverOpts,
                  // Remote Claude resumes materialize `--bare` auth on the pod,
                  // not from the controller's credential stores.
                  bare: !isRemoteNode && templateOptions?.bare === true,
                  settings: templateOptions?.settings,
                });
                const resolvedSpawnEnv = isRemoteNode ? {} : buildManagerSpawnEnv({
                  baseEnv: actorSpawnBaseEnv,
                  authEnv: authCtx.env,
                  envAllowlist,
                  vendor: adapterType,
                  scrubHumanToken: actorTokens.separated || goalActive,
                  diagnosticContext: 'manager:resume:operator',
                  providerEnv: envPolicy?.providers,
                });
                // A REMOTE Operator authenticates on the pod (~/.codex), not the
                // control plane — resume it even when control-plane Codex auth is
                // absent (else a restart would stop a healthy pod Operator).
                // Local still requires canAuth. (Codex S3b review.)
                if (isRemoteNode || authCtx.canAuth) {
                  const spawnEnv = applyManagerCredentialPolicy(
                    resolvedSpawnEnv,
                    { managerToken: token, actorTokens },
                  );
                  const cwd = isRepoProject
                    ? (threadState.pm_thread_cwd || cwdFromWorkspacePath(threadState.pm_thread_workspace_path, project))
                    : (isRemoteNode ? (project.directory || null) : resolveSpawnCwd({ workspaceDir: project.directory }));
                  if (isRepoProject && !cwd) {
                    throw new Error('repo Operator resume has no materialized cwd');
                  }
                  const startOpts = {
                    systemPrompt,
                    cwd,
                    model: r.session_model || undefined,
                    reasoning_effort: r.session_effort || undefined,
                    // Remote Operator resume must NOT get the control-plane env
                    // (process.env-based) — it overrides the pod pathPrefix and
                    // leaks creds; the pod provides its own env + ~/.codex.
                    // (Mirror of the operatorSpawnService fix; real-Pi finding.)
                    // Remote managers receive only the run capability from the
                    // control plane; vendor auth/PATH remain pod-owned.
                    env: isRemoteNode
                      ? applyManagerCredentialPolicy({}, { managerToken: token, actorTokens })
                      : spawnEnv,
                    envAllowlist,
                    permissionMode,
                    tools: templateOptions?.tools.length > 0
                      ? templateOptions.tools
                      : undefined,
                    disallowedTools: templateOptions?.disallowedTools.length > 0
                      ? templateOptions.disallowedTools
                      : undefined,
                    maxBudgetUsd: templateOptions?.maxBudgetUsd || undefined,
                    mcpConfig: adapterType === 'claude-code'
                      && r.session_claude_options_json != null
                      ? (templateOptions?.mcpConfig || undefined)
                      : mergeClaudeMcpConfigs(
                        templateOptions?.mcpConfig,
                        project.mcp_config_path,
                      ),
                    strictMcpConfig: templateOptions?.strictMcpConfig || undefined,
                    safeMode: templateOptions?.safeMode || undefined,
                    bare: templateOptions?.bare || undefined,
                    disableSlashCommands: templateOptions?.disableSlashCommands || undefined,
                    noChrome: templateOptions?.noChrome || undefined,
                    settingSources: typeof templateOptions?.settingSources === 'string'
                      ? templateOptions.settingSources
                      : undefined,
                    settings: templateOptions?.settings || undefined,
                    role: 'manager',
                    nodeId,
                    // F-1: per-turn tier resolver — re-reads this instance's
                    // fast_mode each turn so a live toggle takes effect without a
                    // re-spawn. Bridge resume (no instance row) → env default.
                    // Ignored by the Claude adapter.
                    serviceTier: operatorInstanceId
                      ? () => (modelPolicyService
                        ? modelPolicyService.resolveServiceTier({
                          layer: 'operator',
                          projectId,
                          instanceFastMode: runService.getOperatorInstance(operatorInstanceId)?.fast_mode,
                          env: process.env,
                        })
                        : resolveCodexServiceTier(runService.getOperatorInstance(operatorInstanceId)?.fast_mode))
                      : (modelPolicyService
                        ? modelPolicyService.resolveServiceTier({
                          layer: 'operator',
                          projectId,
                          env: process.env,
                        })
                        : resolveCodexServiceTier(null)),
                  };
                  if (adapterType === 'codex') {
                    startOpts.resumeThreadId = resumeHandle;
                  } else {
                    startOpts.resumeSessionId = resumeHandle;
                  }
                  if (isRemoteNode) {
                    startOpts.executor = executor;
                    startOpts.nodePrefix = nodePrefix;
                  }
                  adapter.startSession(r.id, startOpts);
                  managerRegistry.setActive(r.conversation_id, r.id, adapter);
                  try { runService.updateRunStatus(r.id, 'running', { force: true }); } catch { /* ignore */ }
                  resumed = true;
                  console.log(`[boot] Resumed PM run=${r.id} project=${projectId} ${adapterType === 'codex' ? 'thread' : 'session'}=${resumeHandle}`);
                }
              }
            }
          }
        } catch (err) {
          if (
            err?.code === 'PROVIDER_ENV_POLICY_INVALID'
            || err?.code === 'REMOTE_PROVIDER_GATE_UNSUPPORTED'
          ) {
            try {
              runService.addRunEvent(r.id, 'manager:resume_env_policy_invalid', JSON.stringify({
                adapter: adapterType,
                reason: err.message,
                remote: err.code === 'REMOTE_PROVIDER_GATE_UNSUPPORTED',
              }));
            } catch { /* best-effort boot diagnostic */ }
          }
          console.warn(`[boot] Failed to resume PM run=${r.id}: ${err.message}`);
          try {
            runService.addRunEvent(r.id, 'error', JSON.stringify({
              code: err.code || 'OPERATOR_RESUME_FAILED',
              message: err.message,
            }));
          } catch { /* ignore */ }
        }
      }

      if (!resumed) {
        try {
          const adapter = managerAdapterFactory.getAdapter(adapterType);
          Promise.resolve(adapter.disposeSession(r.id)).catch(() => { /* boot fallback */ });
        } catch { /* ignore */ }
        runService.updateRunStatus(r.id, 'stopped', { force: true });
        try { conversationService.clearParentNotices(r.id); } catch { /* ignore */ }
        _resumeResults.stopped++;
      } else {
        _resumeResults.resumed++;
      }
    }

    if (_resumeResults.attempted > 0) {
      console.log(`[boot] Session resume: ${_resumeResults.resumed} resumed, ${_resumeResults.stopped} stopped (of ${_resumeResults.attempted} stale)`);
    }
  } catch (err) {
    console.warn(`[boot] Session resume failed: ${err.message}`);
  }

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
    try {
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
        const commandVendor = resolveAgentVendor(resolvedProfile.command);
        const expectedVendor = mapped === 'claude-code' ? 'claude' : 'codex';
        if (commandVendor !== expectedVendor) {
          startingManager = false;
          return res.status(400).json({
            error: 'manager_profile_vendor_mismatch',
            profileId: resolvedProfile.id,
            profileType: resolvedProfile.type,
            command: resolvedProfile.command,
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
    const claudeTemplateOptions = adapterType === 'claude-code' && resolvedProfile
      ? parseClaudeArgsTemplate(resolvedProfile.args_template)
      : null;
    const permissionMode = adapterType === 'claude-code'
      ? (resolvedProfile
        ? resolveClaudePermissionMode(resolvedProfile)
        : 'bypassPermissions')
      : undefined;

    // Validate cwd if provided — must be under home directory or current working dir
    let safeCwd = resolveSpawnCwd({ workspaceDir: cwd });
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
    let envPolicy;
    if (resolvedProfile) {
      try {
        if (
          agentProfileService
          && typeof agentProfileService.resolveEnvPolicy === 'function'
        ) {
          const policy = agentProfileService.resolveEnvPolicy(resolvedProfile);
          if (!policy.valid) {
            throw new Error('env policy contains invalid JSON');
          }
          envPolicy = policy;
          envAllowlist = policy.effectiveKeys;
        } else {
          const parsed = JSON.parse(resolvedProfile.env_allowlist || '[]');
          if (!Array.isArray(parsed)) {
            throw new Error('env_allowlist must be a JSON array');
          }
          envAllowlist = parsed;
          envPolicy = {
            providers: [],
            allowDefaultAuth: parsed.length === 0,
            blockedKeys: [],
          };
        }
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
    const providerEnv = envPolicy?.providers || [];
    const authCtx = resolveManagerAuth(adapterType, {
      envAllowlist,
      providerEnv,
      allowDefaultAuth: envPolicy?.allowDefaultAuth,
      blockedEnvKeys: envPolicy?.blockedKeys,
      ...authResolverOpts,
      bare: claudeTemplateOptions?.bare === true,
      settings: claudeTemplateOptions?.settings,
    });
    const resolvedSpawnEnv = buildManagerSpawnEnv({
      baseEnv: actorSpawnBaseEnv,
      authEnv: authCtx.env,
      envAllowlist,
      vendor: adapterType,
      scrubHumanToken: actorTokens.separated,
      diagnosticContext: 'manager:fresh:top',
      providerEnv,
    });
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
    const token = managerTokenFor(runId, 'top', 'top');
    const systemPrompt = [
      buildManagerSystemPromptModule({ adapter, port, token: !!token, layer: 'top', adapterType, specialistAvailable: isSpecialistAvailable(), apiBaseUrl: promptApiEndpoints.local }),
      buildTopIdentitySection({ topRunId: runId }), // MD-2a: Top's own run id (cache-safe, appended after base)
    ].filter(Boolean).join('\n\n');
    const initialUserContext = buildInitialUserContext({
      runSummary,
      projectList,
      projectBriefsSection,
      agentList,
      userPrompt: prompt || 'You are now active as the Palantir Manager. Await instructions.',
    });

    // Propagate the allowlisted env to the subprocess. The builder admits only
    // the common/vendor baseline plus profile additions, then layers resolved
    // auth on top.
    const spawnEnv = applyManagerCredentialPolicy(
      resolvedSpawnEnv,
      { managerToken: token, actorTokens },
    );

    // P3-4: extract MCP tool patterns from the agent profile's capabilities_json
    // so Manager (Top layer) can access MCP tools. The claudeAdapter.startSession
    // merges these into the base allowedTools list.
    const mcpTools = parseMcpTools(resolvedProfile && resolvedProfile.capabilities_json);

    try {
      const vendor = adapterType === 'codex' ? 'codex' : 'claude';
      const eff = modelPolicyService
        ? modelPolicyService.resolveEffective({ layer: 'top', vendor, requestModel: model, env: process.env })
        : { model: model || null, effort: null };
      try {
        runService.setSessionSnapshot(runId, {
          sessionModel: eff.model,
          sessionEffort: eff.effort,
          sessionPermissionMode: permissionMode || null,
          sessionEnvPolicy: {
            effectiveKeys: Array.isArray(envAllowlist) ? envAllowlist : null,
            providers: providerEnv,
            allowDefaultAuth: envPolicy?.allowDefaultAuth === true,
            blockedKeys: envPolicy?.blockedKeys || [],
          },
          sessionClaudeOptions: claudeTemplateOptions
            ? {
                tools: claudeTemplateOptions.tools,
                disallowedTools: claudeTemplateOptions.disallowedTools,
                maxBudgetUsd: claudeTemplateOptions.maxBudgetUsd,
                mcpConfig: claudeTemplateOptions.mcpConfig,
                strictMcpConfig: claudeTemplateOptions.strictMcpConfig,
                ...(claudeTemplateOptions.safeMode
                  ? { safeMode: true }
                  : {}),
                ...(claudeTemplateOptions.bare
                  ? { bare: true }
                  : {}),
                ...(claudeTemplateOptions.disableSlashCommands
                  ? { disableSlashCommands: true }
                  : {}),
                ...(claudeTemplateOptions.noChrome
                  ? { noChrome: true }
                  : {}),
                ...(typeof claudeTemplateOptions.settingSources === 'string'
                  ? { settingSources: claudeTemplateOptions.settingSources }
                  : {}),
                ...(claudeTemplateOptions.settings
                  ? { settings: claudeTemplateOptions.settings }
                  : {}),
              }
            : null,
        });
      } catch { /* annotate-only */ }

      const { sessionRef } = adapter.startSession(runId, {
        // For Claude (persistent process) the prompt argument is the FIRST
        // user message piped via stdin during spawn. For Codex (stateless)
        // it is ignored — we'll send the same content as the first runTurn
        // immediately below.
        prompt: initialUserContext,
        cwd: safeCwd,
        systemPrompt,
        model: eff.model || undefined,
        reasoning_effort: eff.effort || undefined,
        // Match lifecycleService's Claude worker rule exactly: a NULL profile
        // value preserves the historical bypassPermissions default.
        permissionMode,
        tools: claudeTemplateOptions?.tools.length > 0
          ? claudeTemplateOptions.tools
          : undefined,
        disallowedTools: claudeTemplateOptions?.disallowedTools.length > 0
          ? claudeTemplateOptions.disallowedTools
          : undefined,
        maxBudgetUsd: claudeTemplateOptions?.maxBudgetUsd || undefined,
        mcpConfig: claudeTemplateOptions?.mcpConfig || undefined,
        strictMcpConfig: claudeTemplateOptions?.strictMcpConfig || undefined,
        safeMode: claudeTemplateOptions?.safeMode || undefined,
        bare: claudeTemplateOptions?.bare || undefined,
        disableSlashCommands: claudeTemplateOptions?.disableSlashCommands || undefined,
        noChrome: claudeTemplateOptions?.noChrome || undefined,
        settingSources: typeof claudeTemplateOptions?.settingSources === 'string'
          ? claudeTemplateOptions.settingSources
          : undefined,
        settings: claudeTemplateOptions?.settings || undefined,
        env: spawnEnv,
        envAllowlist,
        mcpTools: mcpTools.length > 0 ? mcpTools : undefined,
        // v3 Phase 0: all current manager starts are Top layer. PM layer
        // (Phase 3a) will pass role='manager' with layer='pm' system prompt.
        // role='manager' is the default in codexAdapter so this is belt-and-suspenders.
        role: 'manager',
        // F-1: Top has no operator instance, so its codex tier follows the
        // PALANTIR_CODEX_FAST env only (static string, resolved once). Ignored
        // by the Claude adapter.
        serviceTier: modelPolicyService
          ? modelPolicyService.resolveServiceTier({ layer: 'top', env: process.env })
          : resolveCodexServiceTier(null),
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
        // P4-S3a: codexAdapter.runTurn is SYNC-returning again (the remote spawn
        // is fire-and-forget inside the adapter), so the original sync try/catch
        // is correct; the boot first-turn stays non-blocking.
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
    }
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
    const { text, images, idempotencyKey: bodyKey } = req.body || {};
    const idempotencyKey = bodyKey || req.get('Idempotency-Key') || undefined;
    try {
      const result = await conversationService.sendMessage('top', {
        text,
        images,
        idempotencyKey,
      });
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
   * POST /api/manager/pm/:projectId/warm
   * Pre-warm a PM session so the first message doesn't pay the lazy
   * spawn cost. Called by the client when the user switches the
   * conversation target to an Operator (dropdown select). Returns the Operator run
   * if spawned, or the already-live run if one exists.
   */
  router.post('/pm/:projectId/warm', asyncHandler(async (req, res) => {
    const { projectId } = req.params;
    if (!projectId) throw new BadRequestError('projectId is required');
    if (!operatorSpawnService) {
      return res.status(501).json({ error: 'PM spawn service not available' });
    }
    try {
      const result = await operatorSpawnService.ensureLiveOperator({ projectId });
      return res.json({ run: result.run, spawned: result.spawned, resumed: result.resumed });
    } catch (err) {
      if (err && err.httpStatus) {
        return res.status(err.httpStatus).json({ error: err.message });
      }
      throw err;
    }
  }));

  /**
   * POST /api/manager/pm/:projectId/message
   * v3 Phase 2: send a message to a project-scoped Operator manager.
   *
   * Thin alias over conversationService.sendMessage('operator:<projectId>', ...).
   * Phase 2 wires the runtime slot + parent-notice router; lazy Operator spawn
   * on first message is a Phase 3a concern. Until then, callers that hit
   * this route when no Operator is active will get 404 — this is intentional.
   */
  router.post('/pm/:projectId/message', asyncHandler(async (req, res) => {
    console.warn('[deprecation] POST /api/manager/pm/:projectId/message — use POST /api/conversations/pm:<projectId>/message instead');
    const { projectId } = req.params;
    if (!projectId) {
      throw new BadRequestError('projectId is required');
    }
    const { text, images, idempotencyKey: bodyKey } = req.body || {};
    const idempotencyKey = bodyKey || req.get('Idempotency-Key') || undefined;
    try {
      // A2a §5.0 mapping: this legacy per-project route is definitively a
      // codebase(projectId) turn — pass it explicitly so it stays correct even
      // if the resolved Operator's primary ever differs from the route param.
      const result = await conversationService.sendMessage(conversationIdForProject(projectId), {
        text,
        images,
        codebaseProjectId: projectId,
        turnMode: 'codebase',
        idempotencyKey,
      });
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
   * v3 Phase 3a: single-owner Operator teardown (spec §5 책임 분담표). The
   * user clicks "Reset Operator" (or the client forces a reset during adapter
   * switch) and this route delegates to operatorCleanupService.reset, which
   * disposes the live adapter session, clears pm_thread_id/pm_adapter on
   * the project brief, and drops the managerRegistry slot. The NEXT
   * message to this project's Operator will lazy-spawn a fresh Codex thread.
   */
  router.post('/pm/:projectId/reset', asyncHandler(async (req, res) => {
    const { projectId } = req.params;
    if (!projectId) {
      throw new BadRequestError('projectId is required');
    }
    if (!operatorCleanupService) {
      return res.status(501).json({ error: 'operatorCleanupService not wired' });
    }
    try {
      const result = await operatorCleanupService.reset(projectId);
      return res.json({ status: 'reset', projectId, ...result });
    } catch (err) {
      if (err && err.httpStatus) {
        return res.status(err.httpStatus).json({ error: err.message });
      }
      throw err;
    }
  }));

  /**
   * POST /api/manager/pm/:projectId/force-reset
   * v3 Phase 7 (P7-2): force-delete escape hatch for when the normal
   * fail-closed reset is stuck because disposeSession throws. Unlike the
   * normal /reset route this call swallows disposeSession failures and
   * unconditionally clears the registry slot + brief so the Operator slot is
   * always freed. Intended as a last-resort operator action — prefer
   * /reset first whenever the adapter might be healthy.
   *
   * Emits 'operator:force_reset' on eventBus for audit visibility.
   */
  router.post('/pm/:projectId/force-reset', asyncHandler(async (req, res) => {
    const { projectId } = req.params;
    if (!projectId) {
      throw new BadRequestError('projectId is required');
    }
    if (!operatorCleanupService) {
      return res.status(501).json({ error: 'operatorCleanupService not wired' });
    }
    if (typeof operatorCleanupService.forceReset !== 'function') {
      return res.status(501).json({ error: 'forceReset not available on operatorCleanupService' });
    }
    const result = await operatorCleanupService.forceReset(projectId);
    return res.json({ status: 'force_reset', projectId, ...result });
  }));

  /**
   * GET /api/manager/summary
   * R2-C.1: Aggregate worker run stats for SuggestedActions/dashboard widgets.
   *
   * Pure DB aggregation (no LLM). Only counts worker runs (is_manager=0) so
   * Top/Operator manager rows never inflate the numbers — ManagerChat already
   * renders Top/Operator status in a dedicated header.
   *
   * "today" uses the server's local timezone (SQLite `date('now','localtime')`)
   * rather than UTC so users on non-UTC hosts see a day boundary that matches
   * their wall clock. This differs from runs.created_at which is UTC via
   * `datetime('now')`, so we normalize via `datetime(created_at,'localtime')`
   * on the compare side as well.
   *
   * Response shape:
   *   {
   *     active:            <running + needs_input count>,
   *     needs_input:       <needs_input count>,
   *     failed:            <failed count>,
   *     completed_today:   <completed runs whose created_at is today (local)>,
   *     total_cost_today:  <SUM(cost_usd) of today's runs; 0 when all NULL>
   *   }
   */
  router.get('/summary', asyncHandler(async (req, res) => {
    // Access runService's private db via a private helper is clunky; the
    // router already has runService, which exposes listRuns. We keep the
    // aggregation in pure JS on top of listRuns so tests can stub the
    // service without faking SQL. listRuns() is already indexed on status
    // + created_at DESC and bounded by worker-run volume; for the ~few
    // hundred runs a typical install has this is O(n) and cheap.
    const allRuns = runService.listRuns({}) || [];
    const workerRuns = allRuns.filter(r => !r.is_manager);

    // Local-timezone "today at 00:00:00" in ISO-ish form — SQLite stores
    // datetime('now') as UTC strings like "2026-04-22 14:05:00" so we
    // compare against JS Date's local interpretation of that string.
    // Using Date math here (not SQLite) keeps the aggregation entirely
    // in-process and avoids one extra query round-trip.
    const now = new Date();
    const localStartOfDay = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      0, 0, 0, 0
    );

    let active = 0;
    let needsInput = 0;
    let failed = 0;
    let completedToday = 0;
    let totalCostToday = 0;

    for (const run of workerRuns) {
      if (run.status === 'running' || run.status === 'needs_input') active++;
      if (run.status === 'needs_input') needsInput++;
      if (run.status === 'failed') failed++;

      // created_at is a SQLite datetime string ("YYYY-MM-DD HH:MM:SS", UTC).
      // JS Date() without a timezone suffix treats it as local time — which
      // happens to be what we want here because `localStartOfDay` is also
      // local. If a caller sets TZ=UTC, both sides shift together.
      const createdAtStr = run.created_at;
      if (!createdAtStr) continue;
      // SQLite emits "YYYY-MM-DD HH:MM:SS" (UTC). Append 'Z' so Date() parses
      // it as UTC; then the comparison below is timezone-correct regardless
      // of server TZ. Without 'Z', Node parses the bare form as local time,
      // which double-shifts (UTC row interpreted as local + compared to
      // local midnight).
      const createdAtUtc = new Date(createdAtStr.replace(' ', 'T') + 'Z');
      if (isNaN(createdAtUtc.getTime())) continue;
      if (createdAtUtc >= localStartOfDay) {
        if (run.status === 'completed') completedToday++;
        // Include cost for ALL of today's runs regardless of status —
        // running/failed/needs_input still accumulate billable tokens.
        // null/undefined cost_usd is treated as 0 (NULL-safe sum).
        const cost = Number(run.cost_usd);
        if (!Number.isNaN(cost) && Number.isFinite(cost)) {
          totalCostToday += cost;
        }
      }
    }

    res.json({
      active,
      needs_input: needsInput,
      failed,
      completed_today: completedToday,
      total_cost_today: totalCostToday,
    });
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

    // v3 Phase 2: project-scoped Operator slots are a 1st-class runtime target.
    // Each entry mirrors the top snapshot shape so the client can render
    // a unified card list without branching on layer. The registry is the
    // source of truth for "which Operator run is live right now"; the DB row is
    // fetched for status/metadata. probeActive takes care of liveness +
    // cleanup along the way.
    const snapshot = managerRegistry.snapshot();
    const pms = [];
    for (const pmEntry of snapshot.pms) {
      const pmRun = managerRegistry.probeActive(pmEntry.conversationId);
      if (!pmRun) continue;
      const pmAdapter = managerRegistry.getActiveAdapter(pmEntry.conversationId)
        || managerAdapterFactory.getAdapter(pmRun.manager_adapter || 'claude-code');
      // A2b-3: expose the legacy `operator:<projectId>` alias so the client can
      // recover a canonical `operator:<instanceId>` conversation's primary project
      // (its own parser returns no projectId for oi_*). The codebase picker uses
      // this to exclude/label the primary. null when the resolver can't map it.
      let legacyConversationId = pmEntry.legacyConversationId || null;
      let primaryProjectId = null;
      let instanceId = pmRun.operator_instance_id || null;
      if (runService && typeof runService.resolveOperatorConversationId === 'function') {
        try {
          const resolved = runService.resolveOperatorConversationId(pmEntry.conversationId);
          legacyConversationId = legacyConversationId || resolved?.legacySlotId || null;
          primaryProjectId = resolved?.primaryProjectId || null;
          instanceId = instanceId || resolved?.instanceId || null;
        } catch { /* annotate-only */ }
      }
      // Resolve the instance id before loading metadata: resumed and
      // pre-migration runs may not have runs.operator_instance_id populated.
      let operatorInstance = null;
      if (operatorInstanceService && instanceId) {
        try {
          operatorInstance = operatorInstanceService.getInstance(instanceId);
        } catch { /* annotate-only */ }
      }
      if (
        !primaryProjectId
        && operatorInstanceService
        && instanceId
        && typeof operatorInstanceService.getPrimaryProjectIdForInstance === 'function'
      ) {
        try {
          primaryProjectId = operatorInstanceService.getPrimaryProjectIdForInstance(instanceId) || null;
        } catch { /* annotate-only */ }
      }
      if (!primaryProjectId && operatorInstance?.refs) {
        primaryProjectId = operatorInstance.refs.find(ref => ref.role === 'primary')?.project_id || null;
      }
      // F-1: surface this Operator's Codex Fast Mode toggle so the UI can render
      // the ⚡ control without an extra fetch. null when unknown (no instance /
      // service unavailable / read error) — the UI treats null as "off/unset".
      const fastMode = operatorInstance ? operatorInstance.fast_mode : null;
      pms.push({
        conversationId: pmEntry.conversationId,
        legacyConversationId, // A2b-3: canonical→primary recovery for the codebase picker
        primaryProjectId,
        instanceId,
        profileId: operatorInstance?.profile_id || null,
        displayName: operatorInstance?.display_name || operatorInstance?.profile_name || null,
        run: pmRun,
        usage: pmAdapter.getUsage ? pmAdapter.getUsage(pmRun.id) : null,
        claudeSessionId: pmAdapter.getSessionId ? pmAdapter.getSessionId(pmRun.id) : null,
        fastMode, // F-1
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
    const cleaned = await adapter.disposeSession(runId);
    if (cleaned === false) {
      return res.status(502).json({
        error: 'manager_dispose_failed',
        message: 'Manager secret cleanup remains pending; retry stop after the execution node recovers.',
      });
    }

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

module.exports = {
  createManagerRouter,
  // #431: exported for the fresh/resume parity test only. Not a public seam —
  // production callers reach this through the resume paths above.
  __testables: { resolveResumeEnvAllowlist },
};
