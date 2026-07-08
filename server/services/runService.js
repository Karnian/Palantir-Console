const crypto = require('node:crypto');
const { BadRequestError, NotFoundError } = require('../utils/errors');
const {
  isProjectLayer,
  parseProjectConversationId,
  OPERATOR_LAYER,
  OPERATOR_CONV_PREFIX,
  conversationIdForProject,
  createOperatorConversationIdResolver,
} = require('../utils/conversationId'); // PM→Operator rename Phase 4: operator: only

const VALID_STATUSES = ['queued', 'materializing', 'running', 'paused', 'needs_input', 'completed', 'failed', 'cancelled', 'stopped'];

// State machine: allowed transitions
const VALID_TRANSITIONS = {
  queued:      ['materializing', 'running', 'cancelled'],
  materializing: ['queued', 'failed', 'cancelled', 'stopped'],
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
//
// P2-4: both sources of truth (the JOIN path via task_id → project_id
// and the parsed conversation_id 'pm:<id>') can theoretically disagree
// if a run was created with a mismatched conversation_id and task — a
// bug that was silent before because deriveOperatorProjectId simply preferred
// the JOIN path without complaint. This function now logs a warn via
// the optional logger when both are present and disagree, and via the
// optional diagnostics callback records it on the run event stream.
// Pure-ish: emits side effects only when a logger / diagnostics hook is
// provided. Behavior (return value) is unchanged.
let _deriveOperatorProjectIdDiagnostics = null;

function setDeriveOperatorProjectIdDiagnostics(fn) {
  _deriveOperatorProjectIdDiagnostics = typeof fn === 'function' ? fn : null;
}

function deriveOperatorProjectId(run) {
  if (!run) return null;
  const joinPid = run.project_id || null;
  let parsedPid = null;
  const cid = run.conversation_id;
  // dual-read (PM→Operator rename Phase 0): manager_layer 'pm' OR 'operator', conv id `pm:`/`operator:`.
  if (isProjectLayer(run.manager_layer)) {
    const parsedConv = parseProjectConversationId(cid);
    parsedPid = parsedConv ? parsedConv.projectId : null;
  }

  // P2-4 diagnostic path: both present and disagreeing. The JOIN path is
  // authoritative (it comes through task_id which is user-controlled in
  // the DB), so we still return joinPid, but we shout about the drift.
  if (joinPid && parsedPid && joinPid !== parsedPid) {
    try {
      if (_deriveOperatorProjectIdDiagnostics) {
        _deriveOperatorProjectIdDiagnostics({
          runId: run.id,
          joinPid,
          parsedPid,
          conversationId: cid,
        });
      } else {
        console.warn(`[runService] deriveOperatorProjectId mismatch run=${run.id} joinPid=${joinPid} parsedPid=${parsedPid} cid=${cid}`);
      }
    } catch { /* ignore diagnostic failures */ }
  }

  if (joinPid) return joinPid;
  return parsedPid;
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
      SELECT r.*, r.rowid AS _seq, ap.name as agent_name, ap.type as agent_type, ap.icon as agent_icon,
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
      INSERT INTO runs (
        id, task_id, agent_profile_id, prompt, status, is_manager,
        parent_run_id, manager_adapter, manager_thread_id, manager_layer,
        conversation_id, queued_args, retry_count, node_id,
        operator_instance_id, retry_root_run_id
      )
      VALUES (
        @id, @task_id, @agent_profile_id, @prompt, @status, @is_manager,
        @parent_run_id, @manager_adapter, @manager_thread_id, @manager_layer,
        @conversation_id, @queued_args, @retry_count, @node_id,
        @operator_instance_id, @retry_root_run_id
      )
    `),
    insertOperatorInstance: db.prepare(`
      INSERT OR IGNORE INTO operator_instances (id)
      VALUES (?)
    `),
    insertPrimaryOperatorRef: db.prepare(`
      INSERT OR IGNORE INTO operator_codebase_refs (instance_id, project_id, role)
      VALUES (?, ?, 'primary')
    `),
    getOperatorInstance: db.prepare(`
      SELECT * FROM operator_instances WHERE id = ?
    `),
    updateOperatorThread: db.prepare(`
      UPDATE operator_instances
         SET thread_id = @thread_id,
             pm_adapter = @pm_adapter,
             node_id = @node_id,
             cwd = @cwd,
             source_generation = @source_generation,
             source_hash = @source_hash,
             workspace_path = @workspace_path,
             updated_at = datetime('now')
       WHERE id = @id
    `),
    updateManagerThread: db.prepare(`
      UPDATE runs SET manager_thread_id = ? WHERE id = ?
    `),
    updateClaudeSessionId: db.prepare(`
      UPDATE runs SET claude_session_id = ? WHERE id = ?
    `),
    updateStatus: db.prepare(`
      UPDATE runs SET status = ?, ended_at = CASE WHEN ? IN ('completed','failed','cancelled','stopped') THEN datetime('now') ELSE ended_at END WHERE id = ?
    `),
    updateStarted: db.prepare(`
      UPDATE runs SET status = 'running', started_at = datetime('now'), tmux_session = ?, worktree_path = ?, branch = ? WHERE id = ?
    `),
    countRunning: db.prepare(`
      SELECT COUNT(*) as count FROM runs
      WHERE agent_profile_id = ? AND status = 'running' AND is_manager = 0
    `),
    countRunningOnNode: db.prepare(`
      SELECT COUNT(*) as count FROM runs
      WHERE COALESCE(node_id, 'local') = ?
        AND agent_profile_id = ?
        AND status = 'running'
        AND is_manager = 0
    `),
    countRunningTotalOnNode: db.prepare(`
      SELECT COUNT(*) as count FROM runs
      WHERE COALESCE(node_id, 'local') = ?
        AND status = 'running'
        AND is_manager = 0
    `),
    getOldestQueued: db.prepare(`
      SELECT r.*, ap.name as agent_name, ap.type as agent_type, ap.icon as agent_icon,
             t.title as task_title, t.project_id as project_id, p.name as project_name
      FROM runs r
      LEFT JOIN agent_profiles ap ON r.agent_profile_id = ap.id
      LEFT JOIN tasks t ON r.task_id = t.id
      LEFT JOIN projects p ON t.project_id = p.id
      WHERE r.status = 'queued' AND r.agent_profile_id = ? AND r.is_manager = 0
      ORDER BY r.created_at ASC, r.rowid ASC
      LIMIT 1
    `),
    getOldestQueuedOnNode: db.prepare(`
      SELECT r.*, ap.name as agent_name, ap.type as agent_type, ap.icon as agent_icon,
             t.title as task_title, t.project_id as project_id, p.name as project_name
      FROM runs r
      LEFT JOIN agent_profiles ap ON r.agent_profile_id = ap.id
      LEFT JOIN tasks t ON r.task_id = t.id
      LEFT JOIN projects p ON t.project_id = p.id
      WHERE r.status = 'queued'
        AND r.agent_profile_id = ?
        AND r.is_manager = 0
        AND COALESCE(r.node_id, 'local') = ?
      ORDER BY r.created_at ASC, r.rowid ASC
      LIMIT 1
    `),
    getOldestQueuedReadyOnNode: db.prepare(`
      SELECT r.*, ap.name as agent_name, ap.type as agent_type, ap.icon as agent_icon,
             t.title as task_title, t.project_id as project_id, p.name as project_name
      FROM runs r
      LEFT JOIN agent_profiles ap ON r.agent_profile_id = ap.id
      LEFT JOIN tasks t ON r.task_id = t.id
      LEFT JOIN projects p ON t.project_id = p.id
      WHERE r.status = 'queued'
        AND r.agent_profile_id = ?
        AND r.is_manager = 0
        AND COALESCE(r.node_id, 'local') = ?
        AND (
          COALESCE(p.source_type, 'legacy_directory') <> 'git'
          OR (
            r.workspace_path IS NOT NULL
            AND r.resolved_commit IS NOT NULL
            AND r.workspace_generation = COALESCE(p.source_generation, 0)
          )
        )
      ORDER BY r.created_at ASC, r.rowid ASC
      LIMIT 1
    `),
    getOldestMaterializableOnNode: db.prepare(`
      SELECT r.*, ap.name as agent_name, ap.type as agent_type, ap.icon as agent_icon,
             t.title as task_title, t.project_id as project_id, p.name as project_name
      FROM runs r
      LEFT JOIN agent_profiles ap ON r.agent_profile_id = ap.id
      LEFT JOIN tasks t ON r.task_id = t.id
      LEFT JOIN projects p ON t.project_id = p.id
      WHERE r.agent_profile_id = ?
        AND r.is_manager = 0
        AND COALESCE(r.node_id, 'local') = ?
        AND COALESCE(p.source_type, 'legacy_directory') = 'git'
        AND (
          r.workspace_path IS NULL
          OR r.resolved_commit IS NULL
          OR r.workspace_generation IS NULL
          OR r.workspace_generation <> COALESCE(p.source_generation, 0)
        )
        AND (
          (r.status = 'queued' AND (r.materialize_run_after IS NULL OR datetime(r.materialize_run_after) <= datetime('now')))
          OR (r.status = 'materializing' AND r.materialize_run_after IS NOT NULL AND datetime(r.materialize_run_after) <= datetime('now'))
        )
      ORDER BY r.created_at ASC, r.rowid ASC
      LIMIT 1
    `),
    claimQueued: db.prepare(`
      UPDATE runs SET status = 'running', started_at = datetime('now')
      WHERE id = ? AND status = 'queued'
    `),
    claimQueuedForMaterialization: db.prepare(`
      UPDATE runs
         SET status = 'materializing',
             materialize_started_at = datetime('now'),
             materialize_run_after = NULL,
             materialize_claim_token = ?
       WHERE id = ? AND status = 'queued'
    `),
    restartMaterializationAttempt: db.prepare(`
      UPDATE runs
         SET materialize_started_at = datetime('now'),
             materialize_run_after = NULL,
             materialize_claim_token = ?
       WHERE id = ?
         AND status = 'materializing'
         AND materialize_run_after IS NOT NULL
         AND datetime(materialize_run_after) <= datetime('now')
    `),
    countMaterializingOnNode: db.prepare(`
      SELECT COUNT(*) as count FROM runs
      WHERE COALESCE(node_id, 'local') = ?
        AND status = 'materializing'
        AND materialize_run_after IS NULL
        AND is_manager = 0
    `),
    countMaterializingGlobal: db.prepare(`
      SELECT COUNT(*) as count FROM runs
      WHERE status = 'materializing'
        AND materialize_run_after IS NULL
        AND is_manager = 0
    `),
    markMaterializePending: db.prepare(`
      UPDATE runs
         SET materialize_run_after = datetime('now', ?),
             materialize_last_error = NULL
       WHERE id = ?
         AND status = 'materializing'
         AND materialize_claim_token = ?
    `),
    updateMaterializedRun: db.prepare(`
      UPDATE runs
         SET status = 'queued',
             source_type_snapshot = @source_type_snapshot,
             run_source_generation = @run_source_generation,
             repo_url_snapshot = @repo_url_snapshot,
             repo_ref_snapshot = @repo_ref_snapshot,
             repo_subdir_snapshot = @repo_subdir_snapshot,
             repo_cache_path = @repo_cache_path,
             workspace_path = @workspace_path,
             workspace_generation = @workspace_generation,
             resolved_commit = @resolved_commit,
             materialize_last_error = NULL,
             materialize_claim_token = NULL,
             materialize_run_after = NULL
       WHERE id = @id
         AND status = 'materializing'
         AND materialize_claim_token = @materialize_claim_token
    `),
    markMaterializedReady: db.prepare(`
      UPDATE runs
         SET status = 'queued',
             started_at = NULL,
             materialize_started_at = NULL,
             materialize_claim_token = NULL,
             materialize_last_error = NULL,
             materialize_run_after = NULL
       WHERE id = ?
         AND status = 'materializing'
         AND materialize_claim_token = ?
    `),
    getProjectNodeWorkspace: db.prepare(`
      SELECT * FROM project_node_workspaces
      WHERE project_id = ? AND node_id = ? AND source_generation = ?
    `),
    upsertProjectNodeWorkspaceReady: db.prepare(`
      INSERT INTO project_node_workspaces (
        project_id, node_id, source_generation, repo_url, repo_ref,
        resolved_commit, repo_cache_path, status, last_error,
        materialized_at, last_used_at
      )
      VALUES (
        @project_id, @node_id, @source_generation, @repo_url, @repo_ref,
        @resolved_commit, @repo_cache_path, 'ready', NULL,
        datetime('now'), datetime('now')
      )
      ON CONFLICT(project_id,node_id,source_generation) DO UPDATE SET
        repo_url = excluded.repo_url,
        repo_ref = excluded.repo_ref,
        resolved_commit = excluded.resolved_commit,
        repo_cache_path = excluded.repo_cache_path,
        status = 'ready',
        last_error = NULL,
        materialized_at = datetime('now'),
        last_used_at = datetime('now')
    `),
    upsertProjectNodeWorkspaceFailed: db.prepare(`
      INSERT INTO project_node_workspaces (
        project_id, node_id, source_generation, repo_url, repo_ref,
        resolved_commit, repo_cache_path, status, last_error,
        materialized_at, last_used_at
      )
      VALUES (
        @project_id, @node_id, @source_generation, @repo_url, @repo_ref,
        NULL, @repo_cache_path, 'failed', @last_error,
        NULL, datetime('now')
      )
      ON CONFLICT(project_id,node_id,source_generation) DO UPDATE SET
        repo_url = excluded.repo_url,
        repo_ref = excluded.repo_ref,
        repo_cache_path = excluded.repo_cache_path,
        status = 'failed',
        last_error = excluded.last_error,
        last_used_at = datetime('now')
    `),
    touchProjectNodeWorkspace: db.prepare(`
      UPDATE project_node_workspaces
         SET last_used_at = datetime('now')
       WHERE project_id = ? AND node_id = ? AND source_generation = ?
    `),
    stealStaleMaterializationLease: db.prepare(`
      UPDATE project_materialization_leases
         SET status = 'stale', last_error = 'stale materialization lease'
      WHERE project_id = ?
         AND node_id = ?
         AND source_generation = ?
         AND status IN ('pending', 'running')
         AND locked_at IS NOT NULL
         AND datetime(locked_at) <= datetime(?)
    `),
    touchMaterializationLease: db.prepare(`
      UPDATE project_materialization_leases
         SET locked_at = datetime('now')
       WHERE claim_token = ? AND status IN ('pending', 'running')
    `),
    insertMaterializationLease: db.prepare(`
      INSERT INTO project_materialization_leases (
        project_id, node_id, source_generation, status, claim_token,
        locked_at, owner_run_id, attempts, last_error
      )
      VALUES (?, ?, ?, 'running', ?, datetime('now'), ?, 1, NULL)
    `),
    releaseMaterializationLease: db.prepare(`
      UPDATE project_materialization_leases
         SET status = ?, last_error = ?
       WHERE claim_token = ? AND status IN ('pending', 'running')
    `),
    acquireWorkspaceRef: db.prepare(`
      INSERT INTO project_workspace_refs (
        run_id, project_id, node_id, source_generation, repo_cache_path,
        worktree_path, ref_type, acquired_at, heartbeat_at, released_at, expires_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), NULL, ?)
    `),
    releaseWorkspaceRefByRun: db.prepare(`
      UPDATE project_workspace_refs
         SET released_at = COALESCE(released_at, datetime('now'))
       WHERE run_id = ? AND released_at IS NULL
    `),
    releaseWorkspaceRefByRunAndPath: db.prepare(`
      UPDATE project_workspace_refs
         SET released_at = COALESCE(released_at, datetime('now'))
       WHERE run_id = ? AND worktree_path = ? AND released_at IS NULL
    `),
    markRunWorkspaceRefReleased: db.prepare(`
      UPDATE runs
         SET workspace_ref_released_at = COALESCE(workspace_ref_released_at, datetime('now'))
       WHERE id = ?
    `),
    requeueMaterializingRunWithToken: db.prepare(`
      UPDATE runs
         SET status = 'queued',
             materialize_attempts = COALESCE(materialize_attempts, 0) + 1,
             materialize_started_at = NULL,
             materialize_claim_token = NULL,
             materialize_last_error = ?,
             materialize_run_after = datetime('now', ?)
       WHERE id = ?
         AND status = 'materializing'
         AND materialize_claim_token = ?
    `),
    requeueTokenlessMaterializingRun: db.prepare(`
      UPDATE runs
         SET status = 'queued',
             materialize_attempts = COALESCE(materialize_attempts, 0) + 1,
             materialize_started_at = NULL,
             materialize_claim_token = NULL,
             materialize_last_error = ?,
             materialize_run_after = datetime('now', ?)
       WHERE id = ?
         AND status = 'materializing'
         AND materialize_claim_token IS NULL
    `),
    failMaterializingRunWithToken: db.prepare(`
      UPDATE runs
         SET status = 'failed',
             ended_at = datetime('now'),
             materialize_attempts = COALESCE(materialize_attempts, 0) + 1,
             materialize_started_at = NULL,
             materialize_claim_token = NULL,
             materialize_last_error = ?,
             materialize_run_after = NULL
       WHERE id = ?
         AND status = 'materializing'
         AND materialize_claim_token = ?
    `),
    failTokenlessMaterializingRun: db.prepare(`
      UPDATE runs
         SET status = 'failed',
             ended_at = datetime('now'),
             materialize_attempts = COALESCE(materialize_attempts, 0) + 1,
             materialize_started_at = NULL,
             materialize_claim_token = NULL,
             materialize_last_error = ?,
             materialize_run_after = NULL
       WHERE id = ?
         AND status = 'materializing'
         AND materialize_claim_token IS NULL
    `),
    staleAllMaterializationLeases: db.prepare(`
      UPDATE project_materialization_leases
         SET status = 'stale', last_error = 'stale materialization lease'
       WHERE status IN ('pending', 'running')
         AND locked_at IS NOT NULL
         AND datetime(locked_at) <= datetime(?)
    `),
    retargetQueued: db.prepare(`
      UPDATE runs
      SET node_id = ?
      WHERE id = ?
        AND status = 'queued'
        AND COALESCE(node_id, 'local') = ?
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

  function normalizeQueuedArgs(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string') return value || null;
    return JSON.stringify(value);
  }

  function normalizeRetryCount(value) {
    const n = Number(value || 0);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  }

  function createRun({
    task_id,
    agent_profile_id,
    prompt,
    is_manager,
    node_id,
    parent_run_id,
    manager_adapter,
    manager_thread_id,
    manager_layer,
    conversation_id,
    queued_args,
    retry_count,
    operator_instance_id,
    retry_root_run_id,
  }) {
    // task_id and agent_profile_id are required for worker runs, optional for manager
    if (!is_manager && !task_id) throw new BadRequestError('task_id is required');
    if (!is_manager && !agent_profile_id) throw new BadRequestError('agent_profile_id is required');
    const id = is_manager ? `run_mgr_${crypto.randomUUID().slice(0, 8)}` : `run_${crypto.randomUUID().slice(0, 8)}`;

    // v3 Phase 1.5: conversation identity defaults.
    // Manager runs default to layer='top' + conversation_id='top' (the MVP
    // singleton). Worker runs default to conversation_id='worker:<id>'.
    // Callers that spawn an Operator (Phase 3a) must pass manager_layer='operator' +
    // conversation_id='operator:<projectId>' explicitly.
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
      queued_args: normalizeQueuedArgs(queued_args),
      retry_count: normalizeRetryCount(retry_count),
      node_id: node_id || null,
      operator_instance_id: operator_instance_id || null,
      retry_root_run_id: retry_root_run_id || null,
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
        project_id: deriveOperatorProjectId(run),
        node_id: run.node_id || null,
      });
    }
    return run;
  }

  const resolveOperatorConversationFromDb = createOperatorConversationIdResolver(db);

  function resolveOperatorConversationIdWithDb(conversationId) {
    return resolveOperatorConversationFromDb(conversationId);
  }

  function ensurePrimaryOperatorInstanceForProject(projectId) {
    if (!projectId) return null;
    const existing = resolveOperatorConversationFromDb(conversationIdForProject(projectId));
    if (existing && existing.instanceId) return existing;

    const instanceId = `oi_${projectId}`;
    const tx = db.transaction(() => {
      stmts.insertOperatorInstance.run(instanceId);
      stmts.insertPrimaryOperatorRef.run(instanceId, projectId);
    });
    tx();
    return resolveOperatorConversationFromDb(conversationIdForProject(projectId));
  }

  function getOperatorInstance(instanceId) {
    if (!instanceId) return null;
    return stmts.getOperatorInstance.get(instanceId) || null;
  }

  function getOperatorThreadForProject(projectId, { ensure = false } = {}) {
    const resolved = ensure
      ? ensurePrimaryOperatorInstanceForProject(projectId)
      : resolveOperatorConversationFromDb(conversationIdForProject(projectId));
    if (!resolved || !resolved.instanceId) return null;
    return getOperatorInstance(resolved.instanceId);
  }

  function setOperatorInstanceThread(instanceId, fields = {}) {
    if (!instanceId) return null;
    stmts.updateOperatorThread.run({
      id: instanceId,
      thread_id: fields.thread_id ?? fields.pm_thread_id ?? null,
      pm_adapter: fields.pm_adapter || null,
      node_id: fields.node_id ?? fields.pm_thread_node_id ?? null,
      cwd: fields.cwd ?? fields.pm_thread_cwd ?? null,
      source_generation: fields.source_generation ?? fields.pm_thread_source_generation ?? null,
      source_hash: fields.source_hash ?? fields.pm_thread_source_hash ?? null,
      workspace_path: fields.workspace_path ?? fields.pm_thread_workspace_path ?? null,
    });
    return getOperatorInstance(instanceId);
  }

  function updateManagerThreadId(id, threadId) {
    getRun(id);
    stmts.updateManagerThread.run(threadId || null, id);
    return stmts.getById.get(id);
  }

  function updateClaudeSessionId(id, sessionId) {
    getRun(id);
    stmts.updateClaudeSessionId.run(sessionId || null, id);
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
        project_id: deriveOperatorProjectId(run),
        node_id: run.node_id || null,
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
        project_id: deriveOperatorProjectId(run),
        node_id: run.node_id || null,
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
        project_id: deriveOperatorProjectId(run),
        node_id: run.node_id || null,
      });
    }
    return run;
  }

  function countRunning(profileId) {
    return stmts.countRunning.get(profileId).count;
  }

  function countRunningOnNode(nodeId, profileId) {
    return stmts.countRunningOnNode.get(nodeId || 'local', profileId).count;
  }

  function countRunningTotalOnNode(nodeId) {
    return stmts.countRunningTotalOnNode.get(nodeId || 'local').count;
  }

  function getOldestQueued(profileId) {
    return stmts.getOldestQueued.get(profileId) || null;
  }

  function getOldestQueuedOnNode(nodeId, profileId) {
    return stmts.getOldestQueuedOnNode.get(profileId, nodeId || 'local') || null;
  }

  function getOldestQueuedReadyOnNode(nodeId, profileId) {
    return stmts.getOldestQueuedReadyOnNode.get(profileId, nodeId || 'local') || null;
  }

  function getOldestMaterializableOnNode(nodeId, profileId) {
    return stmts.getOldestMaterializableOnNode.get(profileId, nodeId || 'local') || null;
  }

  function countMaterializingOnNode(nodeId) {
    return stmts.countMaterializingOnNode.get(nodeId || 'local').count;
  }

  function countMaterializingGlobal() {
    return stmts.countMaterializingGlobal.get().count;
  }

  function repoFeatureEnabled() {
    return process.env.PALANTIR_PROJECT_REPO !== '0';
  }

  function isUnreadyGitRun(run) {
    if (!run || (run.source_type_snapshot && run.source_type_snapshot !== 'git')) return false;
    if ((run.source_type || run.project_source_type) === 'legacy_directory') return false;
    if (run.project_id && run.source_type === undefined) {
      // getById joins projects without selecting p.source_type separately. When
      // source fields are absent, ask the DB directly so claimQueuedRun's guard
      // still protects callers that bypass drainQueue.
      const source = db.prepare(`
        SELECT p.source_type, p.source_generation
        FROM tasks t
        JOIN projects p ON t.project_id = p.id
        WHERE t.id = ?
      `).get(run.task_id);
      if (!source || source.source_type !== 'git') return false;
      return !run.workspace_path
        || !run.resolved_commit
        || Number(run.workspace_generation) !== Number(source.source_generation || 0);
    }
    return false;
  }

  // Used to exhaust the retry budget of a run whose failure is not worth
  // retrying (e.g. corrupt queued_args — a retry would copy the same bad args
  // and fail identically). Idempotent raw write; no state-machine transition.
  function setRetryCount(id, n) {
    db.prepare('UPDATE runs SET retry_count = ? WHERE id = ?').run(Number(n) || 0, id);
  }

  function claimQueuedRun(id) {
    if (repoFeatureEnabled()) {
      const current = stmts.getById.get(id);
      if (isUnreadyGitRun(current)) return 0;
    }
    const info = stmts.claimQueued.run(id);
    if (info.changes === 0) return 0;
    const run = stmts.getById.get(id);
    addRunEvent(id, 'status:running', JSON.stringify({ reason: 'queue:claim' }));
    if (eventBus) {
      eventBus.emit('run:status', {
        run,
        from_status: 'queued',
        to_status: 'running',
        reason: 'queue:claim',
        task_id: run.task_id || null,
        project_id: deriveOperatorProjectId(run),
        node_id: run.node_id || null,
      });
    }
    return info.changes;
  }

  function claimQueuedRunForMaterialization(id) {
    const token = crypto.randomUUID();
    const info = stmts.claimQueuedForMaterialization.run(token, id);
    if (info.changes === 0) return null;
    const run = stmts.getById.get(id);
    addRunEvent(id, 'status:materializing', JSON.stringify({ reason: 'materialize:claim' }));
    if (eventBus) {
      eventBus.emit('run:status', {
        run,
        from_status: 'queued',
        to_status: 'materializing',
        reason: 'materialize:claim',
        task_id: run.task_id || null,
        project_id: deriveOperatorProjectId(run),
        node_id: run.node_id || null,
      });
    }
    return { claimed: true, token };
  }

  function restartMaterializationAttempt(id) {
    const token = crypto.randomUUID();
    const info = stmts.restartMaterializationAttempt.run(token, id);
    if (info.changes > 0) {
      addRunEvent(id, 'materialize:retry', JSON.stringify({ reason: 'run_after_elapsed' }));
      return { claimed: true, token };
    }
    return null;
  }

  function markMaterializePending(id, { backoffMs = 1000, token = null } = {}) {
    if (!token) return 0;
    const seconds = Math.max(1, Math.ceil(Number(backoffMs || 1000) / 1000));
    const modifier = `+${seconds} seconds`;
    const info = stmts.markMaterializePending.run(modifier, id, token);
    if (info.changes > 0) {
      addRunEvent(id, 'materialize:pending', JSON.stringify({ backoff_ms: seconds * 1000 }));
    }
    return info.changes;
  }

  function updateRunMaterialized(id, fields = {}) {
    const token = fields.materialize_claim_token || fields.claimToken || null;
    if (!token) return null;
    const prev = getRun(id);
    const info = stmts.updateMaterializedRun.run({
      id,
      materialize_claim_token: token,
      source_type_snapshot: fields.source_type_snapshot || 'git',
      run_source_generation: Number(fields.run_source_generation || 0),
      repo_url_snapshot: fields.repo_url_snapshot || null,
      repo_ref_snapshot: fields.repo_ref_snapshot || 'HEAD',
      repo_subdir_snapshot: fields.repo_subdir_snapshot || null,
      repo_cache_path: fields.repo_cache_path || null,
      workspace_path: fields.workspace_path || null,
      workspace_generation: Number(fields.workspace_generation || 0),
      resolved_commit: fields.resolved_commit || null,
    });
    if (info.changes === 0) return null;
    const run = stmts.getById.get(id);
    addRunEvent(id, 'status:queued', JSON.stringify({ reason: 'materialize:ready' }));
    if (eventBus) {
      eventBus.emit('run:status', {
        run,
        from_status: prev.status,
        to_status: 'queued',
        reason: 'materialize:ready',
        task_id: run.task_id || null,
        project_id: deriveOperatorProjectId(run),
        node_id: run.node_id || null,
      });
    }
    return run;
  }

  function markMaterializedReady(id, token) {
    if (!token) return null;
    const prev = getRun(id);
    const info = stmts.markMaterializedReady.run(id, token);
    if (info.changes === 0) return null;
    const run = stmts.getById.get(id);
    addRunEvent(id, 'status:queued', JSON.stringify({ reason: 'materialize:ready' }));
    if (eventBus) {
      eventBus.emit('run:status', {
        run,
        from_status: prev.status,
        to_status: 'queued',
        reason: 'materialize:ready',
        task_id: run.task_id || null,
        project_id: deriveOperatorProjectId(run),
        node_id: run.node_id || null,
      });
    }
    return run;
  }

  function getProjectNodeWorkspace(projectId, nodeId, sourceGeneration) {
    return stmts.getProjectNodeWorkspace.get(projectId, nodeId || 'local', Number(sourceGeneration || 0)) || null;
  }

  function markProjectNodeWorkspaceReady(fields = {}) {
    stmts.upsertProjectNodeWorkspaceReady.run({
      project_id: fields.project_id,
      node_id: fields.node_id || 'local',
      source_generation: Number(fields.source_generation || 0),
      repo_url: fields.repo_url || null,
      repo_ref: fields.repo_ref || 'HEAD',
      resolved_commit: fields.resolved_commit || null,
      repo_cache_path: fields.repo_cache_path || null,
    });
    return getProjectNodeWorkspace(fields.project_id, fields.node_id || 'local', fields.source_generation || 0);
  }

  function markProjectNodeWorkspaceFailed(fields = {}) {
    stmts.upsertProjectNodeWorkspaceFailed.run({
      project_id: fields.project_id,
      node_id: fields.node_id || 'local',
      source_generation: Number(fields.source_generation || 0),
      repo_url: fields.repo_url || null,
      repo_ref: fields.repo_ref || 'HEAD',
      repo_cache_path: fields.repo_cache_path || null,
      last_error: String(fields.last_error || 'materialization failed').slice(0, 2000),
    });
  }

  function touchProjectNodeWorkspace(projectId, nodeId, sourceGeneration) {
    stmts.touchProjectNodeWorkspace.run(projectId, nodeId || 'local', Number(sourceGeneration || 0));
  }

  function acquireMaterializationLease({ projectId, nodeId = 'local', sourceGeneration = 0, ownerRunId, staleMs = 10 * 60 * 1000 } = {}) {
    const token = crypto.randomUUID();
    const threshold = new Date(Date.now() - Math.max(1, Number(staleMs || 0))).toISOString();
    try {
      stmts.stealStaleMaterializationLease.run(projectId, nodeId || 'local', Number(sourceGeneration || 0), threshold);
      stmts.insertMaterializationLease.run(projectId, nodeId || 'local', Number(sourceGeneration || 0), token, ownerRunId || null);
      return { acquired: true, token };
    } catch (err) {
      if (String(err && err.message || '').includes('UNIQUE constraint failed')) {
        return { acquired: false, pending: true };
      }
      throw err;
    }
  }

  function touchMaterializationLease(token) {
    if (!token) return 0;
    return stmts.touchMaterializationLease.run(token).changes;
  }

  function releaseMaterializationLease(token, { status = 'completed', error = null } = {}) {
    if (!token) return 0;
    const finalStatus = status || 'completed';
    const message = error ? String(error.message || error).slice(0, 2000) : null;
    return stmts.releaseMaterializationLease.run(finalStatus, message, token).changes;
  }

  function acquireWorkspaceRef({
    runId,
    projectId,
    nodeId = 'local',
    sourceGeneration = 0,
    repoCachePath,
    worktreePath,
    refType = 'run',
    expiresAt = null,
  } = {}) {
    return stmts.acquireWorkspaceRef.run(
      runId,
      projectId || null,
      nodeId || 'local',
      Number(sourceGeneration || 0),
      repoCachePath || null,
      worktreePath || null,
      refType || 'run',
      expiresAt || null,
    ).lastInsertRowid;
  }

  function releaseWorkspaceRefByRun(runId) {
    const info = stmts.releaseWorkspaceRefByRun.run(runId);
    if (info.changes > 0) {
      stmts.markRunWorkspaceRefReleased.run(runId);
      addRunEvent(runId, 'workspace_ref:released', JSON.stringify({ released: info.changes }));
    }
    return info.changes;
  }

  function releaseWorkspaceRefByRunAndPath(runId, worktreePath) {
    if (!worktreePath) return 0;
    const info = stmts.releaseWorkspaceRefByRunAndPath.run(runId, worktreePath);
    if (info.changes > 0) {
      addRunEvent(runId, 'workspace_ref:released', JSON.stringify({
        released: info.changes,
        worktree_path: worktreePath,
      }));
    }
    return info.changes;
  }

  function requeueMaterializingRun(id, {
    error = 'materialization stuck',
    backoffMs = 1000,
    token = null,
    reason = 'materialize:failed',
    eventType = 'materialize:failed',
    transient = true,
  } = {}) {
    if (!token) return null;
    const prev = getRun(id);
    const message = String(error || 'materialization stuck').slice(0, 2000);
    const seconds = Math.max(1, Math.ceil(Number(backoffMs || 1000) / 1000));
    const info = stmts.requeueMaterializingRunWithToken.run(message, `+${seconds} seconds`, id, token);
    if (info.changes === 0) return null;
    const run = stmts.getById.get(id);
    addRunEvent(id, eventType, JSON.stringify({ error: message, action: 'requeued', transient: Boolean(transient) }));
    if (eventBus) {
      eventBus.emit('run:status', {
        run,
        from_status: prev.status,
        to_status: 'queued',
        reason,
        task_id: run.task_id || null,
        project_id: deriveOperatorProjectId(run),
        node_id: run.node_id || null,
      });
    }
    return run;
  }

  function forceRequeueTokenlessMaterializingRun(id, {
    error = 'materialization stuck',
    backoffMs = 1000,
    reason = 'materialize:failed',
    eventType = 'materialize:failed',
    transient = true,
  } = {}) {
    const prev = getRun(id);
    const message = String(error || 'materialization stuck').slice(0, 2000);
    const seconds = Math.max(1, Math.ceil(Number(backoffMs || 1000) / 1000));
    const info = stmts.requeueTokenlessMaterializingRun.run(message, `+${seconds} seconds`, id);
    if (info.changes === 0) return null;
    const run = stmts.getById.get(id);
    addRunEvent(id, eventType, JSON.stringify({ error: message, action: 'requeued', transient: Boolean(transient), force_tokenless: true }));
    if (eventBus) {
      eventBus.emit('run:status', {
        run,
        from_status: prev.status,
        to_status: 'queued',
        reason,
        task_id: run.task_id || null,
        project_id: deriveOperatorProjectId(run),
        node_id: run.node_id || null,
      });
    }
    return run;
  }

  function failMaterializingRun(id, {
    error = 'materialization failed',
    token = null,
    reason = 'materialize:failed',
    eventType = 'materialize:failed',
  } = {}) {
    if (!token) return null;
    const prev = getRun(id);
    const message = String(error || 'materialization failed').slice(0, 2000);
    const info = stmts.failMaterializingRunWithToken.run(message, id, token);
    if (info.changes === 0) return null;
    const run = stmts.getById.get(id);
    addRunEvent(id, eventType, JSON.stringify({ error: message, action: 'failed', transient: false }));
    if (eventBus) {
      const envelope = {
        run,
        from_status: prev.status,
        to_status: 'failed',
        reason,
        task_id: run.task_id || null,
        project_id: deriveOperatorProjectId(run),
        node_id: run.node_id || null,
      };
      eventBus.emit('run:status', envelope);
      eventBus.emit('run:ended', envelope);
    }
    return run;
  }

  function forceFailTokenlessMaterializingRun(id, {
    error = 'materialization failed',
    reason = 'materialize:failed',
    eventType = 'materialize:failed',
  } = {}) {
    const prev = getRun(id);
    const message = String(error || 'materialization failed').slice(0, 2000);
    const info = stmts.failTokenlessMaterializingRun.run(message, id);
    if (info.changes === 0) return null;
    const run = stmts.getById.get(id);
    addRunEvent(id, eventType, JSON.stringify({ error: message, action: 'failed', transient: false, force_tokenless: true }));
    if (eventBus) {
      const envelope = {
        run,
        from_status: prev.status,
        to_status: 'failed',
        reason,
        task_id: run.task_id || null,
        project_id: deriveOperatorProjectId(run),
        node_id: run.node_id || null,
      };
      eventBus.emit('run:status', envelope);
      eventBus.emit('run:ended', envelope);
    }
    return run;
  }

  function staleMaterializationLeases(staleMs = 10 * 60 * 1000) {
    const threshold = new Date(Date.now() - Math.max(1, Number(staleMs || 0))).toISOString();
    return stmts.staleAllMaterializationLeases.run(threshold).changes;
  }

  function normalizeQueueNodeId(value) {
    const normalized = String(value || '').trim();
    return normalized || 'local';
  }

  function retargetQueuedRuns(runIds, fromNodeId, toNodeId) {
    if (!Array.isArray(runIds)) throw new BadRequestError('runIds must be an array');
    if (runIds.length === 0) return { moved: 0 };

    const fromNode = normalizeQueueNodeId(fromNodeId);
    const toNode = normalizeQueueNodeId(toNodeId);
    // No-op when source and target resolve to the same node — moving a run to
    // its own node would emit a spurious queue:retargeted event (Codex N3
    // review NIT; the UI already guards, but a direct API call could hit it).
    if (fromNode === toNode) return { moved: 0 };
    const tx = db.transaction((ids) => {
      let moved = 0;
      for (const runId of ids) {
        const info = stmts.retargetQueued.run(toNode, runId, fromNode);
        moved += info.changes;
      }
      if (moved !== ids.length) {
        const err = new Error('Unable to retarget all queued runs; one or more runs changed state or node.');
        err.httpStatus = 409;
        throw err;
      }
      for (const runId of ids) {
        addRunEvent(runId, 'queue:retargeted', JSON.stringify({
          from_node: fromNode,
          to_node: toNode,
        }));
      }
      return { moved };
    });

    return tx(runIds);
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

  // P3-6: connect deriveOperatorProjectId diagnostic to eventBus.
  // Registered here (after addRunEvent is defined) so the callback can both
  // emit to the bus and persist to run_events in one place. Belt-and-suspenders:
  // console.warn is kept so the mismatch is always visible in server logs even
  // if the eventBus is absent. Both side effects are wrapped in try/catch so a
  // diagnostic failure never breaks the caller.
  setDeriveOperatorProjectIdDiagnostics(({ runId, joinPid, parsedPid, conversationId }) => {
    console.warn(`[runService] deriveOperatorProjectId mismatch run=${runId} joinPid=${joinPid} parsedPid=${parsedPid} cid=${conversationId}`);
    if (eventBus) {
      try {
        eventBus.emit('diagnostic:pm_project_mismatch', {
          runId, derived: joinPid, joined: parsedPid, conversationId,
        });
      } catch { /* ignore diagnostic failures */ }
    }
    try {
      addRunEvent(runId, 'diagnostic', JSON.stringify({
        subtype: 'pm_project_mismatch',
        joinPid,
        parsedPid,
        conversationId,
      }));
    } catch { /* ignore — diagnostic must not break callers */ }
  });

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
      // A project-operator filter ('pm' | 'operator') normalizes to the single
      // 'operator' layer (dual-read removed in Phase 4).
      layerClause = 'AND r.manager_layer = ?';
      params.push(isProjectLayer(layer) ? OPERATOR_LAYER : layer);
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
    let lookupId = conversationId;
    let fallbackId = null;
    const resolved = resolveOperatorConversationFromDb(conversationId);
    if (resolved?.instanceConversationId) {
      lookupId = resolved.instanceConversationId;
      fallbackId = resolved.legacySlotId || null;
    } else {
      const parsed = parseProjectConversationId(conversationId);
      lookupId = parsed ? `${OPERATOR_CONV_PREFIX}${parsed.projectId}` : conversationId;
    }
    const query = db.prepare(`
      SELECT r.*, ap.name as agent_name, ap.type as agent_type, ap.icon as agent_icon,
             t.title as task_title, t.project_id as project_id, p.name as project_name
      FROM runs r
      LEFT JOIN agent_profiles ap ON r.agent_profile_id = ap.id
      LEFT JOIN tasks t ON r.task_id = t.id
      LEFT JOIN projects p ON t.project_id = p.id
      WHERE r.conversation_id = ?
      ORDER BY r.created_at DESC LIMIT 1
    `);
    const hit = query.get(lookupId);
    if (!fallbackId || fallbackId === lookupId) return hit || null;
    const fallbackHit = query.get(fallbackId);
    if (!hit) return fallbackHit || null;
    if (!fallbackHit) return hit;
    // W-P5 R1 (Codex): mixed-era rows — a terminal instance-form run must not
    // shadow a legacy LIVE run (or vice versa). Prefer the live one; when both
    // are live or both terminal, the canonical (instance-form) row wins.
    const ACTIVE_RUN_STATUSES = new Set(['running', 'needs_input', 'queued', 'materializing']);
    const hitActive = ACTIVE_RUN_STATUSES.has(hit.status);
    const fallbackActive = ACTIVE_RUN_STATUSES.has(fallbackHit.status);
    if (!hitActive && fallbackActive) return fallbackHit;
    return hit;
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

  function updateRunMcpConfig(id, { mcp_config_path, mcp_config_snapshot }) {
    db.prepare(`UPDATE runs SET mcp_config_path = ?, mcp_config_snapshot = ? WHERE id = ?`)
      .run(mcp_config_path || null, mcp_config_snapshot || null, id);
  }

  // Phase 10C: bind a resolved preset + snapshot hash to an existing run
  // row. Snapshot JSON + file hashes live in run_preset_snapshots and are
  // written by presetService.persistSnapshot; only the ids live on runs.
  function updateRunPreset(id, { preset_id, preset_snapshot_hash }) {
    db.prepare(`UPDATE runs SET preset_id = ?, preset_snapshot_hash = ? WHERE id = ?`)
      .run(preset_id || null, preset_snapshot_hash || null, id);
  }

  return {
    listRuns, getRun, createRun,
    updateRunStatus, markRunStarted, updateRunResult,
    countRunning, countRunningOnNode, countRunningTotalOnNode,
    getOldestQueued, getOldestQueuedOnNode, getOldestQueuedReadyOnNode,
    getOldestMaterializableOnNode,
    countMaterializingOnNode, countMaterializingGlobal,
    claimQueuedRun, claimQueuedRunForMaterialization, restartMaterializationAttempt,
    markMaterializePending, updateRunMaterialized, markMaterializedReady,
    getProjectNodeWorkspace, markProjectNodeWorkspaceReady, markProjectNodeWorkspaceFailed,
    touchProjectNodeWorkspace, acquireMaterializationLease, touchMaterializationLease, releaseMaterializationLease,
    acquireWorkspaceRef, releaseWorkspaceRefByRun, releaseWorkspaceRefByRunAndPath,
    requeueMaterializingRun, forceRequeueTokenlessMaterializingRun,
    failMaterializingRun, forceFailTokenlessMaterializingRun, staleMaterializationLeases,
    setRetryCount,
    retargetQueuedRuns,
    updateManagerThreadId, updateClaudeSessionId,
    updateRunMcpConfig,
    updateRunPreset,
    resolveOperatorConversationId: resolveOperatorConversationIdWithDb,
    ensurePrimaryOperatorInstanceForProject,
    getOperatorInstance,
    getOperatorThreadForProject,
    setOperatorInstanceThread,
    deleteRun, addRunEvent, getRunEvents,
    getActiveManager, getActiveManagers, getRunByConversationId, getWorkerRuns,
  };
}

module.exports = {
  createRunService,
  deriveOperatorProjectId,
  setDeriveOperatorProjectIdDiagnostics,
  VALID_STATUSES,
  VALID_TRANSITIONS,
};
