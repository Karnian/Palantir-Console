const crypto = require('node:crypto');
const { BadRequestError, NotFoundError } = require('../utils/errors');

const VALID_STATUSES = ['queued', 'running', 'paused', 'needs_input', 'completed', 'failed', 'cancelled', 'stopped'];

// State machine: allowed transitions
const VALID_TRANSITIONS = {
  queued:      ['running', 'cancelled'],
  running:     ['paused', 'needs_input', 'completed', 'failed', 'cancelled', 'stopped'],
  paused:      ['running', 'cancelled', 'stopped'],
  needs_input: ['running', 'cancelled', 'failed', 'stopped'],
  completed:   [],  // terminal
  failed:      ['queued'],  // allow retry
  cancelled:   ['queued'],  // allow retry
  stopped:     ['queued'],  // allow retry — unclean shutdown (server restart, process crash)
};

// PR3a / ADD-1: PM manager runs have no task_id (they're standalone
// conversation slots), so the run row's JOIN-derived project_id is null
// for them. Their project identity is encoded in conversation_id as
// 'pm:<projectId>'. Derive a best-effort project_id for envelope
// emission so clients don't have to re-parse the conversation_id
// themselves. Pure function — safe to call on any run row.
function derivePmProjectId(run) {
  if (!run) return null;
  if (run.project_id) return run.project_id; // JOIN-derived wins
  if (run.manager_layer !== 'pm') return null;
  const cid = run.conversation_id;
  if (typeof cid !== 'string' || !cid.startsWith('pm:')) return null;
  const pid = cid.slice(3);
  return pid || null;
}

function createRunService(db, eventBus) {
  const stmts = {
    getAll: db.prepare(`
      SELECT r.*, ap.name as agent_name, ap.type as agent_type, ap.icon as agent_icon,
             t.title as task_title, t.project_id as project_id, p.name as project_name
      FROM runs r
      LEFT JOIN agent_profiles ap ON r.agent_profile_id = ap.id
      LEFT JOIN tasks t ON r.task_id = t.id
      LEFT JOIN projects p ON t.project_id = p.id
      ORDER BY r.created_at DESC
    `),
    getByTask: db.prepare(`
      SELECT r.*, ap.name as agent_name, ap.type as agent_type, ap.icon as agent_icon,
             t.title as task_title, t.project_id as project_id, p.name as project_name
      FROM runs r
      LEFT JOIN agent_profiles ap ON r.agent_profile_id = ap.id
      LEFT JOIN tasks t ON r.task_id = t.id
      LEFT JOIN projects p ON t.project_id = p.id
      WHERE r.task_id = ?
      ORDER BY r.created_at DESC
    `),
    getByStatus: db.prepare(`
      SELECT r.*, ap.name as agent_name, ap.type as agent_type, ap.icon as agent_icon,
             t.title as task_title, t.project_id as project_id, p.name as project_name
      FROM runs r
      LEFT JOIN agent_profiles ap ON r.agent_profile_id = ap.id
      LEFT JOIN tasks t ON r.task_id = t.id
      LEFT JOIN projects p ON t.project_id = p.id
      WHERE r.status = ?
      ORDER BY r.created_at DESC
    `),
    getById: db.prepare(`
      SELECT r.*, ap.name as agent_name, ap.type as agent_type, ap.icon as agent_icon,
             t.title as task_title, t.project_id as project_id, p.name as project_name
      FROM runs r
      LEFT JOIN agent_profiles ap ON r.agent_profile_id = ap.id
      LEFT JOIN tasks t ON r.task_id = t.id
      LEFT JOIN projects p ON t.project_id = p.id
      WHERE r.id = ?
    `),
    insert: db.prepare(`
      INSERT INTO runs (id, task_id, agent_profile_id, prompt, status, is_manager, parent_run_id, manager_adapter, manager_thread_id, manager_layer, conversation_id)
      VALUES (@id, @task_id, @agent_profile_id, @prompt, @status, @is_manager, @parent_run_id, @manager_adapter, @manager_thread_id, @manager_layer, @conversation_id)
    `),
    updateManagerThread: db.prepare(`
      UPDATE runs SET manager_thread_id = ? WHERE id = ?
    `),
    updateStatus: db.prepare(`
      UPDATE runs SET status = ?, ended_at = CASE WHEN ? IN ('completed','failed','cancelled','stopped') THEN datetime('now') ELSE ended_at END WHERE id = ?
    `),
    updateStarted: db.prepare(`
      UPDATE runs SET status = 'running', started_at = datetime('now'), tmux_session = ?, worktree_path = ?, branch = ? WHERE id = ?
    `),
    updateResult: db.prepare(`
      UPDATE runs SET result_summary = ?, exit_code = ?, input_tokens = ?, output_tokens = ?, cost_usd = ? WHERE id = ?
    `),
    delete: db.prepare('DELETE FROM runs WHERE id = ?'),
    // Events
    insertEvent: db.prepare(`
      INSERT INTO run_events (run_id, event_type, payload_json)
      VALUES (?, ?, ?)
    `),
    getEvents: db.prepare(`
      SELECT * FROM run_events WHERE run_id = ? ORDER BY id ASC LIMIT 1000
    `),
    getEventsAfter: db.prepare(`
      SELECT * FROM run_events WHERE run_id = ? AND id > ? ORDER BY id ASC LIMIT 500
    `),
  };

  function listRuns({ task_id, status } = {}) {
    if (task_id) return stmts.getByTask.all(task_id);
    if (status) return stmts.getByStatus.all(status);
    return stmts.getAll.all();
  }

  function getRun(id) {
    const run = stmts.getById.get(id);
    if (!run) throw new NotFoundError(`Run not found: ${id}`);
    return run;
  }

  function createRun({ task_id, agent_profile_id, prompt, is_manager, parent_run_id, manager_adapter, manager_thread_id, manager_layer, conversation_id }) {
    // task_id and agent_profile_id are required for worker runs, optional for manager
    if (!is_manager && !task_id) throw new BadRequestError('task_id is required');
    if (!is_manager && !agent_profile_id) throw new BadRequestError('agent_profile_id is required');
    const id = is_manager ? `run_mgr_${crypto.randomUUID().slice(0, 8)}` : `run_${crypto.randomUUID().slice(0, 8)}`;

    // v3 Phase 1.5: conversation identity defaults.
    // Manager runs default to layer='top' + conversation_id='top' (the MVP
    // singleton). Worker runs default to conversation_id='worker:<id>'.
    // Callers that spawn a PM (Phase 3a) must pass manager_layer='pm' +
    // conversation_id='pm:<projectId>' explicitly.
    let effectiveLayer = manager_layer || null;
    let effectiveConversationId = conversation_id || null;
    if (is_manager) {
      if (!effectiveLayer) effectiveLayer = 'top';
      if (!effectiveConversationId) effectiveConversationId = effectiveLayer === 'top' ? 'top' : null;
      if (!effectiveConversationId) {
        throw new BadRequestError('conversation_id is required for non-top manager runs');
      }
    } else {
      // Worker
      if (effectiveLayer) {
        throw new BadRequestError('manager_layer must be null for worker runs');
      }
      if (!effectiveConversationId) effectiveConversationId = `worker:${id}`;
    }

    stmts.insert.run({
      id,
      task_id: task_id || null,
      agent_profile_id: agent_profile_id || null,
      prompt: prompt || null,
      status: 'queued',
      is_manager: is_manager ? 1 : 0,
      parent_run_id: parent_run_id || null,
      manager_adapter: manager_adapter || null,
      manager_thread_id: manager_thread_id || null,
      manager_layer: effectiveLayer,
      conversation_id: effectiveConversationId,
    });
    const run = stmts.getById.get(id);
    if (eventBus) {
      // v3 Phase 5: normalize run:status envelope on the initial queued
      // emission too (codex R1 finding). Prior to this, subscribers saw
      // two different shapes on the same channel depending on lifecycle
      // phase — queued events shipped bare `{ run }` while every later
      // transition shipped the full envelope. `from_status` is null for
      // a fresh create because there is literally no prior status (per
      // codex R2: a synthetic empty-string sentinel weakens the state
      // semantics; null is the right "no prior state" contract).
      eventBus.emit('run:status', {
        run,
        from_status: null,
        to_status: run.status,
        reason: 'created',
        task_id: run.task_id || null,
        project_id: derivePmProjectId(run),
      });
    }
    return run;
  }

  function updateManagerThreadId(id, threadId) {
    getRun(id);
    stmts.updateManagerThread.run(threadId || null, id);
    return stmts.getById.get(id);
  }

  function updateRunStatus(id, status, { force = false, reason = null } = {}) {
    if (!VALID_STATUSES.includes(status)) {
      throw new BadRequestError(`Invalid run status: ${status}`);
    }
    const current = getRun(id);
    // Enforce state machine unless forced (internal lifecycle use)
    if (!force) {
      const allowed = VALID_TRANSITIONS[current.status] || [];
      if (!allowed.includes(status)) {
        throw new BadRequestError(
          `Cannot transition run from '${current.status}' to '${status}'. Allowed: ${allowed.join(', ') || 'none (terminal state)'}`
        );
      }
    }
    const fromStatus = current.status;
    stmts.updateStatus.run(status, status, id);
    const run = stmts.getById.get(id);
    addRunEvent(id, `status:${status}`, reason ? JSON.stringify({ reason }) : null);
    if (eventBus) {
      // v3 Phase 5 semantic event fields (spec §9.8):
      //   from_status / to_status — the transition, not just the
      //     terminal state. A client that missed the previous status
      //     can still react correctly (e.g., "just became failed" vs
      //     "was already failed, refresh").
      //   reason — why this transition happened (idle_timeout, codex-
      //     exit-error, user-stop, etc.). Null when no one supplied it.
      //   task_id / project_id — surfaced at the envelope level so a
      //     client can filter / route without having to follow the
      //     run→task→project join itself. These are already present on
      //     the `run` object (the JOIN in getById) but the old
      //     payload only shipped the full row, forcing every subscriber
      //     to re-derive them. Hoisting lets clients write dumber
      //     filters and matches the spec exactly.
      eventBus.emit('run:status', {
        run,
        from_status: fromStatus,
        to_status: status,
        reason: reason || null,
        task_id: run.task_id || null,
        project_id: derivePmProjectId(run),
      });
    }

    // Emit run:ended for terminal states so lifecycleService can sync task status
    if (['completed', 'failed', 'cancelled', 'stopped'].includes(status) && eventBus) {
      eventBus.emit('run:ended', {
        run,
        from_status: fromStatus,
        to_status: status,
        reason: reason || null,
        task_id: run.task_id || null,
        project_id: derivePmProjectId(run),
      });
    }

    return run;
  }

  function markRunStarted(id, { tmux_session, worktree_path, branch } = {}) {
    const prev = getRun(id);
    stmts.updateStarted.run(
      tmux_session || null,
      worktree_path || null,
      branch || null,
      id
    );
    const run = stmts.getById.get(id);
    addRunEvent(id, 'started', JSON.stringify({ tmux_session, worktree_path, branch }));
    if (eventBus) {
      eventBus.emit('run:status', {
        run,
        from_status: prev.status,
        to_status: 'running',
        reason: 'started',
        task_id: run.task_id || null,
        project_id: derivePmProjectId(run),
      });
    }
    return run;
  }

  function updateRunResult(id, { result_summary, exit_code, input_tokens, output_tokens, cost_usd }) {
    getRun(id);
    stmts.updateResult.run(
      result_summary || null,
      exit_code ?? null,
      input_tokens ?? 0,
      output_tokens ?? 0,
      cost_usd ?? 0,
      id
    );
    return stmts.getById.get(id);
  }

  function deleteRun(id) {
    getRun(id);
    stmts.delete.run(id);
  }

  function addRunEvent(runId, eventType, payloadJson) {
    const info = stmts.insertEvent.run(runId, eventType, payloadJson || null);
    if (eventBus) {
      eventBus.emit('run:event', { runId, eventType, eventId: info.lastInsertRowid });
    }
    return info.lastInsertRowid;
  }

  function getRunEvents(runId, afterId) {
    if (afterId) return stmts.getEventsAfter.all(runId, afterId);
    return stmts.getEvents.all(runId);
  }

  // v3 Phase 1.5: layer-aware active manager lookups.
  // getActiveManager() is kept as a thin wrapper for callers that still
  // assume a single Top manager (lifecycleService, legacy routes). It
  // returns the most recent live Top manager row.
  function getActiveManager() {
    return getActiveManagers({ layer: 'top' })[0] || null;
  }

  // Returns all live manager runs matching the given filter. `layer` can be
  // 'top', 'pm', or undefined (all layers). Ordered by created_at DESC so
  // index [0] is the most recent match — callers that expect a singleton
  // (Top) can rely on that.
  function getActiveManagers({ layer } = {}) {
    const live = ['running', 'queued', 'needs_input'];
    const placeholders = live.map(() => '?').join(',');
    const params = [...live];
    let layerClause = '';
    if (layer) {
      layerClause = 'AND r.manager_layer = ?';
      params.push(layer);
    }
    return db.prepare(`
      SELECT r.*, ap.name as agent_name, ap.type as agent_type, ap.icon as agent_icon
      FROM runs r
      LEFT JOIN agent_profiles ap ON r.agent_profile_id = ap.id
      WHERE r.is_manager = 1 AND r.status IN (${placeholders}) ${layerClause}
      ORDER BY r.created_at DESC
    `).all(...params);
  }

  // Resolve a conversation_id to the most recent run that owns it. Used by
  // the conversation router to map 'top' / 'pm:<projectId>' / 'worker:<id>'
  // back to the underlying run row for event/message operations.
  function getRunByConversationId(conversationId) {
    if (!conversationId) return null;
    return db.prepare(`
      SELECT r.*, ap.name as agent_name, ap.type as agent_type, ap.icon as agent_icon,
             t.title as task_title, t.project_id as project_id, p.name as project_name
      FROM runs r
      LEFT JOIN agent_profiles ap ON r.agent_profile_id = ap.id
      LEFT JOIN tasks t ON r.task_id = t.id
      LEFT JOIN projects p ON t.project_id = p.id
      WHERE r.conversation_id = ?
      ORDER BY r.created_at DESC LIMIT 1
    `).get(conversationId) || null;
  }

  function getWorkerRuns(managerRunId) {
    return db.prepare(`
      SELECT r.*, ap.name as agent_name, ap.type as agent_type, ap.icon as agent_icon,
             t.title as task_title
      FROM runs r
      LEFT JOIN agent_profiles ap ON r.agent_profile_id = ap.id
      LEFT JOIN tasks t ON r.task_id = t.id
      WHERE r.parent_run_id = ?
      ORDER BY r.created_at DESC
    `).all(managerRunId);
  }

  return {
    listRuns, getRun, createRun,
    updateRunStatus, markRunStarted, updateRunResult,
    updateManagerThreadId,
    deleteRun, addRunEvent, getRunEvents,
    getActiveManager, getActiveManagers, getRunByConversationId, getWorkerRuns,
  };
}

module.exports = { createRunService, derivePmProjectId };
