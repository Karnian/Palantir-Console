const express = require('express');
const path = require('path');
const os = require('os');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const packageJson = require('../package.json');
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
const { createNodeService } = require('./services/nodeService');
const { createNodeBindingValidator } = require('./services/nodeBindingValidator');
const { createRepoPreflightService } = require('./services/repoPreflightService');
const { createNodeUsageService } = require('./services/nodeUsageService');
const { createNodeSummaryService } = require('./services/nodeSummaryService');
const { createNodeHeartbeatService } = require('./services/nodeHeartbeatService');
const { createTaskService } = require('./services/taskService');
const { createRunService } = require('./services/runService');
const { createAgentProfileService } = require('./services/agentProfileService');
const { createSessionsRouter } = require('./routes/sessions');
const { createTrashRouter } = require('./routes/trash');
const { createFsRouter } = require('./routes/fs');
const { createUsageRouter } = require('./routes/usage');
const { createProjectsRouter } = require('./routes/projects');
const { createNodesRouter } = require('./routes/nodes');
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
const { createGoalDeliveryService } = require('./services/goalDeliveryService'); // G4b
const { createGoalJudge } = require('./services/goalJudgeService'); // G3c
const { createLocalNodeExecutor } = require('./services/nodeExecutor');
const { createWebhookService } = require('./services/webhookService');
const { createLifecycleService } = require('./services/lifecycleService');
const { createProjectMaterializationService } = require('./services/projectMaterializationService');
const { createAuthMiddleware } = require('./middleware/auth');
const { errorHandler } = require('./middleware/errorHandler');
const { createManagerRouter } = require('./routes/manager');
const { createConversationsRouter } = require('./routes/conversations');
const { createManagerRegistry } = require('./services/managerRegistry');
const { createConversationService } = require('./services/conversationService');
const {
  conversationIdForProject,
  parseProjectConversationId,
  createOperatorConversationIdResolver,
} = require('./utils/conversationId'); // PM→Operator Phase 0
const { createOperatorCleanupService } = require('./services/operatorCleanupService');
const { createOperatorSpawnService } = require('./services/operatorSpawnService');
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
const { createModelPolicyService } = require('./services/modelPolicyService');
const { createModelPoliciesRouter } = require('./routes/modelPolicies');
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
const { createOperatorInstanceService } = require('./services/operatorInstanceService');
const { createOperatorIdentityLifecycleService } = require('./services/operatorIdentityLifecycleService');
const { createVerifyCheckService } = require('./services/verifyCheckService');
const { createVerifyChecksRouter } = require('./routes/verifyChecks');
const { createOperatorInstancesRouter } = require('./routes/operatorInstances');

function readGitSha() {
  try {
    const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    });
    if (result.error || result.status !== 0) return null;
    const sha = String(result.stdout || '').trim();
    return sha || null;
  } catch (err) {
    return null;
  }
}

const BOOT_INFO = Object.freeze({
  packageVersion: packageJson.version || null,
  gitSha: readGitSha(),
  startedAt: new Date().toISOString(),
  bootId: randomUUID(),
});
// A2-3a: PM-slot composer+ledger cutover (flag-gated, default OFF)
const {
  createMemoryComposer,
  buildWorkspaceAdapter,
  buildUserAdapter,
  buildProfileAdapter,
  buildWatchlistAdapter,
} = require('./services/memoryComposer');
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
  // G2 §5f/§5h: surface the Gate 1 acceptance result. gate vs advisory reflects
  // the check's provenance (§5k-3). Since G3, the verdict (from acceptance) drives
  // the task transition; a goal run's full Gate 2 block is buildGoalReviewText.
  const acc = harvestSummary.acceptance;
  if (acc) {
    const accStatus = acc.status === 'skipped'
      ? `SKIPPED (${acc.reason || 'runner_unavailable'})`
      : (acc.passed === true ? 'PASS' : acc.passed === false ? 'FAIL' : 'RAN');
    lines.push(`  [gate1] acceptance: ${accStatus} — ${acc.kind || '?'} check (${acc.gate ? 'gate' : 'advisory'})`);
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

// G4a §5h: the structured Gate 2 review block for a goal run. Built from the
// PERSISTED run state (verdict/reason/acceptance/goal_report) re-read AFTER the
// verdict settled, plus the task's acceptance_criteria + budget. Surfaces the
// verdict, attempt n/max, Gate 1 acceptance (PASS/FAIL/SKIPPED/NOT DEFINED), the
// worker report, and verdict-specific guidance (exhausted → escalation).
const GOAL_REVIEWABLE_VERDICTS = new Set(['gate2', 'exhausted', 'error']);

function buildGoalReviewText({ run, task }) {
  const verdict = run.goal_verdict || 'gate2';
  const attempt = Number(run.retry_count || 0) + 1;
  const max = Number(task && task.goal_max_attempts) || attempt;
  const lines = [
    '[system: goal 태스크 Gate 2 리뷰 필요]',
    `Goal worker run ${run.id} — task ${run.task_id}`,
    `  verdict: ${verdict.toUpperCase()}${run.goal_verdict_reason ? ` (${run.goal_verdict_reason})` : ''}`,
    `  attempt: ${attempt}/${max}`,
  ];

  let acc = null;
  try { acc = run.acceptance_json ? JSON.parse(run.acceptance_json) : null; } catch { acc = null; }
  if (acc && typeof acc === 'object') {
    const accStatus = acc.status === 'skipped'
      ? `SKIPPED (${acc.reason || 'runner_unavailable'})`
      : (acc.passed === true ? 'PASS' : acc.passed === false ? 'FAIL' : 'RAN');
    lines.push(`  gate1 acceptance: ${accStatus} — ${acc.kind || '?'} check [${acc.name || 'unnamed'}] (${acc.gate ? 'gate' : 'advisory'})`);
    if (acc.passed === false && acc.output_tail) {
      lines.push('  gate1 output:');
      lines.push(indentBlock(acc.output_tail));
    }
  } else {
    lines.push('  gate1 acceptance: NOT DEFINED (검증 check 미할당 — 의미 판단만)');
  }

  if (task && task.acceptance_criteria) {
    lines.push('  acceptance criteria:');
    lines.push(indentBlock(task.acceptance_criteria));
  }

  let report = null;
  try { report = run.goal_report ? JSON.parse(run.goal_report) : null; } catch { report = null; }
  if (report && typeof report === 'object') {
    if (report.summary) { lines.push('  worker report:'); lines.push(indentBlock(String(report.summary))); }
    if (Array.isArray(report.blockers) && report.blockers.length) {
      lines.push(`  worker blockers: ${report.blockers.slice(0, 5).map((b) => String(b)).join('; ')}`);
    }
  }

  lines.push('');
  if (verdict === 'exhausted') {
    lines.push(`예산 소진 (${attempt}/${max} attempts) — 자율 반복이 검증을 통과하지 못했습니다. 사용자 에스컬레이션을 권고합니다.`);
    lines.push('진단 후: 기준/검증을 조정해 재위임하거나 사용자에게 에스컬레이션하세요.');
  } else if (verdict === 'error') {
    lines.push(`verdict=error (${run.goal_verdict_reason || 'internal'}) — 인프라/소스 이상으로 재시도하지 않았습니다. 원인을 진단하세요 (자동 재시도 아님).`);
  } else {
    lines.push('Gate 1 (기계 검증) 통과 또는 미해당 — 이제 의미 판단(Gate 2)이 필요합니다.');
    lines.push('- 목표/기준을 충족하면 task 상태를 "done" 으로 전환하세요 (→ 산출물 전달).');
    lines.push('- 부족하면 corrective 지시로 새 워커를 /execute 하세요 (goal 루프가 다음 attempt 를 돕니다).');
  }
  return lines.filter((l) => l !== undefined && l !== null).join('\n');
}

function createPmAutoReview({
  eventBus,
  managerRegistry,
  conversationService,
  runService,
  taskService = null,
  autoReviewMax = AUTO_REVIEW_MAX,
  defer = setImmediate,
  logger = console,
} = {}) {
  const autoReviewCounts = new Map(); // "receiverInstanceId:taskId" or "project:<projectId>:taskId" -> count
  const autoReviewCountSlots = new Map(); // countKey -> slotKey (W-P4 R1: lets a Top slot clear reset Top-fallback counts)

  function resolveOperatorConversation(conversationId) {
    if (runService && typeof runService.resolveOperatorConversationId === 'function') {
      try {
        return runService.resolveOperatorConversationId(conversationId) || null;
      } catch {
        return null;
      }
    }
    const parsed = parseProjectConversationId(conversationId);
    if (!parsed) return null;
    return {
      instanceId: null,
      legacyProjectId: parsed.projectId,
      legacySlotId: conversationIdForProject(parsed.projectId),
      instanceConversationId: null,
      primaryProjectId: null,
    };
  }

  function countKeyForReceiver(receiverKey, taskId) {
    return `${receiverKey}:${taskId || '_'}`;
  }

  function deleteCountKeysForSlot(slotKey) {
    // W-P4 R1 (Codex): Top-fallback counts are keyed by receiver ("project:.."/instance)
    // but their SLOT is 'top' — an operator-based reset can never reach them, so a
    // cleared/replaced Top would leave the breaker permanently tripped.
    for (const [key, recordedSlotKey] of autoReviewCountSlots.entries()) {
      if (recordedSlotKey === slotKey) {
        autoReviewCounts.delete(key);
        autoReviewCountSlots.delete(key);
      }
    }
  }

  function deleteCountKeysForReceiver(receiverKey) {
    if (!receiverKey) return;
    for (const key of autoReviewCounts.keys()) {
      if (key.startsWith(`${receiverKey}:`)) { autoReviewCounts.delete(key); autoReviewCountSlots.delete(key); }
    }
  }

  function topReceiver(run, receiverInstanceId = null) {
    const projectId = run?.project_id || null;
    const receiverKey = receiverInstanceId || (projectId ? `project:${projectId}` : 'project:_');
    return {
      slotKey: 'top',
      receiverInstanceId,
      receiverKey,
      countKey: countKeyForReceiver(receiverKey, run?.task_id),
      source: receiverInstanceId ? 'attributed_instance_no_primary' : 'top_fallback',
    };
  }

  function receiverFromResolved(run, resolved, source) {
    if (!resolved?.instanceId || !resolved?.primaryProjectId || !resolved?.instanceConversationId) {
      return null;
    }
    return {
      slotKey: resolved.instanceConversationId,
      receiverInstanceId: resolved.instanceId,
      receiverKey: resolved.instanceId,
      countKey: countKeyForReceiver(resolved.instanceId, run?.task_id),
      source,
    };
  }

  function resolveReviewReceiver(run) {
    if (!run?.project_id) return null;

    if (run.operator_instance_id) {
      const resolved = resolveOperatorConversation(conversationIdForProject(run.operator_instance_id));
      return receiverFromResolved(run, resolved, 'attributed_instance')
        || topReceiver(run, run.operator_instance_id);
    }

    const resolved = resolveOperatorConversation(conversationIdForProject(run.project_id));
    return receiverFromResolved(run, resolved, 'primary_instance')
      || topReceiver(run);
  }

  managerRegistry.onSlotCleared(({ conversationId }) => {
    if (conversationId === 'top') deleteCountKeysForSlot('top');
    const resolved = resolveOperatorConversation(conversationId);
    if (resolved?.instanceId) deleteCountKeysForReceiver(resolved.instanceId);
    if (resolved?.legacyProjectId) deleteCountKeysForReceiver(`project:${resolved.legacyProjectId}`);
    if (resolved?.primaryProjectId) deleteCountKeysForReceiver(`project:${resolved.primaryProjectId}`);
    const parsed = parseProjectConversationId(conversationId); // operator:<projectId>
    if (parsed?.projectId) deleteCountKeysForReceiver(`project:${parsed.projectId}`);
  });

  function retryRootId(run) {
    return run?.retry_root_run_id || run?.id || null;
  }

  function hasHigherRetryAttempt(run) {
    if (!runService || typeof runService.listRuns !== 'function' || !run?.task_id) {
      return false;
    }
    try {
      const currentRetryCount = Number(run.retry_count || 0);
      const currentRootId = retryRootId(run);
      if (!currentRootId) return false;
      const runs = runService.listRuns({ task_id: run.task_id }) || [];
      return runs.some((candidate) => (
        candidate
        && candidate.id !== run.id
        && !candidate.is_manager
        && ['queued', 'running'].includes(candidate.status)
        && retryRootId(candidate) === currentRootId
        && Number(candidate.retry_count || 0) > currentRetryCount
      ));
    } catch {
      return false;
    }
  }

  // Core review dispatch: reserve the per-task circuit breaker synchronously (so
  // two events for the same task can't both slip past it), then defer the send.
  // buildText(count) produces the message. onSent() runs after a SUCCESSFUL send
  // (e.g. write a durable marker); onSettled() runs in the defer finally on BOTH
  // paths (e.g. release an in-flight claim). Returns 'dispatched' | 'no_manager'
  // | 'breaker_max'. On failure the breaker reservation is rolled back.
  function dispatchReview({ run, receiver, buildText, onSent = null, onSettled = null }) {
    const pmRunId = managerRegistry.getActiveRunId(receiver.slotKey);
    if (!pmRunId) return 'no_manager';

    const countKey = receiver.countKey;
    const count = autoReviewCounts.get(countKey) || 0;
    if (count >= autoReviewMax) {
      logger.warn(`[pm-auto-review] Circuit breaker: ${countKey} hit ${autoReviewMax} reviews; skipping. User intervention needed.`);
      return 'breaker_max';
    }

    // Roll back the reservation: decrement (not set-to-count) so a concurrent
    // reservation isn't clobbered; delete at zero to restore the pristine state.
    // A rolled-back reservation means a later re-drive never wedges the breaker.
    const rollbackBreaker = () => {
      const next = Math.max(0, (autoReviewCounts.get(countKey) || 1) - 1);
      if (next === 0) { autoReviewCounts.delete(countKey); autoReviewCountSlots.delete(countKey); }
      else autoReviewCounts.set(countKey, next);
    };

    autoReviewCounts.set(countKey, count + 1);
    autoReviewCountSlots.set(countKey, receiver.slotKey);

    // codex BLOCKER-1: build the text AFTER reserving but roll the reservation
    // back if construction throws (malformed acceptance/report), else each
    // re-drive re-reserves toward breaker_max and permanently suppresses review.
    let reviewText;
    try {
      reviewText = buildText(count);
    } catch (err) {
      rollbackBreaker();
      try { logger.warn(`[pm-auto-review] Review text build failed for ${receiver.slotKey}: ${err.message}`); } catch { /* logger must not break */ }
      return 'build_failed';
    }

    // codex R2: guard the defer SCHEDULING itself — if an injected defer throws
    // synchronously after the reservation, roll it back (else re-drives accumulate
    // toward breaker_max). The caller's finally releases the claim (result !==
    // 'dispatched'), so nothing leaks.
    try {
      defer(() => {
        // codex BLOCKER-2: onSettled (the in-flight claim release) MUST run on every
        // path — a throwing injected logger inside the catch must not skip it. So the
        // whole body is in try/finally and every external call is individually guarded.
        try {
          let sent = false;
          try {
            conversationService.sendMessage(receiver.slotKey, {
              text: reviewText,
              codebaseProjectId: run.project_id || null,
              turnMode: 'auto_review', // A2a §5.0: auto-review is its own turnMode (B1 injects the worker codebase workspace only)
              source: 'auto_review', // F-1: batch review turn → codex standard tier (never 2.5×)
            });
            sent = true;
          } catch (err) {
            rollbackBreaker();
            try { logger.warn(`[pm-auto-review] Failed to send review to ${receiver.slotKey}: ${err.message}`); } catch { /* logger must not break */ }
          }
          if (sent && onSent) { try { onSent(); } catch { /* marker best-effort */ } }
        } finally {
          if (onSettled) { try { onSettled(); } catch { /* release best-effort */ } }
        }
      });
    } catch (err) {
      rollbackBreaker();
      try { logger.warn(`[pm-auto-review] Review defer scheduling failed for ${receiver.slotKey}: ${err.message}`); } catch { /* logger must not break */ }
      return 'defer_failed';
    }
    return 'dispatched';
  }

  function sendPmReview({ run, harvestSummary }) {
    if (!run || run.is_manager) return false;
    // G4a: goal-active runs review on their VERDICT (gate2/exhausted/error), NOT
    // on raw harvest — a 'retry' verdict must not trigger an Operator review.
    // dispatchGate2Review owns that path.
    if (run.goal_active) return false;
    const projectId = run.project_id;
    if (!projectId) return false;
    const receiver = resolveReviewReceiver(run);
    if (!receiver?.slotKey) return false;

    const status = harvestSummary?.status || run.status;
    if (status === 'failed' && hasHigherRetryAttempt(run)) {
      try {
        if (runService && typeof runService.addRunEvent === 'function') {
          runService.addRunEvent(run.id, 'pm_review:suppressed', JSON.stringify({
            reason: 'retry_pending',
            retry_root_run_id: retryRootId(run),
            receiver_instance_id: receiver.receiverInstanceId || null,
            receiver_slot: receiver.slotKey,
          }));
        }
      } catch { /* ignore observability failures */ }
      return false;
    }

    const result = dispatchReview({
      run,
      receiver,
      buildText: (count) => buildPmReviewText({ run, harvestSummary, count, autoReviewMax }),
    });
    return result === 'dispatched';
  }

  // G4a §5h: durable, at-least-once Gate 2 review for a goal run. Guards:
  //   1. a durable `goal:gate2_review_sent` run-event marker → already reviewed;
  //   2. an in-memory `_reviewInFlight` claim (synchronous check-add BEFORE any
  //      defer) → closes the in-process double-dispatch race between the
  //      goal:verdict subscriber and reviewSweep (single Node process, so no
  //      cross-process lease is needed).
  // The marker is written ONLY after a successful send; the claim is released in
  // a finally on every path. A review lost to a crash (no marker) is re-driven by
  // the periodic reviewSweep — at-least-once, never permanently lost.
  const _reviewInFlight = new Set();

  function hasGate2ReviewMarker(runId) {
    try {
      return (runService.getRunEvents(runId) || []).some((e) => e.event_type === 'goal:gate2_review_sent');
    } catch { return false; }
  }

  function dispatchGate2Review(runId) {
    let run = null;
    try { run = runService.getRun(runId); } catch { return false; }
    if (!run || run.is_manager || !run.goal_active || !run.task_id || !run.project_id) return false;
    if (!GOAL_REVIEWABLE_VERDICTS.has(run.goal_verdict)) return false; // retry → no review
    if (_reviewInFlight.has(run.id)) return false;      // in-process claim held
    if (hasGate2ReviewMarker(run.id)) return false;     // durable: already reviewed
    const receiver = resolveReviewReceiver(run);
    if (!receiver?.slotKey) return false;
    let task = null;
    try { task = taskService && taskService.getTask(run.task_id); } catch { task = null; }
    if (!task) return false;

    _reviewInFlight.add(run.id); // claim BEFORE reserve/defer (closes the race)
    let deferred = false;
    try {
      const result = dispatchReview({
        run,
        receiver,
        buildText: () => buildGoalReviewText({ run, task }),
        onSent: () => {
          try {
            runService.addRunEvent(run.id, 'goal:gate2_review_sent', JSON.stringify({
              verdict: run.goal_verdict,
              receiver_slot: receiver.slotKey,
            }));
          } catch { /* marker best-effort — a miss just costs one duplicate re-drive */ }
        },
        onSettled: () => { _reviewInFlight.delete(run.id); },
      });
      deferred = (result === 'dispatched');
      return deferred;
    } finally {
      // No deferred send scheduled (no manager / breaker max / threw) → release the
      // claim now so a later sweep can re-drive. When deferred, onSettled releases.
      if (!deferred) _reviewInFlight.delete(run.id);
    }
  }

  // At-least-once re-drive: dispatch any reviewable goal run still missing its
  // durable marker. Runs at boot AND on a mandatory periodic timer (a runtime
  // send-failure released its claim + rolled back the breaker, so this re-drives
  // it within one interval — boot-only recovery would leave it stuck until
  // restart). Never throws.
  function reviewSweep() {
    let ids = [];
    try { ids = runService.listReviewableGoalRunsWithoutReview(); } catch { return; }
    for (const id of ids) {
      try { dispatchGate2Review(id); } catch (err) { logger.warn(`[gate2-review] sweep failed run=${id}: ${err.message}`); }
    }
  }

  eventBus.subscribe((event) => {
    if (event.channel !== 'run:harvested') return;
    sendPmReview({
      run: event.data?.run,
      harvestSummary: event.data?.summary,
    });
  });

  // G4a: goal verdicts drive the Gate 2 review (low-latency path; the periodic
  // reviewSweep is the durable backstop).
  eventBus.subscribe((event) => {
    if (event.channel !== 'goal:verdict') return;
    const runId = event.data?.run_id;
    if (runId) dispatchGate2Review(runId);
  });

  return { sendPmReview, dispatchGate2Review, reviewSweep, autoReviewCounts };
}

// ML PR2a (R6): capture deterministic environment facts from worker harvest.
// Subscribes to run:harvested independently of PM review, re-reads the
// harvest:test event from run_events (run:harvested.summary omits
// command/node_major), and upserts env.test_command / env.node_resolution
// facts. Never throws — annotate-only, like harvest itself. Excludes
// run-specific noise (pass/fail/exit/duration/output_tail/diff/worktree).
function isStableEnvFact(factKey, meta) {
  if (factKey === 'env.test_command') return true;
  if (factKey === 'env.node_resolution') return !!(meta && meta.node_source === 'project');
  return false;
}

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
    if (payload.command && isStableEnvFact('env.test_command')) {
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
    // env.node_resolution — only a project declaration is stable across
    // operators/runs/nodes/sources. Other resolutions remain episodic in the
    // harvest:test event and are not promoted to workspace memory.
    if (payload.node_major != null) {
      if (isStableEnvFact('env.node_resolution', { node_source: payload.node_source })) {
        try {
          memoryService.upsertFact({
            projectId: run.project_id,
            factKey: 'env.node_resolution',
            content: `Project requires Node major ${payload.node_major}`,
            evidenceJson,
            importance: 5,
          });
        } catch (err) { logger.warn(`[r6-fact] node_resolution run=${run.id}: ${err.message}`); }
      } else {
        logger.warn(`[r6-fact] node_resolution admission rejected (episodic) node_source=${String(payload.node_source)} run=${run.id}`);
      }
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

  // G5 §5i: the goal Gate 1 acceptance as an R1b signal. Only a human-provenance
  // (gate=true) check that actually RAN with a boolean result is definitive
  // (§5k-3) — advisory / skipped / malformed acceptance is NOT a signal.
  function acceptanceResult(events) {
    // Scan ALL harvest:acceptance events and return the first VALID gating one,
    // skipping any malformed/advisory/skipped entry — a non-gating acceptance
    // preceding a valid gating one must NOT mask the real signal (codex BLOCKER).
    for (const a of events) {
      if (a.event_type !== 'harvest:acceptance') continue;
      try {
        const p = JSON.parse(a.payload_json || '{}');
        if (p.gate === true && p.status === 'ran' && typeof p.passed === 'boolean') {
          return { passed: p.passed, eventId: a.id };
        }
      } catch { /* skip malformed, keep scanning */ }
    }
    return null;
  }

  // G5 §5i: pick the R1b signal by the run's AUTHORITATIVE goal_active (not event
  // presence — codex BLOCKER). A goal run's ONLY signal is its human-gate
  // acceptance; it NEVER falls back to the worker-controlled test command (a
  // missing/advisory/skipped acceptance → no signal → no forged goal pair). A
  // non-goal run uses harvest:test exactly as before (byte-identical).
  function getRunResult(events, run) {
    if (run && run.goal_active) {
      const a = acceptanceResult(events);
      return a ? { passed: a.passed, source: 'acceptance' } : null;
    }
    const t = testResult(events);
    return t ? { passed: t.passed, source: 'test' } : null;
  }

  function capture(run) {
    if (!run || run.is_manager || !run.project_id || !run.task_id) return;

    // Order ALL same-task runs by rowid (_seq, exposed by getByTask) = true
    // creation order. We inspect the IMMEDIATELY preceding RUN (not just the
    // preceding signalled run): an intervening run without a signal means Y is
    // not a direct fix of X, so we must NOT skip it (Codex cross-review BLOCKER —
    // false fix-pairs from skipped no-signal runs). Both X and Y are classified
    // from the AUTHORITATIVE listRuns rows (goal_active), not the emitted object.
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
    const yRun = ordered[yPos];
    const prevRun = ordered[yPos - 1];

    let yEvents;
    try { yEvents = runService.getRunEvents(run.id) || []; } catch { return; }
    const y = getRunResult(yEvents, yRun);
    if (!y || !y.passed) return; // the fix run must itself be a PASS

    let prevEvents;
    try { prevEvents = runService.getRunEvents(prevRun.id) || []; } catch { return; }
    const x = getRunResult(prevEvents, prevRun);
    if (!x || x.passed !== false) return; // immediate prev must be a FAIL
    if (x.source !== y.source) return; // coherent signal (no mixed test/acceptance pair)

    // R1b fix pair: prev (FAIL) -> run (PASS). Capture the fix diff stat (the
    // "what changed") but NEVER the test/acceptance output (secret risk) — the
    // rawJson is an explicit projection, not a payload spread.
    const diffEvent = yEvents.find((e) => e.event_type === 'harvest:diff');
    let diffStat = null;
    if (diffEvent) {
      try { diffStat = JSON.parse(diffEvent.payload_json || '{}').stat || null; } catch { /* */ }
    }
    const rawJson = JSON.stringify({
      schema_version: 1,
      rule: 'R1b',
      task_id: run.task_id,
      fail_run: { id: prevRun.id },
      fix_run: { id: run.id, diff_stat: diffStat ? String(diffStat).slice(0, 500) : null },
      selection: 'immediately_preceding_fail',
      signal: y.source, // 'acceptance' (goal Gate 1) | 'test' (project test)
    });
    try {
      memoryService.createCandidate({
        projectId: run.project_id,
        rule: 'R1b',
        rawJson,
        dedupKey: `r1b:${run.task_id}:${prevRun.id}:${run.id}`,
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
  app.bootInfo = BOOT_INFO;
  // supertest 7.2.2 calls app.listen(0) and then app.address() on the original
  // app object. Express apps do not expose server.address(), so keep a narrow
  // bridge here; production listen() still returns the real http.Server.
  const expressListen = app.listen.bind(app);
  let lastServer = null;
  app.listen = (...args) => {
    lastServer = expressListen(...args);
    return lastServer;
  };
  app.address = () => (lastServer ? lastServer.address() : null);
  // PR1: tests pass `authToken` explicitly to avoid mutating
  // process.env.PALANTIR_TOKEN (which would leak into sibling test files
  // running in parallel via `node --test`). Production code path leaves
  // options.authToken undefined and falls back to process.env.
  const authToken = options.authToken !== undefined
    ? options.authToken
    : process.env.PALANTIR_TOKEN;
  // G2 §6: surface the goal-mode activation state at boot. When goal mode is
  // requested without a separated PALANTIR_PM_TOKEN it is DISABLED (fail-closed);
  // warn loudly so the operator knows why goal features are inert.
  try {
    const { goalModeDiagnostic } = require('./services/goalMode');
    const diag = goalModeDiagnostic();
    if (diag) (diag.active ? console.log : console.warn)(diag.message);
  } catch { /* diagnostic only */ }

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
  const nodeExecutor = createLocalNodeExecutor();

  // Existing services (filesystem-based)
  const storage = createStorageContext({ storageRoot, fsRoot });
  const sessionService = createSessionService(storage);
  const trashService = createTrashService(storage);
  const messageService = createMessageService(storage);
  const fsService = createFsService(storage, { nodeExecutor });
  const opencodeService = createOpencodeService({ opencodeBin });
  const codexService = createCodexService({
    codexBin,
    codexHome,
    timeoutMs: codexStatusTimeoutMs
  });
  const providerRegistry = createProviderRegistry({ codexService, opencodeAuthPath });

  // New services (SQLite-based)
  const nodeService = createNodeService(db, { localExecutor: nodeExecutor });
  const nodeBindingValidator = options.nodeBindingValidator || createNodeBindingValidator({ nodeService });
  const repoPreflightService = options.repoPreflightService || createRepoPreflightService({ nodeService });
  const nodeUsageService = options.nodeUsageService || createNodeUsageService({
    nodeService,
    providerRegistry,
    probeTimeoutMs: options.nodeUsageProbeTimeoutMs,
  });
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
  const resolveOperatorConversationId = createOperatorConversationIdResolver(db);
  const agentProfileService = createAgentProfileService(db);
  const nodeSummaryService = options.nodeSummaryService || createNodeSummaryService({
    nodeService,
    runService,
    agentProfileService,
  });
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
  const modelPolicyService = createModelPolicyService(db);

  // Execution engines
  const executionEngine = options.executionEngine || createExecutionEngine();
  const streamJsonEngine = createStreamJsonEngine({ runService, eventBus });
  // Fleet P3: remote executors implement this worker channel natively.
  nodeExecutor.attachEngines({ executionEngine, streamJsonEngine });
  const managerAdapterFactory = createManagerAdapterFactory({ streamJsonEngine, runService });
  const worktreeService = createWorktreeService({ nodeExecutor });
  const projectMaterializationService = createProjectMaterializationService({
    runService,
    projectService,
    nodeService,
    eventBus,
  });
  // G2: verify_checks (Gate 1) service — created before harvestService so the
  // harvest pipeline can run the assigned Gate 1 check.
  const verifyCheckService = createVerifyCheckService(db);
  // G2 §6: single goal-feature gate (injectable for tests). Threaded into every
  // goal surface so they activate in lock-step with the PALANTIR_TOKEN scrub.
  const goalFeatureActive = options.goalFeatureActive || require('./services/goalMode').goalFeatureActive;
  // G3c §5k-4: Gate 1.5 judge — OFF by default. Injected for tests; else built
  // only when goal mode + PALANTIR_GOAL_JUDGE=1 + ANTHROPIC_API_KEY. When null,
  // harvest's judge stage is a no-op (and no run is goal_judge_active anyway,
  // since spawn gates that on goalJudgeActive()).
  let goalJudgeService = options.goalJudgeService || null;
  if (!goalJudgeService && require('./services/goalMode').goalJudgeActive()) {
    const judgeApiKey = process.env.ANTHROPIC_API_KEY;
    if (judgeApiKey) {
      try { goalJudgeService = createGoalJudge({ apiKey: judgeApiKey }); }
      catch (err) { console.warn(`[goal-judge] failed to create: ${err.message}`); }
    } else {
      console.warn('[goal-judge] PALANTIR_GOAL_JUDGE=1 but no ANTHROPIC_API_KEY and no injected judge — Gate 1.5 disabled');
    }
  }
  const harvestService = createHarvestService({
    runService,
    worktreeService,
    projectService,
    eventBus,
    testRunner: options.harvestTestRunner,
    nodeExecutor,
    nodeService,
    // G2 §5f: Gate 1 acceptance deps. taskService resolves the run's assigned
    // verify_check_id; verifyCheckService loads the check + provenance. The goal
    // gate is per-run (run.goal_active) — harvest does not re-check goal mode.
    taskService,
    verifyCheckService,
    goalJudgeService, // G3c §5k-4
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
  // v3 Phase 1.5: shared manager registry. Created BEFORE lifecycleService
  // (Codex A1c) so dispatch attribution can check live slot occupancy — a stale
  // 'running' PM run whose conversation slot was replaced must not lend
  // attribution. It only depends on runService.
  const managerRegistry = createManagerRegistry({ runService });
  const lifecycleService = createLifecycleService({
    runService, taskService, agentProfileService, projectService,
    managerRegistry, // Codex A1c: live slot occupancy for dispatch attribution
    executionEngine, streamJsonEngine, worktreeService, harvestService, eventBus,
    skillPackService,
    nodeService,
    projectMaterializationService,
    // Share the app-wide executor (P2 remote rollout swaps this per node —
    // a default-constructed local executor here would be a forgotten seam).
    nodeExecutor,
    presetService,
    claudeVersionResolver: options.claudeVersionResolver,
    // Phase 10D: isolated-preset auth materialization honors the same
    // `authResolverOpts` tests already pass for manager-path preflight.
    authResolverOpts: options.authResolverOpts || {},
    goalFeatureActive, // G2 §6
  });

  // G4b §5j: goal 산출물 전달. Fires when a goal task is marked 'done' (the
  // accepted gate2 attempt's branch is promoted to palantir/goal/<taskId>, or the
  // deliverable bundle is recorded). annotate-only / never-throws — runs AFTER the
  // done transition so it can never block or revert it. task:updated fires on
  // every task edit; deliver() itself no-ops except the goal→done case (+ its own
  // CAS idempotency), so subscribing to the broad channel is safe.
  const goalDeliveryService = createGoalDeliveryService({
    runService, taskService, projectService, worktreeService, goalFeatureActive,
  });
  eventBus.subscribe((event) => {
    if (event.channel !== 'task:updated') return;
    const task = event.data && event.data.task;
    if (!task || !task.goal_enabled || task.status !== 'done') return;
    Promise.resolve(goalDeliveryService.deliver(task.id)).catch((err) => {
      console.warn(`[app] Goal delivery failed for task ${task.id}: ${err && err.message}`);
    });
  });

  // v3 Phase 1.5: conversationService owns the parent-notice queue and the
  // unified send/resolve routing used by both the new /api/conversations router
  // and the legacy /api/manager/* routes. (managerRegistry is created above,
  // before lifecycleService — Codex A1c.)
  const operatorInstanceService = createOperatorInstanceService(db, {
    runService,
    managerRegistry,
  });
  // v3 Phase 3a: lazy Operator spawn + single-owner cleanup. operatorSpawnService is
  // wired into conversationService below so a first message to
  // Operator slot creation starts the Operator run on demand. operatorCleanupService is the
  // single termination owner for /reset, delete-project, and future
  // pm_enabled=false toggles (spec §5 책임 분담표).
  // Operator specialist (P-B2c). Declared here — before operatorSpawnService / manager
  // router — so their prompt builders can lazily read ACTUAL route availability
  // via the isSpecialistAvailable thunk (mid-turn delegation MD-1). The service
  // itself is constructed below (it needs memoryComposer). null = flag off OR no
  // backend → route unmounted → managers must NOT be told to call it.
  let specialistService = null;
  const isSpecialistAvailable = () => specialistService !== null;
  const operatorSpawnService = createOperatorSpawnService({
    runService,
    managerRegistry,
    managerAdapterFactory,
    projectService,
    projectBriefService,
    agentProfileService,
    skillPackService,
    nodeService,
    projectMaterializationService,
    modelPolicyService,
    isSpecialistAvailable,
    authResolverOpts: options.authResolverOpts || {},
  });
  const operatorCleanupService = createOperatorCleanupService({
    projectService,
    projectBriefService,
    managerRegistry,
    managerAdapterFactory,
    runService,
    eventBus,
    operatorInstanceService,
  });
  const operatorIdentityLifecycleService = createOperatorIdentityLifecycleService({
    operatorProfileService,
    operatorInstanceService,
    operatorCleanupService,
  });
  const memoryComposer = createMemoryComposer({
    retrievers: {
      workspace: buildWorkspaceAdapter(memoryService),
      user: buildUserAdapter(masterMemoryService),
      profile: buildProfileAdapter(memoryService), // R4c: operator profile owner
      watchlist: buildWatchlistAdapter(operatorInstanceService),
    },
  });
  const compositionLedger = createCompositionLedger(db);
  const conversationService = createConversationService({
    runService,
    managerRegistry,
    managerAdapterFactory,
    lifecycleService,
    operatorSpawnService,
    projectService, // A2b-2: per-turn codebase context block (name/directory of a non-primary turn codebase)
    projectBriefService, // A2b-2: brief summary in the ## Turn Codebase block
    memoryService, // ML PR1: user-payload Learned Memory injection (Operator slots)
    masterMemoryService, // L2 P1b: user-payload Master memory injection (Top slot)
    memoryMultiOwner: options.memoryMultiOwner ?? (process.env.PALANTIR_MEMORY_MULTI_OWNER === '1'),
    memoryComposer,
    compositionLedger,
    eventBus,
  });
  // v3 Phase 2+: whenever a manager slot (top or Operator) is cleared
  // — by explicit stop, liveness probe, or rotation — drop any lingering
  // parent-notice queue entries keyed by the dying run id so they cannot
  // be misapplied to some future unrelated run. Codex R1 blocker fix.
  managerRegistry.onSlotCleared(({ runId }) => {
    try { conversationService.clearParentNotices(runId); } catch { /* ignore */ }
  });

  // PM auto-review: harvest is the single completion gate. `run:ended`
  // drives harvest first, and harvest emits exactly one `run:harvested`
  // for each review-target worker run; only then do we notify the PM.
  const pmAutoReview = createPmAutoReview({ eventBus, managerRegistry, conversationService, runService, taskService });
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

  let nodeHeartbeatService = null;
  {
    const heartbeatEnabled = options.fleetHeartbeatEnabled ?? (process.env.PALANTIR_FLEET_HEARTBEAT === '1');
    if (heartbeatEnabled) {
      try {
        const intervalMs = options.fleetHeartbeatIntervalMs
          ?? (Number.parseInt(process.env.PALANTIR_FLEET_HEARTBEAT_INTERVAL_MS, 10) || 30000);
        nodeHeartbeatService = createNodeHeartbeatService({
          nodeService,
          intervalMs,
          onNodeRecovered: (nodeId) => lifecycleService.scheduleDrainForNode(nodeId),
          onReachableFlip: ({ nodeId, from, to }) => {
            eventBus.emit('node:status', {
              node_id: nodeId,
              from_reachable: from,
              to_reachable: to,
              at: new Date().toISOString(),
            });
          },
        });
        nodeHeartbeatService.start();
        console.log(`[node-heartbeat] scheduler started (interval ${intervalMs}ms)`);
      } catch (err) {
        console.warn(`[node-heartbeat] failed to start scheduler: ${err && err.message}`);
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
  const routerService = createRouterService({ projectService, operatorInstanceService });

  const reconciliationService = createReconciliationService({
    db,
    runService,
    taskService,
    projectService,
    agentProfileService,
    conversationService,
    managerRegistry, // Codex A1b: live slot occupancy check for pm_run attribution
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
    res.json({
      status: 'ok',
      version: '2.0.0',
      packageVersion: BOOT_INFO.packageVersion,
      gitSha: BOOT_INFO.gitSha,
      startedAt: BOOT_INFO.startedAt,
      bootId: BOOT_INFO.bootId,
    });
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
  app.use('/api/projects', createProjectsRouter({ projectService, taskService, runService, projectBriefService, operatorCleanupService, operatorInstanceService, nodeBindingValidator, lifecycleService, repoPreflightService }));
  app.use('/api/operator-instances', createOperatorInstancesRouter({ operatorInstanceService, operatorIdentityLifecycleService }));
  app.use('/api/nodes', createNodesRouter({ nodeService, nodeUsageService, nodeSummaryService, lifecycleService }));
  app.use('/api/projects', createMemoryRouter({ memoryService, projectService })); // ML PR1: GET /:projectId/memory
  app.use('/api/master-memory', createMasterMemoryRouter({ masterMemoryService })); // L2 P1b: GET / + POST /remember
  app.use('/api/tasks', createTasksRouter({ taskService, lifecycleService, presetService, goalDeliveryService, runService, verifyCheckService }));
  app.use('/api/runs', createRunsRouter({ runService, lifecycleService, executionEngine, streamJsonEngine, conversationService, presetService, mcpTemplateService, projectService, taskService, nodeExecutor }));
  // PR18: tests can pass options.authResolverOpts (e.g. a fake `hasKeychain`)
  // so /api/agents and /api/manager preflights are deterministic across CI
  // hosts that may or may not have a Claude keychain item. Production callers
  // leave this empty and get the real keychain probe.
  const authResolverOpts = options.authResolverOpts || {};
  app.use('/api/agents', createAgentsRouter({ agentProfileService, providerRegistry, authResolverOpts }));
  app.use('/api/events', createEventsRouter({ eventBus }));
  app.use('/api/claude-sessions', createClaudeSessionsRouter());
  app.use('/api/manager', createManagerRouter({ runService, streamJsonEngine, managerAdapterFactory, managerRegistry, conversationService, eventBus, projectService, projectBriefService, agentProfileService, operatorCleanupService, operatorSpawnService, skillPackService, nodeService, operatorInstanceService, modelPolicyService, isSpecialistAvailable, authResolverOpts }));
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
  app.use('/api/verify-checks', createVerifyChecksRouter({ verifyCheckService, taskService, goalFeatureActive }));
  app.use('/api/operator/profiles', createOperatorProfilesRouter({ operatorProfileService, operatorIdentityLifecycleService }));
  // R4b: profile-scoped R4 remember (POST /:id/memory/remember). Separate router on
  // the same base — the CRUD router's /:id routes don't match the deeper path.
  app.use('/api/operator/profiles', createOperatorProfileMemoryRouter({ memoryService, operatorProfileService }));
  app.use('/api/mcp-server-templates', createMcpTemplatesRouter({ mcpTemplateService }));
  app.use('/api/model-policies', createModelPoliciesRouter({ modelPolicyService }));
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
  Promise.resolve(recovered)
    .then((sessions) => {
      if (sessions.length > 0) {
        console.log(`[app] Recovered ${sessions.length} orphan session(s)`);
      }
    })
    .catch((err) => {
      console.warn(`[app] Orphan session recovery failed: ${err.message}`);
    });
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
  // G3: sweep goal verdicts BEFORE stale-worktree cleanup — settle any terminal
  // goal run that crashed mid-harvest (no verdict) + reconcile verdicted ones to
  // redrive undelivered outbox effects (goal:verdict/exhausted/error) and repair
  // missed retry-child wakeups. No-op when no goal runs exist. Gated with boot
  // drain so the node test runner doesn't settle/spawn seeded rows.
  if (shouldBootDrain && typeof lifecycleService.sweepGoalVerdicts === 'function') {
    try {
      const { swept, reconciled } = lifecycleService.sweepGoalVerdicts();
      if (swept > 0 || reconciled > 0) {
        console.log(`[app] Goal verdict sweep: settled ${swept}, reconciled ${reconciled}`);
      }
    } catch (err) {
      console.warn(`[app] Goal verdict sweep failed: ${err.message}`);
    }
  }
  // G2b §5k-1: boot re-harvest of retained 'captured' remote deliverable
  // workspaces (a transient bundle failure kept the workspace instead of losing
  // the artifact). Re-attempts the bundle WITHOUT re-review; on success bundles +
  // reclaims the remote workspace. Gated + fire-and-forget (never blocks boot).
  if (shouldBootDrain && harvestService && typeof harvestService.reharvestRemoteDeliverable === 'function') {
    try {
      const captured = runService.listCapturedDeliverableRuns();
      if (captured.length > 0) {
        console.log(`[app] Re-harvesting ${captured.length} retained deliverable workspace(s)`);
        for (const r of captured) {
          Promise.resolve(harvestService.reharvestRemoteDeliverable(r)).catch((err) => {
            console.warn(`[app] Deliverable re-harvest failed for run ${r.id}: ${err.message}`);
          });
        }
      }
    } catch (err) { console.warn(`[app] Deliverable re-harvest scan failed: ${err.message}`); }
  }
  // G4a: Gate 2 review re-drive. Boot once + a MANDATORY periodic timer so a
  // runtime send-failure (marker absent, claim released) is re-dispatched within
  // one interval — boot-only recovery would leave it stuck until restart (codex
  // plan-review BLOCKER). Gated off the node test runner (like the other sweeps);
  // tests drive pmAutoReview.reviewSweep() directly. Timer is unref'd + cleared in
  // shutdown.
  // INVARIANT (codex diff-review SERIOUS): Palantir Console runs as a SINGLE
  // server process. The _reviewInFlight claim + this scheduler are per-process;
  // two live createApp() instances on the same DB could each pass their own Set
  // and double-send before either marker is written. Running two writers against
  // one DB is unsupported — the durable marker still bounds it to at-most one
  // duplicate. Revisit if this ever runs multi-process/clustered.
  let gate2ReviewSweepTimer = null;
  if (shouldBootDrain && pmAutoReview && typeof pmAutoReview.reviewSweep === 'function') {
    try { pmAutoReview.reviewSweep(); } catch (err) { console.warn(`[app] Gate 2 review boot sweep failed: ${err.message}`); }
    if (!process.env.NODE_TEST_CONTEXT) {
      gate2ReviewSweepTimer = setInterval(() => {
        try { pmAutoReview.reviewSweep(); } catch (err) { console.warn(`[app] Gate 2 review periodic sweep failed: ${err.message}`); }
      }, 60000);
      if (typeof gate2ReviewSweepTimer.unref === 'function') gate2ReviewSweepTimer.unref();
    }
  }
  // P0b-1: cleanupStaleTerminalWorktrees is async now — fire-and-forget with
  // observability (a bare call would compare a Promise to 0 and never log,
  // and a rejection would be unhandled — Codex P0b-1 review, SERIOUS).
  Promise.resolve(lifecycleService.cleanupStaleTerminalWorktrees())
    .then((staleWorktrees) => {
      if (staleWorktrees > 0) {
        console.log(`[app] Cleaned ${staleWorktrees} stale terminal worktree(s)`);
      }
    })
    .catch((err) => {
      console.warn(`[app] Stale terminal worktree cleanup failed: ${err.message}`);
    });
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
    nodeService,
    repoPreflightService,
    agentProfileService,
    nodeSummaryService,
    lifecycleService,
    projectMaterializationService,
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
    operatorInstanceService,
    operatorCleanupService,
    operatorIdentityLifecycleService,
    resolveOperatorConversationId, // W-P2+: instance-aware dual-read resolver (legacy alias + operator:oi_*)
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
    // paths, which are fail-closed (operatorCleanupService re-throws so the
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
    try { if (nodeHeartbeatService) nodeHeartbeatService.stop(); } catch { /* ignore */ }
    try { if (specialistService && typeof specialistService.stop === 'function') specialistService.stop(); } catch { /* ignore */ }
    try { if (gate2ReviewSweepTimer) { clearInterval(gate2ReviewSweepTimer); gate2ReviewSweepTimer = null; } } catch { /* ignore */ }
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
  isStableEnvFact,
  createR1bCapture,
  createR3Capture,
  startMasterMemoryDecayScheduler,
  startMasterMemoryXprojectScanner,
  buildPmReviewText,
  buildGoalReviewText,
  formatHarvestSummary,
};
