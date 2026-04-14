const express = require('express');
const path = require('path');
const os = require('os');
const { createStorageContext } = require('./services/storage');
const { createSessionService } = require('./services/sessionService');
const { createTrashService } = require('./services/trashService');
const { createMessageService } = require('./services/messageService');
const { createFsService } = require('./services/fsService');
const { createOpencodeService } = require('./services/opencodeService');
const { createCodexService } = require('./services/codexService');
const { createProviderRegistry } = require('./services/providers');
const { createDatabase } = require('./db/database');
const { createEventBus } = require('./services/eventBus');
const { createProjectService } = require('./services/projectService');
const { createProjectBriefService } = require('./services/projectBriefService');
const { createTaskService } = require('./services/taskService');
const { createRunService } = require('./services/runService');
const { createAgentProfileService } = require('./services/agentProfileService');
const { createSessionsRouter } = require('./routes/sessions');
const { createTrashRouter } = require('./routes/trash');
const { createFsRouter } = require('./routes/fs');
const { createUsageRouter } = require('./routes/usage');
const { createProjectsRouter } = require('./routes/projects');
const { createTasksRouter } = require('./routes/tasks');
const { createRunsRouter } = require('./routes/runs');
const { createAgentsRouter } = require('./routes/agents');
const { createEventsRouter } = require('./routes/events');
const { createClaudeSessionsRouter } = require('./routes/claude-sessions');
const { createExecutionEngine } = require('./services/executionEngine');
const { createStreamJsonEngine } = require('./services/streamJsonEngine');
const { createManagerAdapterFactory } = require('./services/managerAdapters');
const { createWorktreeService } = require('./services/worktreeService');
const { createLifecycleService } = require('./services/lifecycleService');
const { createAuthMiddleware } = require('./middleware/auth');
const { errorHandler } = require('./middleware/errorHandler');
const { createManagerRouter } = require('./routes/manager');
const { createConversationsRouter } = require('./routes/conversations');
const { createManagerRegistry } = require('./services/managerRegistry');
const { createConversationService } = require('./services/conversationService');
const { createPmCleanupService } = require('./services/pmCleanupService');
const { createPmSpawnService } = require('./services/pmSpawnService');
const { createReconciliationService } = require('./services/reconciliationService');
const { createDispatchAuditRouter } = require('./routes/dispatchAudit');
const { createRouterService } = require('./services/routerService');
const { createRouterRouter } = require('./routes/router');
const { createAuthRouter } = require('./routes/auth');
const { createSkillPackService } = require('./services/skillPackService');
const { createRegistryService } = require('./services/registryService');
const { createSkillPacksRouter } = require('./routes/skillPacks');
const { createPresetService } = require('./services/presetService');
const { createWorkerPresetsRouter } = require('./routes/workerPresets');

function createApp(options = {}) {
  const app = express();
  // PR1: tests pass `authToken` explicitly to avoid mutating
  // process.env.PALANTIR_TOKEN (which would leak into sibling test files
  // running in parallel via `node --test`). Production code path leaves
  // options.authToken undefined and falls back to process.env.
  const authToken = options.authToken !== undefined
    ? options.authToken
    : process.env.PALANTIR_TOKEN;
  const storageRoot = options.storageRoot
    || process.env.OPENCODE_STORAGE
    || path.join(os.homedir(), '.local', 'share', 'opencode', 'storage');
  const fsRoot = options.fsRoot || process.env.OPENCODE_FS_ROOT || os.homedir();
  const opencodeBin = options.opencodeBin || process.env.OPENCODE_BIN || 'opencode';
  const codexBin = options.codexBin || process.env.CODEX_BIN || 'codex';
  const codexHome = options.codexHome
    || process.env.CODEX_HOME
    || path.join(os.homedir(), '.codex');
  const opencodeAuthPath = options.opencodeAuthPath
    || process.env.OPENCODE_AUTH_PATH
    || path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
  const codexStatusTimeoutMs = Number(
    options.codexStatusTimeoutMs || process.env.CODEX_STATUS_TIMEOUT_MS || 60000
  );

  // SQLite database
  const dbPath = options.dbPath || process.env.PALANTIR_DB || path.join(__dirname, 'palantir.db');
  const { db, migrate, close: closeDb } = createDatabase(dbPath);
  migrate();

  // Skill Packs: ensure runtime/mcp/ directory exists for MCP config files
  const fs = require('fs');
  fs.mkdirSync(path.resolve(process.cwd(), 'runtime', 'mcp'), { recursive: true });

  // Event bus for SSE
  const eventBus = createEventBus();

  // Existing services (filesystem-based)
  const storage = createStorageContext({ storageRoot, fsRoot });
  const sessionService = createSessionService(storage);
  const trashService = createTrashService(storage);
  const messageService = createMessageService(storage);
  const fsService = createFsService(storage);
  const opencodeService = createOpencodeService({ opencodeBin });
  const codexService = createCodexService({
    codexBin,
    codexHome,
    timeoutMs: codexStatusTimeoutMs
  });
  const providerRegistry = createProviderRegistry({ codexService, opencodeAuthPath });

  // New services (SQLite-based)
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db); // v3 Phase 1
  const taskService = createTaskService(db, eventBus);
  const runService = createRunService(db, eventBus);
  const agentProfileService = createAgentProfileService(db);
  const skillPackService = createSkillPackService(db);
  const registryService = createRegistryService();
  // Phase 10B: Worker Preset service. pluginsRoot defaults to
  // <repo>/server/plugins/ but tests can override via options.pluginsRoot.
  const presetService = createPresetService(db, {
    pluginsRoot: options.pluginsRoot,
  });

  // Execution engines
  const executionEngine = createExecutionEngine();
  const streamJsonEngine = createStreamJsonEngine({ runService, eventBus });
  const managerAdapterFactory = createManagerAdapterFactory({ streamJsonEngine, runService });
  const worktreeService = createWorktreeService();
  const lifecycleService = createLifecycleService({
    runService, taskService, agentProfileService, projectService,
    executionEngine, streamJsonEngine, worktreeService, eventBus,
    skillPackService,
    presetService,
    claudeVersionResolver: options.claudeVersionResolver,
    // Phase 10D: isolated-preset auth materialization honors the same
    // `authResolverOpts` tests already pass for manager-path preflight.
    authResolverOpts: options.authResolverOpts || {},
  });

  // v3 Phase 1.5: shared manager registry + conversation service.
  // managerRegistry tracks which manager runs are live per conversation
  // ('top' / 'pm:<projectId>'); conversationService owns the parent-notice
  // queue and the unified send/resolve routing used by both the new
  // /api/conversations router and the legacy /api/manager/* routes.
  const managerRegistry = createManagerRegistry({ runService });
  // v3 Phase 3a: lazy PM spawn + single-owner cleanup. pmSpawnService is
  // wired into conversationService below so a first message to
  // pm:<projectId> creates the PM run on demand. pmCleanupService is the
  // single termination owner for /reset, delete-project, and future
  // pm_enabled=false toggles (spec §5 책임 분담표).
  const pmSpawnService = createPmSpawnService({
    runService,
    managerRegistry,
    managerAdapterFactory,
    projectService,
    projectBriefService,
    agentProfileService,
    skillPackService,
    authResolverOpts: options.authResolverOpts || {},
  });
  const pmCleanupService = createPmCleanupService({
    projectService,
    projectBriefService,
    managerRegistry,
    managerAdapterFactory,
    runService,
    eventBus,
  });
  const conversationService = createConversationService({
    runService,
    managerRegistry,
    managerAdapterFactory,
    lifecycleService,
    pmSpawnService,
  });
  // v3 Phase 2: whenever a manager slot (top or pm:<projectId>) is cleared
  // — by explicit stop, liveness probe, or rotation — drop any lingering
  // parent-notice queue entries keyed by the dying run id so they cannot
  // be misapplied to some future unrelated run. Codex R1 blocker fix.
  managerRegistry.onSlotCleared(({ runId }) => {
    try { conversationService.clearParentNotices(runId); } catch { /* ignore */ }
  });

  // PM auto-review: when a worker run completes/fails within a project
  // that has an active PM, send the result summary to the PM so it can
  // autonomously review and decide whether to re-run or mark the task done.
  //
  // Circuit breaker: track per-(project, task) review count. After
  // AUTO_REVIEW_MAX rounds, stop auto-reviewing and let the PM sit idle
  // so the user can intervene. Resets on PM slot cleared (session end/reset).
  const AUTO_REVIEW_MAX = 5;
  const _autoReviewCounts = new Map(); // "projectId:taskId" -> count
  // Reset circuit breaker when PM slot is cleared (session end/reset).
  managerRegistry.onSlotCleared(({ conversationId }) => {
    if (!conversationId || !conversationId.startsWith('pm:')) return;
    const projectId = conversationId.slice(3);
    for (const key of _autoReviewCounts.keys()) {
      if (key.startsWith(`${projectId}:`)) _autoReviewCounts.delete(key);
    }
  });
  eventBus.subscribe((event) => {
    if (event.channel !== 'run:completed') return;
    const run = event.data?.run;
    if (!run || run.is_manager) return;
    const projectId = run.project_id;
    if (!projectId) return;
    const pmSlotKey = `pm:${projectId}`;
    const pmRunId = managerRegistry.getActiveRunId(pmSlotKey);
    if (!pmRunId) return; // no active PM for this project
    // Circuit breaker check
    const countKey = `${projectId}:${run.task_id || '_'}`;
    const count = _autoReviewCounts.get(countKey) || 0;
    if (count >= AUTO_REVIEW_MAX) {
      console.warn(`[pm-auto-review] Circuit breaker: ${countKey} hit ${AUTO_REVIEW_MAX} reviews — skipping. User intervention needed.`);
      return;
    }
    // Build review notification
    const status = run.status || 'unknown';
    const taskId = run.task_id || 'none';
    const summaryRaw = (run.result_summary || '').replace(/\[system[:\s]/gi, '[info ');
    const exitCode = run.exit_code != null ? run.exit_code : '?';
    const reviewText = [
      `[system: worker completed — auto-review required]`,
      `Worker run ${run.id} finished.`,
      `  status: ${status}`,
      `  exit_code: ${exitCode}`,
      `  task_id: ${taskId}`,
      summaryRaw ? `  result: ${summaryRaw.slice(0, 1000)}` : '',
      '',
      `Review round ${count + 1}/${AUTO_REVIEW_MAX} for this task.`,
      'Review this worker\'s output (GET /api/runs/' + run.id + '/events), then:',
      '- If the work is satisfactory, update the task status to "done".',
      '- If additional work is needed, spawn a new worker with corrective instructions.',
      '- If the worker failed, diagnose and retry or escalate to the user.',
    ].filter(Boolean).join('\n');
    // Defer to next tick to avoid "previous turn still running" conflict.
    // Counter is incremented only AFTER successful send (rollback on failure).
    setImmediate(() => {
      try {
        conversationService.sendMessage(pmSlotKey, { text: reviewText });
        _autoReviewCounts.set(countKey, count + 1); // increment only on success
      } catch (err) {
        console.warn(`[pm-auto-review] Failed to send review to ${pmSlotKey}: ${err.message}`);
        // Counter NOT incremented — next completion will retry
      }
    });
  });

  // v3 Phase 4: annotate-only reconciliation. reconciliationService
  // reads conversationService.peekParentNotices to detect "user
  // intervention stale" claims, so it has to be constructed AFTER
  // conversationService. It does not emit events or block anything —
  // it writes to dispatch_audit_log and the UI renders a badge.
  // v3 Phase 6: deterministic conversation-target matcher. Pure,
  // projectService-only dependency, reused by both the HTTP route and
  // (future) in-process Top-layer LLM dispatch paths.
  const routerService = createRouterService({ projectService });

  const reconciliationService = createReconciliationService({
    db,
    runService,
    taskService,
    projectService,
    agentProfileService,
    conversationService,
    eventBus, // v3 Phase 7: enables dispatch_audit:recorded SSE events
  });

  // Middleware
  app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => {
    // PR1 / P0-1: marked + DOMPurify are now self-hosted in /vendor/, so
    // cdn.jsdelivr.net is gone from script-src and connect-src. fonts remain
    // because Google Fonts is still a CDN link in index.html (low-risk,
    // static CSS only).
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'"
    );
    // PR1 round 2: prevent any URL-carried credentials (even if a caller
    // accidentally builds a URL like `/?foo=token`) from leaking via
    // Referer headers to the external font hosts that CSP above still
    // permits. `no-referrer` is fine here — the SPA is same-origin and
    // nothing uses Referer for functionality.
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(express.static(path.join(__dirname, 'public')));

  // Health check (before auth — must be accessible without token)
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', version: '2.0.0' });
  });

  // Auth router mounted BEFORE the global /api auth middleware — login
  // and logout have to be reachable without an existing session cookie.
  // /api/auth/login performs its own timing-safe comparison against
  // PALANTIR_TOKEN; logout always succeeds (it just clears the cookie).
  app.use('/api/auth', createAuthRouter({ token: authToken }));

  // Auth middleware for API routes (skips static files + health + /api/auth)
  const auth = createAuthMiddleware({ token: authToken });
  app.use('/api', auth);

  // Existing routes
  app.use('/api/sessions', createSessionsRouter({
    sessionService,
    messageService,
    trashService,
    opencodeService,
    storageRoot: storage.storageRoot
  }));
  app.use('/api/trash/sessions', createTrashRouter({ trashService }));
  app.use('/api/fs', createFsRouter({ fsService }));
  app.use('/api/usage', createUsageRouter({ codexService, providerRegistry }));

  // New routes (v2)
  app.use('/api/projects', createProjectsRouter({ projectService, taskService, projectBriefService, pmCleanupService }));
  app.use('/api/tasks', createTasksRouter({ taskService, lifecycleService }));
  app.use('/api/runs', createRunsRouter({ runService, lifecycleService, executionEngine, streamJsonEngine, conversationService }));
  // PR18: tests can pass options.authResolverOpts (e.g. a fake `hasKeychain`)
  // so /api/agents and /api/manager preflights are deterministic across CI
  // hosts that may or may not have a Claude keychain item. Production callers
  // leave this empty and get the real keychain probe.
  const authResolverOpts = options.authResolverOpts || {};
  app.use('/api/agents', createAgentsRouter({ agentProfileService, providerRegistry, authResolverOpts }));
  app.use('/api/events', createEventsRouter({ eventBus }));
  app.use('/api/claude-sessions', createClaudeSessionsRouter());
  app.use('/api/manager', createManagerRouter({ runService, streamJsonEngine, managerAdapterFactory, managerRegistry, conversationService, eventBus, projectService, projectBriefService, agentProfileService, pmCleanupService, pmSpawnService, skillPackService, authResolverOpts }));
  app.use('/api/conversations', createConversationsRouter({ conversationService, runService }));
  app.use('/api/dispatch-audit', createDispatchAuditRouter({ reconciliationService }));
  app.use('/api/router', createRouterRouter({ routerService }));
  app.use('/api/worker-presets', createWorkerPresetsRouter({ presetService }));
  app.use('/api/skill-packs', createSkillPacksRouter({ skillPackService, registryService }));
  app.use('/api/projects', createSkillPacksRouter.projectBindings({ skillPackService }));
  app.use('/api/tasks', createSkillPacksRouter.taskBindings({ skillPackService }));
  app.use('/api/runs', createSkillPacksRouter.runSnapshots({ skillPackService }));

  app.use(errorHandler);

  // Lifecycle: start monitoring FIRST (installs the run:ended subscriber
  // that drives cleanupRunWorktree), THEN recover orphans. PR3a / NEW-B1:
  // pre-PR3a the order was reversed — recoverOrphanSessions emitted
  // run:ended events while nothing was listening, so orphaned worktrees
  // never got cleaned. Reversing keeps a single cleanup authority (the
  // run:ended subscriber) instead of duplicating teardown logic in the
  // recovery path (Codex-agreed option A).
  lifecycleService.startMonitoring();
  const recovered = lifecycleService.recoverOrphanSessions();
  if (recovered.length > 0) {
    console.log(`[app] Recovered ${recovered.length} orphan session(s)`);
  }
  // Skill Packs: clean up orphan MCP config files from previous runs
  const mcpCleaned = lifecycleService.cleanupOrphanMcpConfigs();
  if (mcpCleaned > 0) {
    console.log(`[app] Cleaned ${mcpCleaned} orphan MCP config file(s)`);
  }

  // Expose for graceful shutdown + tests. managerRegistry is exposed
  // here (PR2) so manager-lifecycle.test.js can drive a real
  // app.shutdown() with a live slot without reimplementing the sweep
  // algorithm. Production callers have no reason to reach for it.
  app.managerRegistry = managerRegistry;
  app.closeDb = closeDb;
  app.shutdown = () => {
    // PR2 / P1-5: walk every live manager slot (Top + every PM) and
    // dispose the adapter session before we tear the process down.
    // Without this, `app.shutdown()` left manager subprocesses and
    // their tmp dirs orphaned across test runs (visible as test
    // `.palantir-worktrees/` leaks) and, in production, survived a
    // graceful restart as zombie processes.
    //
    // Order matters:
    //   1) manager dispose — uses runService + eventBus, so must
    //      happen BEFORE closeDb() severs the sqlite handle,
    //   2) lifecycleService.stopMonitoring() — cancels the health
    //      loop that might otherwise try to act on a closed db,
    //   3) closeDb().
    //
    // Dispose failures are logged but do NOT re-throw; shutdown is
    // best-effort and a partial cleanup is still better than leaving
    // the db open. This is distinct from the /reset + DELETE /projects
    // paths, which are fail-closed (pmCleanupService re-throws so the
    // HTTP layer can 502).
    try {
      const snap = managerRegistry.snapshot();
      const slots = [];
      if (snap.top) slots.push(snap.top);
      for (const pm of (snap.pms || [])) slots.push(pm);
      for (const slot of slots) {
        try {
          const adapter = managerRegistry.getActiveAdapter(slot.conversationId);
          if (adapter && typeof adapter.disposeSession === 'function') {
            adapter.disposeSession(slot.runId);
          }
        } catch (err) {
          console.warn(`[app.shutdown] disposeSession failed for ${slot.conversationId}/${slot.runId}:`, err && err.message);
        }
      }
    } catch (err) {
      console.warn('[app.shutdown] manager dispose sweep failed:', err && err.message);
    }
    lifecycleService.stopMonitoring();
    closeDb();
  };

  return app;
}

module.exports = { createApp };
