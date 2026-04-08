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

function createApp(options = {}) {
  const app = express();
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

  // Execution engines
  const executionEngine = createExecutionEngine();
  const streamJsonEngine = createStreamJsonEngine({ runService, eventBus });
  const managerAdapterFactory = createManagerAdapterFactory({ streamJsonEngine, runService });
  const worktreeService = createWorktreeService();
  const lifecycleService = createLifecycleService({
    runService, taskService, agentProfileService, projectService,
    executionEngine, streamJsonEngine, worktreeService, eventBus,
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
    authResolverOpts: options.authResolverOpts || {},
  });
  const pmCleanupService = createPmCleanupService({
    projectService,
    projectBriefService,
    managerRegistry,
    managerAdapterFactory,
    runService,
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

  // v3 Phase 4: annotate-only reconciliation. reconciliationService
  // reads conversationService.peekParentNotices to detect "user
  // intervention stale" claims, so it has to be constructed AFTER
  // conversationService. It does not emit events or block anything —
  // it writes to dispatch_audit_log and the UI renders a badge.
  const reconciliationService = createReconciliationService({
    db,
    runService,
    taskService,
    projectService,
    agentProfileService,
    conversationService,
  });

  // Middleware
  app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' https://cdn.jsdelivr.net; connect-src 'self' https://cdn.jsdelivr.net"
    );
    next();
  });
  app.use(express.static(path.join(__dirname, 'public')));

  // Health check (before auth — must be accessible without token)
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', version: '2.0.0' });
  });

  // Auth middleware for API routes (skips static files + health)
  const auth = createAuthMiddleware();
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
  app.use('/api/manager', createManagerRouter({ runService, streamJsonEngine, managerAdapterFactory, managerRegistry, conversationService, eventBus, projectService, projectBriefService, agentProfileService, pmCleanupService, authResolverOpts }));
  app.use('/api/conversations', createConversationsRouter({ conversationService, runService }));
  app.use('/api/dispatch-audit', createDispatchAuditRouter({ reconciliationService }));

  app.use(errorHandler);

  // Lifecycle: recover orphans + start monitoring
  const recovered = lifecycleService.recoverOrphanSessions();
  if (recovered.length > 0) {
    console.log(`[app] Recovered ${recovered.length} orphan session(s)`);
  }
  lifecycleService.startMonitoring();

  // Expose for graceful shutdown
  app.closeDb = closeDb;
  app.shutdown = () => {
    lifecycleService.stopMonitoring();
    closeDb();
  };

  return app;
}

module.exports = { createApp };
