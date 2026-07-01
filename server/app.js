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
const { createHarvestService } = require('./services/harvestService');
const { createWebhookService } = require('./services/webhookService');
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
const { createMcpTemplateService } = require('./services/mcpTemplateService');
const { createMcpTemplatesRouter } = require('./routes/mcpTemplates');
const { createMemoryService } = require('./services/memoryService');
const { createMasterMemoryService } = require('./services/masterMemoryService');
const { createMemoryDistillService } = require('./services/memoryDistillService');
const { createLiveDistiller } = require('./services/distillers/liveDistiller');
const { createMemoryRouter } = require('./routes/memory');
const { createOperatorSpecialistRouter } = require('./routes/operatorSpecialist');
const { createOperatorProfilesRouter } = require('./routes/operatorProfiles');
const { createOperatorProfileMemoryRouter } = require('./routes/operatorProfileMemory');
const { createOperatorProfileService } = require('./services/operatorProfileService');
const { createMasterMemoryRouter } = require('./routes/masterMemory');
// A2-3a: PM-slot composer+ledger cutover (flag-gated, default OFF)
const { createMemoryComposer, buildWorkspaceAdapter, buildUserAdapter } = require('./services/memoryComposer');
const { createCompositionLedger } = require('./services/compositionLedger');
// Operator P-B2c: folder-less specialist backend + spawn service (flag-gated, unrouted)
const { createSpecialistBackend } = require('./services/specialistBackend');
const { createSpecialistService } = require('./services/specialistService');

const AUTO_REVIEW_MAX = 5;
const REVIEW_TEXT_CAP = 1000;
const HARVEST_TEXT_CAP = 500;
let warnedComposerFlags = false;

function capText(value, maxChars) {
  const text = String(value || '');
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function indentBlock(value) {
  return capText(value, HARVEST_TEXT_CAP)
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

function formatHarvestSummary(harvestSummary) {
  if (!harvestSummary) return [];
  const errors = Array.isArray(harvestSummary.errors) ? harvestSummary.errors : [];
  if (!harvestSummary.harvested) {
    return [`  [harvest] 수집 불가 (${errors.join(', ') || 'unknown'})`];
  }

  const lines = [
    `  [harvest] files: ${Number(harvestSummary.files) || 0}, commits: ${Number(harvestSummary.commits) || 0}`,
  ];
  const test = harvestSummary.test;
  if (test) {
    const testStatus = test.timed_out ? 'TIMEOUT' : (test.passed ? 'PASS' : 'FAIL');
    const exitCode = test.exit_code != null ? test.exit_code : '?';
    const duration = test.duration_ms != null ? `${test.duration_ms}ms` : '?ms';
    lines.push(`  [harvest] test: ${testStatus} (exit ${exitCode}, ${duration})`);
  }
  if (harvestSummary.statText) {
    lines.push('  [harvest] stat:');
    lines.push(indentBlock(harvestSummary.statText));
  }
  if (test?.output_tail) {
    lines.push('  [harvest] test output:');
    lines.push(indentBlock(test.output_tail));
  }
  if (errors.length > 0) {
    lines.push(`  [harvest] errors: ${errors.join(', ')}`);
  }
  return lines;
}

function buildPmReviewText({ run, harvestSummary, count, autoReviewMax = AUTO_REVIEW_MAX }) {
  const status = run.status || 'unknown';
  const taskId = run.task_id || 'none';
  const summaryRaw = (run.result_summary || '').replace(/\[system[:\s]/gi, '[info ');
  const exitCode = run.exit_code != null ? run.exit_code : '?';
  return [
    `[system: worker finished — auto-review required]`,
    `Worker run ${run.id} finished.`,
    `  status: ${status}`,
    `  exit_code: ${exitCode}`,
    `  task_id: ${taskId}`,
    summaryRaw ? `  result: ${capText(summaryRaw, REVIEW_TEXT_CAP)}` : '',
    ...formatHarvestSummary(harvestSummary),
    '',
    `Review round ${count + 1}/${autoReviewMax} for this task.`,
    'Review this worker\'s harvested output and run events (GET /api/runs/' + run.id + '/events), then:',
    '- If the work is satisfactory, update the task status to "done".',
    '- If additional work is needed, spawn a new worker with corrective instructions.',
    '- If the worker failed, diagnose and retry or escalate to the user.',
    // The system auto-retries a genuinely-failed worker once (B-lite queue).
    // Tell the PM so it doesn't ALSO spawn a duplicate retry — check for a
    // newer attempt run on this task first.
    status === 'failed'
      ? '- NOTE: the system may have already queued ONE automatic retry for this failure. Check GET /api/tasks/' + taskId + ' runs for a newer attempt before spawning another — avoid duplicate retries.'
      : '',
  ].filter(Boolean).join('\n');
}

function createPmAutoReview({
  eventBus,
  managerRegistry,
  conversationService,
  runService,
  autoReviewMax = AUTO_REVIEW_MAX,
  defer = setImmediate,
  logger = console,
} = {}) {
  const autoReviewCounts = new Map(); // "projectId:taskId" -> count

  managerRegistry.onSlotCleared(({ conversationId }) => {
    if (!conversationId || !conversationId.startsWith('pm:')) return;
    const projectId = conversationId.slice(3);
    for (const key of autoReviewCounts.keys()) {
      if (key.startsWith(`${projectId}:`)) autoReviewCounts.delete(key);
    }
  });

  function hasHigherRetryAttempt(run) {
    if (!runService || typeof runService.listRuns !== 'function' || !run?.task_id) {
      return false;
    }
    try {
      const currentRetryCount = Number(run.retry_count || 0);
      const runs = runService.listRuns({ task_id: run.task_id }) || [];
      return runs.some((candidate) => (
        candidate
        && candidate.id !== run.id
        && !candidate.is_manager
        && ['queued', 'running'].includes(candidate.status)
        && Number(candidate.retry_count || 0) > currentRetryCount
      ));
    } catch {
      return false;
    }
  }

  function sendPmReview({ run, harvestSummary }) {
    if (!run || run.is_manager) return false;
    const status = harvestSummary?.status || run.status;
    if (status === 'failed' && hasHigherRetryAttempt(run)) {
      try {
        if (runService && typeof runService.addRunEvent === 'function') {
          runService.addRunEvent(run.id, 'pm_review:suppressed', JSON.stringify({
            reason: 'retry_pending',
          }));
        }
      } catch { /* ignore observability failures */ }
      return false;
    }

    const projectId = run.project_id;
    if (!projectId) return false;
    const pmSlotKey = `pm:${projectId}`;
    const pmRunId = managerRegistry.getActiveRunId(pmSlotKey);
    if (!pmRunId) return false;

    const countKey = `${projectId}:${run.task_id || '_'}`;
    const count = autoReviewCounts.get(countKey) || 0;
    if (count >= autoReviewMax) {
      logger.warn(`[pm-auto-review] Circuit breaker: ${countKey} hit ${autoReviewMax} reviews; skipping. User intervention needed.`);
      return false;
    }

    // Reserve the slot synchronously (before the deferred send) so two
    // run:harvested events for the same task can't both read a stale count
    // and slip past the breaker. Roll back if the send actually fails.
    autoReviewCounts.set(countKey, count + 1);

    const reviewText = buildPmReviewText({
      run,
      harvestSummary,
      count,
      autoReviewMax,
    });

    defer(() => {
      try {
        conversationService.sendMessage(pmSlotKey, { text: reviewText });
      } catch (err) {
        // Decrement (not set-to-count) so a concurrent reservation isn't clobbered;
        // delete at zero so the key returns to its pristine (absent) state.
        const next = Math.max(0, (autoReviewCounts.get(countKey) || 1) - 1);
        if (next === 0) autoReviewCounts.delete(countKey);
        else autoReviewCounts.set(countKey, next);
        logger.warn(`[pm-auto-review] Failed to send review to ${pmSlotKey}: ${err.message}`);
      }
    });
    return true;
  }

  eventBus.subscribe((event) => {
    if (event.channel !== 'run:harvested') return;
    sendPmReview({
      run: event.data?.run,
      harvestSummary: event.data?.summary,
    });
  });

  return { sendPmReview, autoReviewCounts };
}

// ML PR2a (R6): capture deterministic environment facts from worker harvest.
// Subscribes to run:harvested independently of PM review, re-reads the
// harvest:test event from run_events (run:harvested.summary omits
// command/node_major), and upserts env.test_command / env.node_resolution
// facts. Never throws — annotate-only, like harvest itself. Excludes
// run-specific noise (pass/fail/exit/duration/output_tail/diff/worktree).
function createR6FactCapture({ eventBus, runService, memoryService, logger = console } = {}) {
  if (!eventBus || !runService || !memoryService) return { capture: () => {} };

  function clip(value, max) {
    const s = String(value || '');
    return s.length <= max ? s : s.slice(0, max);
  }

  function capture(run) {
    if (!run || run.is_manager || !run.project_id) return;
    let events;
    try { events = runService.getRunEvents(run.id) || []; } catch { return; }
    const testEvent = events.find((e) => e.event_type === 'harvest:test');
    if (!testEvent) return;
    let payload;
    try { payload = JSON.parse(testEvent.payload_json || '{}'); } catch { return; }
    const evidenceJson = JSON.stringify({
      run_id: run.id,
      task_id: run.task_id || null,
      event_id: testEvent.id,
    });
    // env.test_command — the project's harvest test command.
    if (payload.command) {
      try {
        memoryService.upsertFact({
          projectId: run.project_id,
          factKey: 'env.test_command',
          content: `Project test command: ${clip(payload.command, 200)}`,
          evidenceJson,
          importance: 6,
        });
      } catch (err) { logger.warn(`[r6-fact] test_command run=${run.id}: ${err.message}`); }
    }
    // env.node_resolution — a resolved project node vs an unresolved fallback
    // (the latter is NOT "runs on node N" — avoid that contamination).
    if (payload.node_major != null) {
      // 3-way: only source='project' is an actual resolved project requirement.
      // 'fallback' = declared-but-unresolved, 'server' = no project declaration
      // (or same/range/dirty) — neither must read as "the project requires N"
      // (Codex cross-review SERIOUS: avoid server-source contamination).
      let content;
      if (payload.node_source === 'project') {
        content = `Project requires Node major ${payload.node_major} (resolved)`;
      } else if (payload.node_source === 'fallback') {
        content = `Project declares Node major ${payload.node_major} but it is unresolved; harvest falls back to the server node`;
      } else {
        content = `No project-specific Node declaration; harvest uses the server Node major ${payload.node_major}`;
      }
      try {
        memoryService.upsertFact({
          projectId: run.project_id,
          factKey: 'env.node_resolution',
          content,
          evidenceJson,
          importance: 5,
        });
      } catch (err) { logger.warn(`[r6-fact] node_resolution run=${run.id}: ${err.message}`); }
    }
  }

  eventBus.subscribe((event) => {
    if (event.channel !== 'run:harvested') return;
    capture(event.data?.run);
  });

  return { capture };
}

// ML PR2b (R1b): capture failure->fix pairs as memory candidates. When a
// worker run finishes with a PASSing harvest:test AND the immediately
// preceding same-task test run FAILed (no intervening PASS), that fail->fix
// transition is the highest-signal learning event (ReasoningBank negative
// constraint). Stages a candidate; PR3 batch LLM distills it into an active
// pitfall/heuristic. Deterministic, LLM-free, never throws.
function createR1bCapture({ eventBus, runService, memoryService, logger = console } = {}) {
  if (!eventBus || !runService || !memoryService) return { capture: () => {} };

  function testResult(events) {
    const t = events.find((e) => e.event_type === 'harvest:test');
    if (!t) return null;
    try {
      const p = JSON.parse(t.payload_json || '{}');
      // Require a real boolean — a malformed/empty payload is NOT a result
      // (Codex cross-review SERIOUS: {} must not read as FAIL).
      if (typeof p.passed !== 'boolean') return null;
      return { passed: p.passed, eventId: t.id };
    } catch { return null; }
  }

  function capture(run) {
    if (!run || run.is_manager || !run.project_id || !run.task_id) return;
    let yEvents;
    try { yEvents = runService.getRunEvents(run.id) || []; } catch { return; }
    const y = testResult(yEvents);
    if (!y || !y.passed) return; // the fix run must itself be a PASS

    // Order ALL same-task runs by rowid (_seq, exposed by getByTask) = true
    // creation order. We inspect the IMMEDIATELY preceding RUN (not just the
    // preceding test-run): an intervening run without a harvest:test means Y
    // is not a direct fix of X, so we must NOT skip it (Codex cross-review
    // BLOCKER — false fix-pairs from skipped no-test runs).
    let taskRuns;
    try { taskRuns = runService.listRuns({ task_id: run.task_id }) || []; } catch { return; }
    const ordered = taskRuns.slice().sort((a, b) => {
      // True creation order is the runs rowid (getByTask exposes it as _seq).
      // created_at is only second-resolution and run ids are random UUIDs, so
      // (created_at,id) is deterministic but NOT creation order — same-second
      // runs could mis-sort and forge a fix pair (Codex r2 BLOCKER). rowid is
      // monotonic with INSERT order. Fallback only for callers lacking _seq.
      if (a._seq != null && b._seq != null) return a._seq - b._seq;
      const ca = a.created_at || '';
      const cb = b.created_at || '';
      if (ca !== cb) return ca < cb ? -1 : 1;
      const ia = String(a.id);
      const ib = String(b.id);
      return ia < ib ? -1 : ia > ib ? 1 : 0;
    });
    const yPos = ordered.findIndex((r) => r.id === run.id);
    if (yPos <= 0) return; // Y not found, or no prior run on this task
    const prevRun = ordered[yPos - 1];
    let prevEvents;
    try { prevEvents = runService.getRunEvents(prevRun.id) || []; } catch { return; }
    const prevTest = testResult(prevEvents);
    if (!prevTest || prevTest.passed !== false) return; // immediate prev must be a FAILing test
    const prev = { runId: prevRun.id };

    // R1b fix pair: prev (FAIL) -> run (PASS). Capture the fix diff stat (the
    // "what changed") but never the test output_tail (secret risk).
    const diffEvent = yEvents.find((e) => e.event_type === 'harvest:diff');
    let diffStat = null;
    if (diffEvent) {
      try { diffStat = JSON.parse(diffEvent.payload_json || '{}').stat || null; } catch { /* */ }
    }
    const rawJson = JSON.stringify({
      schema_version: 1,
      rule: 'R1b',
      task_id: run.task_id,
      fail_run: { id: prev.runId },
      fix_run: { id: run.id, diff_stat: diffStat ? String(diffStat).slice(0, 500) : null },
      selection: 'immediately_preceding_fail',
    });
    try {
      memoryService.createCandidate({
        projectId: run.project_id,
        rule: 'R1b',
        rawJson,
        dedupKey: `r1b:${run.task_id}:${prev.runId}:${run.id}`,
      });
    } catch (err) { logger.warn(`[r1b] candidate run=${run.id}: ${err.message}`); }
  }

  eventBus.subscribe((event) => {
    if (event.channel !== 'run:harvested') return;
    capture(event.data?.run);
  });

  return { capture };
}

// ML PR2c (R3): capture verified PM verdicts as memory candidates. When the PM
// claims a task is complete AND that claim is coherent with DB truth
// (incoherence_flag=0, task status='done'), that verdict is a trustworthy
// signal of "how this kind of task gets done here". Stages a candidate (PR3
// distills it). A hallucinated claim (incoherent) is NEVER captured.
// Deterministic, LLM-free, never throws.
function createR3Capture({ eventBus, memoryService, logger = console } = {}) {
  if (!eventBus || !memoryService) return { capture: () => {} };

  function clip(value, max) {
    const s = String(value || '');
    return s.length <= max ? s : s.slice(0, max);
  }

  function capture(audit) {
    if (!audit || !audit.pm_run_id || !audit.project_id) return;
    // Only coherent verdicts — a hallucinated claim must not become memory.
    if (audit.incoherence_flag !== 0) return;
    let claim;
    let truth;
    try { claim = JSON.parse(audit.pm_claim || '{}'); } catch { return; }
    try { truth = JSON.parse(audit.db_truth || '{}'); } catch { return; }
    // JSON.parse('null') succeeds but yields null — guard the shape so the
    // field reads below cannot throw (Codex cross-review BLOCKER).
    if (!claim || typeof claim !== 'object') return;
    if (!truth || typeof truth !== 'object') return;
    if (claim.kind !== 'task_complete') return;
    if (truth.status !== 'done') return;
    // dispatch_audit_log.task_id (envelope) is NULLABLE — a coherent
    // task_complete carries the real id in pm_claim/db_truth, so derive it
    // rather than dropping the candidate (Codex cross-review BLOCKER).
    const taskId = audit.task_id || claim.task_id || truth.task_id;
    if (!taskId) return;
    const rawJson = JSON.stringify({
      schema_version: 1,
      rule: 'R3',
      task_id: taskId,
      pm_run_id: audit.pm_run_id,
      verdict: 'task_complete',
      rationale: audit.rationale ? clip(audit.rationale, 500) : null,
      audit_id: audit.id,
    });
    try {
      memoryService.createCandidate({
        projectId: audit.project_id,
        rule: 'R3',
        rawJson,
        // dedup by task+pm_run so one PM session's repeated task_complete
        // claims collapse to a single candidate.
        dedupKey: `r3:task_complete:${taskId}:${audit.pm_run_id}`,
      });
    } catch (err) { logger.warn(`[r3] candidate audit=${audit.id}: ${err.message}`); }
  }

  eventBus.subscribe((event) => {
    if (event.channel !== 'dispatch_audit:recorded') return;
    capture(event.data?.audit);
  });

  return { capture };
}

function startMasterMemoryDecayScheduler({ masterMemoryService, intervalMs = 6 * 60 * 60 * 1000, logger = console } = {}) {
  const tick = () => {
    try {
      if (masterMemoryService && typeof masterMemoryService.expireStaleMemories === 'function') {
        masterMemoryService.expireStaleMemories();
      }
    } catch (err) {
      try { logger.warn(`[master-memory-decay] tick failed: ${err && err.message}`); } catch { /* */ }
    }
  };
  tick();
  let interval = setInterval(tick, intervalMs);
  try { if (interval && typeof interval.unref === 'function') interval.unref(); } catch { /* */ }
  return {
    tick,
    stop() {
      if (!interval) return;
      clearInterval(interval);
      interval = null;
    },
    get interval() { return interval; },
  };
}

function startMasterMemoryXprojectScanner({
  masterMemoryService,
  eventBus,
  intervalMs = 6 * 60 * 60 * 1000,
  debounceMs = 1000,
  limit,
  logger = console,
} = {}) {
  const safeIntervalMs = Number.parseInt(intervalMs, 10);
  const safeDebounceMs = Number.parseInt(debounceMs, 10);
  const scanIntervalMs = Number.isFinite(safeIntervalMs) && safeIntervalMs > 0
    ? safeIntervalMs
    : 6 * 60 * 60 * 1000;
  const scanDebounceMs = Number.isFinite(safeDebounceMs) && safeDebounceMs >= 0
    ? safeDebounceMs
    : 1000;
  const hintChannels = new Set(['memory:promoted', 'memory:decayed', 'memory:evicted']);

  let interval = null;
  let timer = null;
  let busy = false;
  let dirty = false;
  let stopped = false;

  const warn = (message) => {
    try { logger.warn(`[master-memory-xproject-scan] ${message}`); } catch { /* */ }
  };

  const run = () => {
    if (stopped) return null;
    if (busy) {
      dirty = true;
      return null;
    }
    busy = true;
    try {
      if (masterMemoryService && typeof masterMemoryService.scanCrossProjectCandidates === 'function') {
        return masterMemoryService.scanCrossProjectCandidates({ limit });
      }
      return null;
    } catch (err) {
      warn(`tick failed: ${err && err.message}`);
      return null;
    } finally {
      busy = false;
      if (dirty && !stopped) {
        dirty = false;
        schedule(0);
      }
    }
  };

  function schedule(delayMs = scanDebounceMs) {
    if (stopped) return false;
    if (busy) {
      dirty = true;
      return false;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      run();
    }, delayMs);
    try { if (timer && typeof timer.unref === 'function') timer.unref(); } catch { /* */ }
    return true;
  }

  const unsubscribe = eventBus && typeof eventBus.subscribe === 'function'
    ? eventBus.subscribe((event) => {
      if (!event || !hintChannels.has(event.channel)) return;
      schedule();
    })
    : null;

  run();
  interval = setInterval(run, scanIntervalMs);
  try { if (interval && typeof interval.unref === 'function') interval.unref(); } catch { /* */ }

  const api = {
    tick: run,
    schedule,
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      try { if (typeof unsubscribe === 'function') unsubscribe(); } catch { /* */ }
    },
    clearInterval() {
      api.stop();
    },
    get interval() { return interval; },
    get timer() { return timer; },
    get busy() { return busy; },
    get dirty() { return dirty; },
  };
  return api;
}

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
  if (!warnedComposerFlags && (
    process.env.PALANTIR_MEMORY_COMPOSER === '0'
    || process.env.PALANTIR_MEMORY_COMPOSER_SHADOW === '1'
  )) {
    warnedComposerFlags = true;
    console.warn('[composer] PALANTIR_MEMORY_COMPOSER/SHADOW flags are no longer read — composer is always active.');
  }

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
  // ML PR1: L1 project memory index (CRUD + FTS5 retrieve + revision +
  // injection ledger). Constructed here (after db + eventBus) so it can be
  // injected into conversationService below for user-payload memory prepend.
  const memoryService = createMemoryService(db, eventBus);
  // L2 P1b: user-scoped Master memory (governed top-K retrieval). Injected into
  // conversationService for Top-manager user-payload prepend + the /api/master-memory router.
  const masterMemoryService = createMasterMemoryService(db, eventBus);
  const masterMemoryDecayScheduler = startMasterMemoryDecayScheduler({ masterMemoryService });
  const xprojectScanEnabled = options.masterMemoryXprojectScanEnabled
    ?? (process.env.PALANTIR_MASTER_XPROJECT_SCAN !== '0');
  const masterMemoryXprojectScanner = xprojectScanEnabled
    ? startMasterMemoryXprojectScanner({
      masterMemoryService,
      eventBus,
      intervalMs: options.masterMemoryXprojectScanIntervalMs ?? process.env.PALANTIR_MASTER_XPROJECT_SCAN_INTERVAL_MS,
      debounceMs: options.masterMemoryXprojectScanDebounceMs ?? process.env.PALANTIR_MASTER_XPROJECT_SCAN_DEBOUNCE_MS,
      limit: options.masterMemoryXprojectScanLimit,
    })
    : {
      disabled: true,
      tick: () => null,
      schedule: () => false,
      stop() {},
      clearInterval() {},
      get interval() { return null; },
      get timer() { return null; },
    };
  // Phase 10B: Worker Preset service. Created before taskService so that
  // taskService can validate preferred_preset_id at the service layer (D2c).
  const presetService = createPresetService(db, {
    pluginsRoot: options.pluginsRoot,
  });
  const taskService = createTaskService(db, eventBus, {
    // D2c: defense-in-depth — service-layer preset existence check
    validatePresetId: (id) => presetService.getPreset(id),
  });
  const runService = createRunService(db, eventBus);
  const agentProfileService = createAgentProfileService(db);
  // Operator Profile entity (PF-1): stored {name, persona, capabilities} bundle
  // resolved by the specialist (PF-3). Plain config CRUD — always constructed +
  // mounted (harmless without the specialist flag; only invocation is gated).
  const operatorProfileService = createOperatorProfileService(db);
  const skillPackService = createSkillPackService(db);
  const registryService = createRegistryService();
  // M3: UI-driven mcp_server_templates CRUD. Constructed AFTER
  // skillPackService so the default templates seed has already run —
  // otherwise `svc.listTemplates()` on a fresh DB would be empty until
  // the first request hit skillPackService. Must also come AFTER
  // presetService so tests can delete-then-verify reference behavior.
  const mcpTemplateService = createMcpTemplateService(db);

  // Execution engines
  const executionEngine = options.executionEngine || createExecutionEngine();
  const streamJsonEngine = createStreamJsonEngine({ runService, eventBus });
  const managerAdapterFactory = createManagerAdapterFactory({ streamJsonEngine, runService });
  const worktreeService = createWorktreeService();
  const harvestService = createHarvestService({
    runService,
    worktreeService,
    projectService,
    eventBus,
    testRunner: options.harvestTestRunner,
  });
  const webhookService = createWebhookService({
    eventBus,
    runService,
    // ?? (not ||) so an explicit options.webhookUrl='' can disable webhooks
    // even when PALANTIR_WEBHOOK_URL is set in the environment (test isolation).
    webhookUrl: options.webhookUrl ?? process.env.PALANTIR_WEBHOOK_URL,
    allowPrivate: options.webhookAllowPrivate ?? (process.env.PALANTIR_WEBHOOK_ALLOW_PRIVATE === '1'),
    postImpl: options.webhookPostImpl,
    now: options.webhookNow,
    logger: options.webhookLogger,
  });
  const lifecycleService = createLifecycleService({
    runService, taskService, agentProfileService, projectService,
    executionEngine, streamJsonEngine, worktreeService, harvestService, eventBus,
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
  // Operator specialist (P-B2c). Declared here — before pmSpawnService / manager
  // router — so their prompt builders can lazily read ACTUAL route availability
  // via the isSpecialistAvailable thunk (mid-turn delegation MD-1). The service
  // itself is constructed below (it needs memoryComposer). null = flag off OR no
  // backend → route unmounted → managers must NOT be told to call it.
  let specialistService = null;
  const isSpecialistAvailable = () => specialistService !== null;
  const pmSpawnService = createPmSpawnService({
    runService,
    managerRegistry,
    managerAdapterFactory,
    projectService,
    projectBriefService,
    agentProfileService,
    skillPackService,
    isSpecialistAvailable,
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
  const memoryComposer = createMemoryComposer({
    retrievers: {
      workspace: buildWorkspaceAdapter(memoryService),
      user: buildUserAdapter(masterMemoryService),
    },
  });
  const compositionLedger = createCompositionLedger(db);
  const conversationService = createConversationService({
    runService,
    managerRegistry,
    managerAdapterFactory,
    lifecycleService,
    pmSpawnService,
    memoryService, // ML PR1: user-payload Learned Memory injection (PM slots)
    masterMemoryService, // L2 P1b: user-payload Master memory injection (Top slot)
    memoryMultiOwner: options.memoryMultiOwner ?? (process.env.PALANTIR_MEMORY_MULTI_OWNER === '1'),
    memoryComposer,
    compositionLedger,
    eventBus,
  });
  // v3 Phase 2: whenever a manager slot (top or pm:<projectId>) is cleared
  // — by explicit stop, liveness probe, or rotation — drop any lingering
  // parent-notice queue entries keyed by the dying run id so they cannot
  // be misapplied to some future unrelated run. Codex R1 blocker fix.
  managerRegistry.onSlotCleared(({ runId }) => {
    try { conversationService.clearParentNotices(runId); } catch { /* ignore */ }
  });

  // PM auto-review: harvest is the single completion gate. `run:ended`
  // drives harvest first, and harvest emits exactly one `run:harvested`
  // for each review-target worker run; only then do we notify the PM.
  createPmAutoReview({ eventBus, managerRegistry, conversationService, runService });
  // ML PR2a: R6 environment-fact capture (test_command / node resolution).
  createR6FactCapture({ eventBus, runService, memoryService });
  // ML PR2b: R1b failure->fix pair capture (stages candidates for PR3 distill).
  createR1bCapture({ eventBus, runService, memoryService });
  // ML PR2c: R3 PM verdict capture (coherent task_complete -> candidate).
  createR3Capture({ eventBus, memoryService });

  // ML PR3b: live distiller + periodic scheduler. OFF by default. Gated on
  // PALANTIR_MEMORY_DISTILL=1 AND (an ANTHROPIC_API_KEY for the real model, or
  // an injected distiller for tests). All distill safety (sanitize / clamp /
  // evidence) lives in promoteCandidatesBatchTx, so this only wires a real
  // model + a periodic drain of pending candidates -> active memory.
  let memoryDistillScheduler = null;
  {
    const distillEnabled = options.memoryDistillEnabled ?? (process.env.PALANTIR_MEMORY_DISTILL === '1');
    if (distillEnabled) {
      let distiller = options.distiller || null;
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!distiller && !apiKey) {
        console.warn('[memory-distill] PALANTIR_MEMORY_DISTILL=1 but no ANTHROPIC_API_KEY and no injected distiller — scheduler NOT started');
      } else {
        try {
          if (!distiller) distiller = createLiveDistiller({ apiKey });
          const distillService = createMemoryDistillService({ memoryService, distiller });
          const intervalMs = Number.parseInt(process.env.PALANTIR_MEMORY_DISTILL_INTERVAL_MS, 10) || 300000;
          memoryDistillScheduler = distillService.startScheduler({ intervalMs });
          console.log(`[memory-distill] scheduler started (interval ${intervalMs}ms, distiller=${distiller.name})`);
        } catch (err) {
          console.warn(`[memory-distill] failed to start scheduler: ${err && err.message}`);
        }
      }
    }
  }

  // Operator P-B2c-2: folder-less specialist spawn service. flag-gated + UNROUTED
  // (no HTTP route/actor-identity until B2c-3/4) → flag-off is behavior-identical.
  // Constructed only when PALANTIR_OPERATOR_SPECIALIST=1 + a backend is available.
  // Receives a NARROW trace interface (getRun/addRunEvent) — NOT the full
  // runService — so it cannot create durable runs, register a registry slot, or
  // write the composition ledger (ephemeral by construction, Codex P-B2c-2 Q6).
  {
    const specialistEnabled = options.operatorSpecialistEnabled ?? (process.env.PALANTIR_OPERATOR_SPECIALIST === '1');
    if (specialistEnabled) {
      let backend = options.specialistBackend || null;
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!backend && !apiKey && !options.specialistCallModel) {
        console.warn('[operator-specialist] PALANTIR_OPERATOR_SPECIALIST=1 but no ANTHROPIC_API_KEY / injected backend — specialist disabled');
      } else {
        try {
          if (!backend) backend = createSpecialistBackend({ apiKey, callModel: options.specialistCallModel, registryService, agentProfileService });
          specialistService = createSpecialistService({
            specialistBackend: backend,
            memoryComposer,
            trace: {
              getRun: (id) => runService.getRun(id),
              addRunEvent: (runId, type, payload) => runService.addRunEvent(runId, type, payload),
            },
          });
          console.log('[operator-specialist] specialist service constructed (unrouted)');
        } catch (err) {
          console.warn(`[operator-specialist] failed to construct: ${err && err.message}`);
        }
      }
    }
  }

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
    // All assets self-hosted: vendor/ has Preact/HTM/marked/DOMPurify,
    // vendor/fonts/ has Inter woff2. No external CDN dependencies.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self'"
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
  app.use('/api/projects', createMemoryRouter({ memoryService, projectService })); // ML PR1: GET /:projectId/memory
  app.use('/api/master-memory', createMasterMemoryRouter({ masterMemoryService })); // L2 P1b: GET / + POST /remember
  app.use('/api/tasks', createTasksRouter({ taskService, lifecycleService, presetService }));
  app.use('/api/runs', createRunsRouter({ runService, lifecycleService, executionEngine, streamJsonEngine, conversationService, presetService, mcpTemplateService, projectService, taskService }));
  // PR18: tests can pass options.authResolverOpts (e.g. a fake `hasKeychain`)
  // so /api/agents and /api/manager preflights are deterministic across CI
  // hosts that may or may not have a Claude keychain item. Production callers
  // leave this empty and get the real keychain probe.
  const authResolverOpts = options.authResolverOpts || {};
  app.use('/api/agents', createAgentsRouter({ agentProfileService, providerRegistry, authResolverOpts }));
  app.use('/api/events', createEventsRouter({ eventBus }));
  app.use('/api/claude-sessions', createClaudeSessionsRouter());
  app.use('/api/manager', createManagerRouter({ runService, streamJsonEngine, managerAdapterFactory, managerRegistry, conversationService, eventBus, projectService, projectBriefService, agentProfileService, pmCleanupService, pmSpawnService, skillPackService, isSpecialistAvailable, authResolverOpts }));
  app.use('/api/conversations', createConversationsRouter({ conversationService, runService }));
  // Operator P-B2c-3: specialist entry. Mounted ONLY when the feature is enabled
  // (specialistService is null unless PALANTIR_OPERATOR_SPECIALIST=1 + a backend),
  // so the route does not exist when off (behavior-preserving).
  if (specialistService) {
    app.use('/api/operator/specialist', createOperatorSpecialistRouter({ specialistService, runService, operatorProfileService }));
  }
  app.use('/api/dispatch-audit', createDispatchAuditRouter({ reconciliationService }));
  app.use('/api/router', createRouterRouter({ routerService }));
  app.use('/api/worker-presets', createWorkerPresetsRouter({ presetService }));
  app.use('/api/operator/profiles', createOperatorProfilesRouter({ operatorProfileService }));
  // R4b: profile-scoped R4 remember (POST /:id/memory/remember). Separate router on
  // the same base — the CRUD router's /:id routes don't match the deeper path.
  app.use('/api/operator/profiles', createOperatorProfileMemoryRouter({ memoryService, operatorProfileService }));
  app.use('/api/mcp-server-templates', createMcpTemplatesRouter({ mcpTemplateService }));
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
  // Boot drain restarts queued worker runs after a restart. Skip under the
  // node test runner by default: createApp() in tests would otherwise claim
  // (→running) any seeded queued rows, hit the P0 spawn guard, and corrupt
  // them to failed/retry. Tests that exercise boot drain pass forceBootDrain.
  const shouldBootDrain = options.forceBootDrain || !process.env.NODE_TEST_CONTEXT;
  if (shouldBootDrain) {
    Promise.resolve(lifecycleService.drainAllQueues())
      .then((started) => {
        if (started > 0) {
          console.log(`[app] Started ${started} queued worker run(s)`);
        }
      })
      .catch((err) => {
        console.warn(`[app] Queue boot drain failed: ${err.message}`);
      });
  }
  const staleWorktrees = lifecycleService.cleanupStaleTerminalWorktrees();
  if (staleWorktrees > 0) {
    console.log(`[app] Cleaned ${staleWorktrees} stale terminal worktree(s)`);
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
  // R2-B.2: tests need direct service access to craft run rows with a
  // worktree_path without spinning up the full tmux/adapter pipeline.
  // Production callers have no reason to touch these, but exposing them
  // is harmless — they're the same instances already wired into the
  // routes.
  // Phase 0b (S9): composer failure counter. Subscribes to memory:composer_failed
  // events emitted when compose() returns composition===null inside a dec.compose:true
  // branch. Always active. Never throws.
  const composerFailureCounter = {
    total: 0,
    reset() { this.total = 0; },
  };
  eventBus.subscribe((event) => {
    if (event.channel !== 'memory:composer_failed') return;
    try {
      composerFailureCounter.total++;
    } catch { /* never throws */ }
  });

  app.services = {
    runService,
    taskService,
    projectService,
    presetService,
    agentProfileService,
    lifecycleService,
    harvestService,
    webhookService,
    worktreeService,
    eventBus,
    memoryService, // ML PR1: test seam for seeding L1 memory through the app db
    masterMemoryService, // L2 P1b: test seam for seeding/asserting Master memory
    compositionLedger, // A2-3a: test seam for asserting composition ledger entries
    memoryComposer, // S5-LEDGER: test seam — composer is the sole injection path
    masterMemoryDecayScheduler,
    masterMemoryXprojectScanner,
    composerFailureCounter, // Phase 0b: compose()-returned-null counter (diagnostic seam)
    specialistService, // Operator P-B2c-2: null unless PALANTIR_OPERATOR_SPECIALIST=1 (unrouted)
    operatorProfileService, // Operator Profile entity (PF-1)
    // R2-C.1: manager-summary.test.js needs raw SQL access to fabricate
    // run rows with specific status / cost_usd / backdated created_at
    // (createRun() always stamps status='queued' and cost_usd=0 at now).
    // Keeping the test seam next to the other service handles so future
    // tests don't have to go hunting for a new entry point.
    _rawDb: db,
  };
  // PR5b: app.shutdown is idempotent. A memoized promise means a double call
  // (e.g. SIGINT then SIGTERM, or a test that shuts down twice) returns the same
  // settling promise instead of disposing/closing twice, and _closeDbOnce guards
  // the raw db.close() (Codex SERIOUS — double-call closeDb throws).
  let _shutdownPromise = null;
  let _shuttingDown = false;
  let _dbClosed = false;
  const _closeDbOnce = () => {
    if (_dbClosed) return;
    _dbClosed = true;
    try { closeDb(); } catch (err) { console.warn('[app.shutdown] closeDb:', err && err.message); }
  };
  app.shutdown = () => {
    if (_shutdownPromise) return _shutdownPromise;
    // Guard synchronous re-entry during the dispose sweep (e.g. an adapter's
    // disposeSession() itself calling app.shutdown) so the sweep runs once
    // (Codex PR5b NIT). _closeDbOnce is the second line of defense.
    if (_shuttingDown) return Promise.resolve();
    _shuttingDown = true;
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
    //   2) webhookService.stop() — removes eventBus subscribers before
    //      the db-backed run event writer disappears,
    //   3) master memory schedulers stop before closeDb(),
    //   4) lifecycleService.stopMonitoring() — cancels the health
    //      loop that might otherwise try to act on a closed db,
    //   5) closeDb().
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
    try { webhookService.stop(); } catch { /* ignore */ }
    try { if (masterMemoryXprojectScanner) masterMemoryXprojectScanner.stop(); } catch { /* ignore */ }
    try { if (masterMemoryDecayScheduler) masterMemoryDecayScheduler.stop(); } catch { /* ignore */ }
    try { if (memoryDistillScheduler) memoryDistillScheduler.stop(); } catch { /* ignore */ }
    try { if (specialistService && typeof specialistService.stop === 'function') specialistService.stop(); } catch { /* ignore */ }
    lifecycleService.stopMonitoring();
    // PR5b graceful shutdown: if a distill drain is in flight, close the DB only
    // AFTER it settles so the drain never writes into a closed handle. With no
    // in-flight drain (the common case, incl. every test with the scheduler
    // off) this stays a SYNCHRONOUS close, so existing synchronous
    // app.shutdown() callers are unaffected. Returns a promise only when waiting.
    let inflight = null;
    try {
      inflight = (memoryDistillScheduler && memoryDistillScheduler.awaitDrain) ? memoryDistillScheduler.awaitDrain() : null;
    } catch { inflight = null; }
    if (inflight && typeof inflight.then === 'function') {
      _shutdownPromise = inflight.then(_closeDbOnce, _closeDbOnce);
    } else {
      _closeDbOnce();
      _shutdownPromise = Promise.resolve();
    }
    return _shutdownPromise;
  };

  return app;
}

module.exports = {
  createApp,
  createPmAutoReview,
  createR6FactCapture,
  createR1bCapture,
  createR3Capture,
  startMasterMemoryDecayScheduler,
  startMasterMemoryXprojectScanner,
  buildPmReviewText,
  formatHarvestSummary,
};
