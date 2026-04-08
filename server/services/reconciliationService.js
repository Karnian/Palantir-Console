// server/services/reconciliationService.js
//
// v3 Phase 4: annotate-only reconciliation for PM dispatch claims.
// Spec §9.7 — "PM 응답이 Top에 전달되기 전에 검사하지만 차단하지 않음".
//
// Philosophy (spec §10 risk table + appendix A): hard-gating PM claims
// produces too many false positives in the MVP — the PM can legitimately
// say "task X is done" seconds before lifecycleService reflects the run
// transition in the DB, and blocking on that is worse than annotating.
// Phase 4 therefore ships a purely informational audit trail: every
// claim is recorded, every mismatch gets an `incoherence_flag=1`, and
// the UI is expected to render a badge. A later phase can promote this
// to a hard gate once the false-positive rate is understood.
//
// Two mismatch kinds are detected:
//
//   1. 'pm_hallucination' — the PM asserted a state that contradicts
//      the database at check time. E.g. pmClaim.kind='task_complete'
//      with a task that is still in_progress. This is the canonical
//      "PM drift" scenario.
//
//   2. 'user_intervention_stale' — spec §7 origin: the user talked
//      directly to a worker (or PM) recently, which queued a
//      parent-staleness notice against the PM run id. If the PM then
//      reports a claim WITHOUT having drained that notice yet, its
//      mental model is demonstrably stale. We check this by peeking at
//      the conversationService notice queue for the PM's run id at
//      claim-record time. This check is optional — if the caller did
//      not provide pmRunId or no conversation service is wired, we
//      skip it.
//
// Unknown claim kinds are recorded with incoherence_flag=0 and
// incoherence_kind='unknown_kind' so Phase 5+ can widen the matcher
// without rewriting the audit history.

const crypto = require('node:crypto');

const KNOWN_KINDS = new Set([
  'task_complete',
  'task_in_progress',
  'worker_spawned',
  'worker_running',
  'worker_completed',
  'worker_failed',
]);

function createReconciliationService({
  db,
  runService,
  taskService,
  projectService, // required for envelope/entity ownership binding (codex R1)
  agentProfileService, // optional — used to validate selected_agent_profile_id (codex R5)
  conversationService, // optional — exposes peekParentNotices for staleness check
  logger,
}) {
  const log = logger || ((msg) => console.log(`[reconciliation] ${msg}`));

  const stmts = {
    insert: db.prepare(`
      INSERT INTO dispatch_audit_log (
        id, project_id, task_id, pm_run_id, selected_agent_profile_id,
        rationale, pm_claim, db_truth, incoherence_flag, incoherence_kind,
        created_at
      ) VALUES (
        @id, @project_id, @task_id, @pm_run_id, @selected_agent_profile_id,
        @rationale, @pm_claim, @db_truth, @incoherence_flag, @incoherence_kind,
        @created_at
      )
    `),
    getById: db.prepare('SELECT * FROM dispatch_audit_log WHERE id = ?'),
    listByProject: db.prepare(`
      SELECT * FROM dispatch_audit_log
      WHERE project_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `),
    listAll: db.prepare(`
      SELECT * FROM dispatch_audit_log
      ORDER BY created_at DESC
      LIMIT ?
    `),
    listIncoherentByProject: db.prepare(`
      SELECT * FROM dispatch_audit_log
      WHERE project_id = ? AND incoherence_flag = 1
      ORDER BY created_at DESC
      LIMIT ?
    `),
    listIncoherentAll: db.prepare(`
      SELECT * FROM dispatch_audit_log
      WHERE incoherence_flag = 1
      ORDER BY created_at DESC
      LIMIT ?
    `),
  };

  // Given a structured pmClaim and the ambient DB state, return
  // { truth, incoherent, kind }. `truth` is a JSON-serializable snapshot
  // of what the DB shows right now (for audit history). `incoherent` is
  // a boolean. `kind` describes the mismatch flavor ('pm_hallucination',
  // 'user_intervention_stale', 'unknown_kind', or null).
  function evaluateClaim({ pmClaim, pmRunId }) {
    if (!pmClaim || typeof pmClaim !== 'object' || !pmClaim.kind) {
      return {
        truth: { error: 'invalid_claim_shape' },
        incoherent: false,
        kind: 'invalid_claim',
      };
    }
    if (!KNOWN_KINDS.has(pmClaim.kind)) {
      return {
        truth: { note: 'unknown_claim_kind', kind: pmClaim.kind },
        incoherent: false,
        kind: 'unknown_kind',
      };
    }

    // --- Task claims ---
    if (pmClaim.kind === 'task_complete' || pmClaim.kind === 'task_in_progress') {
      const taskId = pmClaim.task_id;
      if (!taskId) {
        return { truth: { error: 'task_id_required' }, incoherent: true, kind: 'invalid_claim' };
      }
      let task;
      try { task = taskService.getTask(taskId); } catch { task = null; }
      if (!task) {
        return {
          truth: { task_id: taskId, exists: false },
          incoherent: true,
          kind: 'pm_hallucination',
        };
      }
      const truth = { task_id: taskId, status: task.status };
      const expectedDone = pmClaim.kind === 'task_complete' && task.status === 'done';
      const expectedInProgress = pmClaim.kind === 'task_in_progress' && task.status === 'in_progress';
      const coherent = expectedDone || expectedInProgress;
      return {
        truth,
        incoherent: !coherent,
        kind: coherent ? null : 'pm_hallucination',
      };
    }

    // --- Worker run claims ---
    if (pmClaim.kind === 'worker_spawned'
        || pmClaim.kind === 'worker_running'
        || pmClaim.kind === 'worker_completed'
        || pmClaim.kind === 'worker_failed') {
      const runId = pmClaim.run_id;
      if (!runId) {
        return { truth: { error: 'run_id_required' }, incoherent: true, kind: 'invalid_claim' };
      }
      let run;
      try { run = runService.getRun(runId); } catch { run = null; }
      if (!run) {
        return {
          truth: { run_id: runId, exists: false },
          incoherent: true,
          kind: 'pm_hallucination',
        };
      }
      // Codex R3 blocker: a worker_* claim against a MANAGER run (Top
      // or PM) is always a hallucination — managers are not workers,
      // regardless of status. Previously the status check alone allowed
      // a PM to successfully claim "worker_running" on another manager
      // run, which is exactly the kind of drift this service is meant
      // to detect.
      if (run.is_manager) {
        return {
          truth: { run_id: runId, status: run.status, is_manager: 1, note: 'run is a manager, not a worker' },
          incoherent: true,
          kind: 'pm_hallucination',
        };
      }
      const truth = { run_id: runId, status: run.status, is_manager: run.is_manager };
      const expected = {
        worker_spawned: ['queued', 'running'],
        worker_running: ['running'],
        worker_completed: ['completed'],
        worker_failed: ['failed'],
      }[pmClaim.kind];
      const coherent = expected.includes(run.status);
      return {
        truth,
        incoherent: !coherent,
        kind: coherent ? null : 'pm_hallucination',
      };
    }

    return { truth: { note: 'fallthrough' }, incoherent: false, kind: 'unknown_kind' };
  }

  // Secondary check: at claim-record time, is there a queued
  // parent-staleness notice against this PM run id? If yes, the PM has
  // definitely not yet processed the user's most recent intervention
  // and any claim it makes is based on a stale mental model.
  function checkUserInterventionStale(pmRunId) {
    if (!pmRunId || !conversationService || typeof conversationService.peekParentNotices !== 'function') {
      return false;
    }
    try {
      const pending = conversationService.peekParentNotices(pmRunId);
      return Array.isArray(pending) && pending.length > 0;
    } catch {
      return false;
    }
  }

  // Envelope/entity binding (codex R1 blocker fix).
  //
  // Before this guard the service happily stored `projectId=alpha` with
  // a `pmClaim.task_id=T` that actually belonged to project beta — or
  // worse, an envelope `taskId=A` paired with `pmClaim.task_id=B`.
  // Both corrupt per-project audit history and badge counts. The fix:
  //
  //   * project must exist.
  //   * If the claim references a task_id/run_id, the envelope's
  //     taskId/pmRunId (when provided) MUST match the claim's id.
  //   * The referenced entity MUST belong to the envelope's project.
  //     A mismatch is a hard input error (400), not an incoherence
  //     flag — it indicates the caller is misusing the API, not that
  //     the PM is drifting.
  //
  // Missing entities are NOT a hard error here — evaluateClaim flags
  // them as `pm_hallucination` because that IS a legitimate PM drift
  // scenario (PM references a run that never existed).
  function bindEnvelopeToClaim({ projectId, taskId, pmRunId, selectedAgentProfileId, pmClaim }) {
    // Project must exist.
    if (projectService) {
      try { projectService.getProject(projectId); }
      catch {
        const err = new Error(`project not found: ${projectId}`);
        err.httpStatus = 404;
        throw err;
      }
    }

    // Envelope taskId (codex R5 blocker fix) — when provided it must:
    //   * exist in the DB
    //   * belong to this project
    // The earlier "taskId ≠ pm_claim.task_id" check still runs below.
    if (taskId) {
      let envTask = null;
      try { envTask = taskService.getTask(taskId); } catch { envTask = null; }
      if (!envTask) {
        const err = new Error(`envelope task_id not found: ${taskId}`);
        err.httpStatus = 400;
        throw err;
      }
      if (envTask.project_id && envTask.project_id !== projectId) {
        const err = new Error(
          `envelope task_id ${taskId} belongs to project ${envTask.project_id}, not ${projectId}`
        );
        err.httpStatus = 400;
        throw err;
      }
    }

    // Envelope selected_agent_profile_id (codex R5 blocker fix) — if
    // provided it must resolve to an existing profile. We don't require
    // a specific adapter type here; Phase 4 only guarantees the row
    // can't cite a fictional agent.
    if (selectedAgentProfileId && agentProfileService) {
      let profile = null;
      try { profile = agentProfileService.getProfile(selectedAgentProfileId); }
      catch { profile = null; }
      if (!profile) {
        const err = new Error(`selected_agent_profile_id not found: ${selectedAgentProfileId}`);
        err.httpStatus = 400;
        throw err;
      }
    }

    // Envelope vs claim id consistency.
    //
    // NOTE: pmRunId (envelope) and pmClaim.run_id are DIFFERENT identities:
    //   - pmRunId is the PM's own manager run id — used by evaluateClaim's
    //     staleness check (peekParentNotices keyed by the PM run).
    //   - pmClaim.run_id is the WORKER run id the claim is about.
    // They are never required to be equal. The only binding we enforce on
    // the run side is via the referenced worker's project ownership,
    // handled below in the run-bound claim block.
    if (pmClaim.task_id && taskId && pmClaim.task_id !== taskId) {
      const err = new Error(
        `envelope task_id='${taskId}' does not match pm_claim.task_id='${pmClaim.task_id}'`
      );
      err.httpStatus = 400;
      throw err;
    }

    // pmRunId envelope binding (codex R4 blocker fix).
    //
    // pmRunId drives the staleness-attribution check via
    // peekParentNotices(pmRunId). Without this guard a caller could
    // submit a foreign PM's run id, a Top run id, or a random string,
    // and get a forged user_intervention_stale flag (or the opposite —
    // suppress a real staleness signal) attributed to this project.
    // We therefore require the envelope pm_run_id — when present — to:
    //   * resolve to an existing run,
    //   * be a manager run (is_manager=1),
    //   * be in the PM layer (manager_layer='pm'),
    //   * own the same project via its conversation_id = 'pm:<projectId>'.
    if (pmRunId) {
      let pmRun = null;
      try { pmRun = runService.getRun(pmRunId); } catch { pmRun = null; }
      if (!pmRun) {
        const err = new Error(`pm_run_id not found: ${pmRunId}`);
        err.httpStatus = 400;
        throw err;
      }
      if (!pmRun.is_manager) {
        const err = new Error(`pm_run_id ${pmRunId} is not a manager run`);
        err.httpStatus = 400;
        throw err;
      }
      if (pmRun.manager_layer !== 'pm') {
        const err = new Error(`pm_run_id ${pmRunId} is layer='${pmRun.manager_layer}', expected 'pm'`);
        err.httpStatus = 400;
        throw err;
      }
      const expectedConvId = `pm:${projectId}`;
      if (pmRun.conversation_id !== expectedConvId) {
        const err = new Error(
          `pm_run_id ${pmRunId} belongs to ${pmRun.conversation_id}, not ${expectedConvId}`
        );
        err.httpStatus = 400;
        throw err;
      }
    }

    // Task-bound claim: if the task exists, it must belong to this project.
    if (pmClaim.task_id) {
      let task = null;
      try { task = taskService.getTask(pmClaim.task_id); } catch { task = null; }
      if (task && task.project_id && task.project_id !== projectId) {
        const err = new Error(
          `task ${pmClaim.task_id} belongs to project ${task.project_id}, not ${projectId}`
        );
        err.httpStatus = 400;
        throw err;
      }
    }
    // Cross-bind: if both envelope taskId and pmClaim.run_id are
    // provided, require that the referenced worker run actually belongs
    // to the envelope task. Prevents "real run in project A with fake
    // sibling task id" forgery (codex R5 blocker). The individual task
    // validation above already caught cross-project taskId; this catch
    // closes the intra-project sibling case.
    if (taskId && pmClaim.run_id) {
      let crossRun = null;
      try { crossRun = runService.getRun(pmClaim.run_id); } catch { crossRun = null; }
      if (crossRun && crossRun.task_id && crossRun.task_id !== taskId) {
        const err = new Error(
          `pm_claim.run_id ${pmClaim.run_id} belongs to task ${crossRun.task_id}, not envelope task_id ${taskId}`
        );
        err.httpStatus = 400;
        throw err;
      }
    }

    // Run-bound claim: if the run exists, validate project ownership.
    // Worker runs are tied to a project only transitively via their
    // task. A run with no task_id is either a manager run (is_manager=1)
    // or an orphan — both are invalid targets for a worker_* claim and
    // are rejected here so the cross-project contamination door stays
    // shut. The "manager run" coherence check still runs in
    // evaluateClaim; this binding check exists to reject envelope-level
    // mismatches (input errors) before evaluation.
    if (pmClaim.run_id) {
      let run = null;
      try { run = runService.getRun(pmClaim.run_id); } catch { run = null; }
      if (run) {
        if (!run.task_id) {
          // Orphan or manager — cannot be bound to a project via task.
          // Manager runs are rejected here because the worker_* claim
          // contract assumes a worker run id. A manager run with no task
          // has no project anchor, so we can't verify ownership.
          if (run.is_manager) {
            const err = new Error(
              `run ${pmClaim.run_id} is a manager run, not a worker run — worker_* claims require a worker run id`
            );
            err.httpStatus = 400;
            throw err;
          }
          // Non-manager run with no task: truly orphan. Reject.
          const err = new Error(
            `run ${pmClaim.run_id} has no task and cannot be bound to a project`
          );
          err.httpStatus = 400;
          throw err;
        }
        let runTask = null;
        try { runTask = taskService.getTask(run.task_id); } catch { runTask = null; }
        if (runTask && runTask.project_id && runTask.project_id !== projectId) {
          const err = new Error(
            `run ${pmClaim.run_id} belongs to project ${runTask.project_id}, not ${projectId}`
          );
          err.httpStatus = 400;
          throw err;
        }
      }
    }
  }

  // Primary entry point. Records one claim row and returns the row.
  // Callers (routes/dispatchAudit.js, or future PM-response parsers)
  // provide a structured pmClaim. Phase 4 is annotate-only — this
  // function NEVER throws on incoherence; it just sets the flag.
  // It DOES throw on envelope/entity binding violations (see
  // bindEnvelopeToClaim) because those are hard input errors, not PM
  // drift signals.
  function recordClaim({
    projectId,
    taskId = null,
    pmRunId = null,
    selectedAgentProfileId = null,
    rationale = null,
    pmClaim,
  }) {
    if (!projectId) {
      const err = new Error('projectId is required');
      err.httpStatus = 400;
      throw err;
    }
    if (!pmClaim || typeof pmClaim !== 'object') {
      const err = new Error('pmClaim object is required');
      err.httpStatus = 400;
      throw err;
    }

    // Enforce envelope/entity binding BEFORE evaluation so cross-project
    // contamination can never reach the audit log (codex R1 blocker).
    bindEnvelopeToClaim({
      projectId,
      taskId,
      pmRunId,
      selectedAgentProfileId,
      pmClaim,
    });

    // Primary evaluation against DB truth.
    const evaluation = evaluateClaim({ pmClaim, pmRunId });

    // Secondary evaluation: user intervention staleness. Only overrides
    // the incoherence kind if the primary evaluation found the claim
    // coherent — a "pm_hallucination" label is more informative than
    // "user_intervention_stale" when both fire, because the former says
    // what the PM got wrong concretely.
    let incoherent = evaluation.incoherent;
    let incoherenceKind = evaluation.kind;
    if (!incoherent && checkUserInterventionStale(pmRunId)) {
      incoherent = true;
      incoherenceKind = 'user_intervention_stale';
    }

    const id = `audit_${crypto.randomUUID().slice(0, 12)}`;
    const nowMs = Date.now();
    const row = {
      id,
      project_id: projectId,
      task_id: taskId,
      pm_run_id: pmRunId,
      selected_agent_profile_id: selectedAgentProfileId,
      rationale: rationale || null,
      pm_claim: JSON.stringify(pmClaim),
      db_truth: JSON.stringify(evaluation.truth),
      incoherence_flag: incoherent ? 1 : 0,
      incoherence_kind: incoherenceKind || null,
      created_at: nowMs,
    };
    stmts.insert.run(row);
    if (incoherent) {
      log(`incoherent claim project=${projectId} kind=${incoherenceKind} claim=${JSON.stringify(pmClaim)}`);
    }
    return stmts.getById.get(id);
  }

  function listClaims({ projectId, incoherentOnly = false, limit = 100 } = {}) {
    const capped = Math.min(Math.max(1, Number(limit) || 100), 500);
    if (projectId && incoherentOnly) return stmts.listIncoherentByProject.all(projectId, capped);
    if (projectId) return stmts.listByProject.all(projectId, capped);
    if (incoherentOnly) return stmts.listIncoherentAll.all(capped);
    return stmts.listAll.all(capped);
  }

  return { recordClaim, listClaims, evaluateClaim };
}

module.exports = { createReconciliationService };
