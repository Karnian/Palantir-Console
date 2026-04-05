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
const { createProviderService } = require('./services/providerService');
const { fetchAnthropicUsage, fetchGeminiUsage } = require('./services/externalUsageService');
const { createDatabase } = require('./db/database');
const { createEventBus } = require('./services/eventBus');
const { createProjectService } = require('./services/projectService');
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
const { createWorktreeService } = require('./services/worktreeService');
const { createLifecycleService } = require('./services/lifecycleService');
const { createAuthMiddleware } = require('./middleware/auth');
const { errorHandler } = require('./middleware/errorHandler');

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
  const providerService = createProviderService({ authPath: opencodeAuthPath });

  // New services (SQLite-based)
  const projectService = createProjectService(db);
  const taskService = createTaskService(db, eventBus);
  const runService = createRunService(db, eventBus);
  const agentProfileService = createAgentProfileService(db);

  // Execution engine (Phase 2)
  const executionEngine = createExecutionEngine();
  const worktreeService = createWorktreeService();
  const lifecycleService = createLifecycleService({
    runService, taskService, agentProfileService,
    executionEngine, worktreeService, eventBus,
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
  app.use('/api/usage', createUsageRouter({
    codexService,
    providerService,
    fetchAnthropicUsage,
    fetchGeminiUsage
  }));

  // New routes (v2)
  app.use('/api/projects', createProjectsRouter({ projectService, taskService }));
  app.use('/api/tasks', createTasksRouter({ taskService, lifecycleService }));
  app.use('/api/runs', createRunsRouter({ runService, lifecycleService, executionEngine }));
  app.use('/api/agents', createAgentsRouter({ agentProfileService }));
  app.use('/api/events', createEventsRouter({ eventBus }));
  app.use('/api/claude-sessions', createClaudeSessionsRouter());

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
