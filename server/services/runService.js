const crypto = require('node:crypto');
const { BadRequestError, NotFoundError } = require('../utils/errors');

const VALID_STATUSES = ['queued', 'running', 'paused', 'needs_input', 'completed', 'failed', 'cancelled'];

// State machine: allowed transitions
const VALID_TRANSITIONS = {
  queued:      ['running', 'cancelled'],
  running:     ['paused', 'needs_input', 'completed', 'failed', 'cancelled'],
  paused:      ['running', 'cancelled'],
  needs_input: ['running', 'cancelled', 'failed'],
  completed:   [],  // terminal
  failed:      ['queued'],  // allow retry
  cancelled:   ['queued'],  // allow retry
};

function createRunService(db, eventBus) {
  const stmts = {
    getAll: db.prepare(`
      SELECT r.*, ap.name as agent_name, ap.type as agent_type, ap.icon as agent_icon,
             t.title as task_title
      FROM runs r
      LEFT JOIN agent_profiles ap ON r.agent_profile_id = ap.id
      LEFT JOIN tasks t ON r.task_id = t.id
      ORDER BY r.created_at DESC
    `),
    getByTask: db.prepare(`
      SELECT r.*, ap.name as agent_name, ap.type as agent_type, ap.icon as agent_icon
      FROM runs r
      LEFT JOIN agent_profiles ap ON r.agent_profile_id = ap.id
      WHERE r.task_id = ?
      ORDER BY r.created_at DESC
    `),
    getByStatus: db.prepare(`
      SELECT r.*, ap.name as agent_name, ap.type as agent_type, ap.icon as agent_icon,
             t.title as task_title
      FROM runs r
      LEFT JOIN agent_profiles ap ON r.agent_profile_id = ap.id
      LEFT JOIN tasks t ON r.task_id = t.id
      WHERE r.status = ?
      ORDER BY r.created_at DESC
    `),
    getById: db.prepare(`
      SELECT r.*, ap.name as agent_name, ap.type as agent_type, ap.icon as agent_icon,
             t.title as task_title
      FROM runs r
      LEFT JOIN agent_profiles ap ON r.agent_profile_id = ap.id
      LEFT JOIN tasks t ON r.task_id = t.id
      WHERE r.id = ?
    `),
    insert: db.prepare(`
      INSERT INTO runs (id, task_id, agent_profile_id, prompt, status)
      VALUES (@id, @task_id, @agent_profile_id, @prompt, @status)
    `),
    updateStatus: db.prepare(`
      UPDATE runs SET status = ?, ended_at = CASE WHEN ? IN ('completed','failed','cancelled') THEN datetime('now') ELSE ended_at END WHERE id = ?
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
      SELECT * FROM run_events WHERE run_id = ? ORDER BY id ASC
    `),
    getEventsAfter: db.prepare(`
      SELECT * FROM run_events WHERE run_id = ? AND id > ? ORDER BY id ASC
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

  function createRun({ task_id, agent_profile_id, prompt }) {
    if (!task_id) throw new BadRequestError('task_id is required');
    if (!agent_profile_id) throw new BadRequestError('agent_profile_id is required');
    const id = `run_${crypto.randomUUID().slice(0, 8)}`;
    stmts.insert.run({
      id,
      task_id,
      agent_profile_id,
      prompt: prompt || null,
      status: 'queued',
    });
    const run = stmts.getById.get(id);
    if (eventBus) eventBus.emit('run:status', { run });
    return run;
  }

  function updateRunStatus(id, status, { force = false } = {}) {
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
    stmts.updateStatus.run(status, status, id);
    const run = stmts.getById.get(id);
    addRunEvent(id, `status:${status}`, null);
    if (eventBus) eventBus.emit('run:status', { run });
    return run;
  }

  function markRunStarted(id, { tmux_session, worktree_path, branch } = {}) {
    getRun(id);
    stmts.updateStarted.run(
      tmux_session || null,
      worktree_path || null,
      branch || null,
      id
    );
    const run = stmts.getById.get(id);
    addRunEvent(id, 'started', JSON.stringify({ tmux_session, worktree_path, branch }));
    if (eventBus) eventBus.emit('run:status', { run });
    return run;
  }

  function updateRunResult(id, { result_summary, exit_code, input_tokens, output_tokens, cost_usd }) {
    getRun(id);
    stmts.updateResult.run(
      result_summary || null,
      exit_code ?? null,
      input_tokens || 0,
      output_tokens || 0,
      cost_usd || 0,
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

  return {
    listRuns, getRun, createRun,
    updateRunStatus, markRunStarted, updateRunResult,
    deleteRun, addRunEvent, getRunEvents,
  };
}

module.exports = { createRunService };
