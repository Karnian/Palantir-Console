'use strict';

const { randomUUID } = require('crypto');
const { BadRequestError, ConflictError, NotFoundError } = require('../utils/errors');
const { conversationIdForProject } = require('../utils/conversationId');

const VALID_REF_ROLES = new Set(['primary', 'reference']);
const VALID_PREFERRED_ADAPTERS = new Set(['codex', 'claude']);

function normalizeRole(value) {
  if (typeof value !== 'string' || !VALID_REF_ROLES.has(value)) {
    throw new BadRequestError('role must be one of primary|reference');
  }
  return value;
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestError(`${name} is required`);
  }
  return value.trim();
}

function normalizePreferredAdapter(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !VALID_PREFERRED_ADAPTERS.has(value)) {
    throw new BadRequestError('preferred_adapter must be one of codex|claude|null');
  }
  return value;
}

function uniqueConflictForRef(err) {
  if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || err?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    throw new ConflictError('operator instance ref already exists or primary ownership is already assigned');
  }
  throw err;
}

function createOperatorInstanceService(db, {
  runService,
  managerRegistry,
  logger,
} = {}) {
  const log = logger || (() => {});
  const stmts = {
    listInstances: db.prepare(`
      SELECT oi.*,
             op.name AS profile_name,
             (SELECT COUNT(*) FROM operator_schedules os
               WHERE os.operator_instance_id=oi.id AND os.archived_at IS NULL AND os.enabled=1) AS schedule_count,
             (SELECT MIN(os.next_fire_at) FROM operator_schedules os
               WHERE os.operator_instance_id=oi.id AND os.archived_at IS NULL AND os.enabled=1) AS next_schedule_at
      FROM operator_instances oi
      LEFT JOIN operator_profiles op ON op.id=oi.profile_id
      WHERE oi.archived_at IS NULL
      ORDER BY oi.updated_at DESC, oi.created_at DESC, oi.id ASC
    `),
    getInstance: db.prepare(`
      SELECT oi.*,
             op.name AS profile_name,
             (SELECT COUNT(*) FROM operator_schedules os
               WHERE os.operator_instance_id=oi.id AND os.archived_at IS NULL AND os.enabled=1) AS schedule_count,
             (SELECT MIN(os.next_fire_at) FROM operator_schedules os
               WHERE os.operator_instance_id=oi.id AND os.archived_at IS NULL AND os.enabled=1) AS next_schedule_at
      FROM operator_instances oi
      LEFT JOIN operator_profiles op ON op.id=oi.profile_id
      WHERE oi.id=?
    `),
    listInstanceIdsForProfile: db.prepare(`
      SELECT id
      FROM operator_instances
      WHERE profile_id = ? AND archived_at IS NULL
    `),
    listInstanceIdsForProject: db.prepare(`
      SELECT r.instance_id AS id
      FROM operator_codebase_refs r
      JOIN operator_instances oi ON oi.id = r.instance_id
      WHERE r.project_id = ? AND oi.archived_at IS NULL
      ORDER BY r.instance_id
    `),
    getPrimaryProjectIdForInstance: db.prepare(`
      SELECT project_id
      FROM operator_codebase_refs
      WHERE instance_id = ? AND role = 'primary'
      LIMIT 1
    `),
    getProfileById: db.prepare('SELECT id, name FROM operator_profiles WHERE id = ?'),
    insertPrivateProfile: db.prepare(`
      INSERT INTO operator_profiles (id, name, description, persona, capabilities_json, is_private)
      VALUES (@id, @name, NULL, NULL, '[]', @is_private)
    `),
    insertInstance: db.prepare(`
      INSERT INTO operator_instances (id, profile_id, display_name, preferred_adapter)
      VALUES (@id, @profile_id, @display_name, @preferred_adapter)
    `),
    updateInstanceProfile: db.prepare(`
      UPDATE operator_instances
      SET profile_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `),
    updatePreferredAdapter: db.prepare(`
      UPDATE operator_instances
      SET preferred_adapter = ?, updated_at = datetime('now')
      WHERE id = ?
    `),
    getProject: db.prepare('SELECT * FROM projects WHERE id = ?'),
    listRefs: db.prepare(`
      SELECT r.instance_id,
             r.project_id,
             r.role,
             r.created_at,
             p.name AS project_name,
             p.directory AS project_directory,
             p.node_id AS project_node_id,
             p.source_type AS project_source_type
      FROM operator_codebase_refs r
      JOIN projects p ON p.id = r.project_id
      ORDER BY CASE r.role WHEN 'primary' THEN 0 ELSE 1 END, p.name COLLATE NOCASE, p.id
    `),
    listRefsForInstance: db.prepare(`
      SELECT r.instance_id,
             r.project_id,
             r.role,
             r.created_at,
             p.name AS project_name,
             p.directory AS project_directory,
             p.node_id AS project_node_id,
             p.source_type AS project_source_type
      FROM operator_codebase_refs r
      JOIN projects p ON p.id = r.project_id
      WHERE r.instance_id = ?
      ORDER BY CASE r.role WHEN 'primary' THEN 0 ELSE 1 END, p.name COLLATE NOCASE, p.id
    `),
    getRef: db.prepare(`
      SELECT r.*, p.name AS project_name
      FROM operator_codebase_refs r
      LEFT JOIN projects p ON p.id = r.project_id
      WHERE r.instance_id = ? AND r.project_id = ?
    `),
    insertRef: db.prepare(`
      INSERT INTO operator_codebase_refs (instance_id, project_id, role)
      VALUES (?, ?, ?)
    `),
    deleteRef: db.prepare(`
      DELETE FROM operator_codebase_refs
      WHERE instance_id = ? AND project_id = ?
    `),
    refsForProject: db.prepare(`
      SELECT r.instance_id,
             r.project_id,
             r.role,
             oi.watchlist_version
      FROM operator_codebase_refs r
      JOIN operator_instances oi ON oi.id = r.instance_id
      WHERE r.project_id = ?
      ORDER BY r.instance_id
    `),
    deleteRefsForProject: db.prepare('DELETE FROM operator_codebase_refs WHERE project_id = ?'),
    bumpVersion: db.prepare(`
      UPDATE operator_instances
         SET watchlist_version = watchlist_version + 1,
             updated_at = datetime('now')
       WHERE id = ?
    `),
    getVersion: db.prepare('SELECT watchlist_version FROM operator_instances WHERE id = ?'),
    clearThread: db.prepare(`
      UPDATE operator_instances
         SET thread_id = NULL,
             pm_adapter = NULL,
             node_id = NULL,
             cwd = NULL,
             source_generation = NULL,
             source_hash = NULL,
             workspace_path = NULL,
             updated_at = datetime('now')
       WHERE id = ?
    `),
    countRefsForInstance: db.prepare(`
      SELECT COUNT(*) AS count
      FROM operator_codebase_refs
      WHERE instance_id = ?
    `),
    primaryForProject: db.prepare(`
      SELECT oi.*, r.project_id AS primary_project_id
      FROM operator_codebase_refs r
      JOIN operator_instances oi ON oi.id = r.instance_id
      WHERE r.project_id = ?
        AND r.role = 'primary'
        AND oi.archived_at IS NULL
      LIMIT 1
    `),
    latestRunForInstance: db.prepare(`
      SELECT id
      FROM runs
      WHERE operator_instance_id = ?
         OR conversation_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `),
    // F-1: Codex Fast Mode per-instance toggle. No watchlist bump — fast_mode
    // does not invalidate refs; the tier is re-resolved per turn at spawn time.
    setFastMode: db.prepare(`
      UPDATE operator_instances
         SET fast_mode = ?,
             updated_at = datetime('now')
       WHERE id = ?
    `),
    archiveInstance: db.prepare(`
      UPDATE operator_instances
         SET archived_at = ?,
             updated_at = ?
       WHERE id = ? AND archived_at IS NULL
    `),
    deleteAllRefs: db.prepare(`
      DELETE FROM operator_codebase_refs
      WHERE instance_id = ?
    `),
    schedulesForArchive: db.prepare(`
      SELECT id
      FROM operator_schedules
      WHERE operator_instance_id = ? AND archived_at IS NULL
      ORDER BY id
    `),
    archiveSchedules: db.prepare(`
      UPDATE operator_schedules
         SET archived_at = ?,
             enabled = 0,
             next_fire_at = NULL,
             updated_at = ?
       WHERE operator_instance_id = ? AND archived_at IS NULL
    `),
    cancelPendingInvocations: db.prepare(`
      UPDATE operator_invocations
         SET status = 'cancelled',
             claim_token = NULL,
             locked_at = NULL,
             waiting_reason = 'operator_archived',
             last_error = COALESCE(last_error, 'Operator instance archived before delivery'),
             completed_at = ?,
             updated_at = ?
       WHERE operator_instance_id = ?
         AND status IN ('pending', 'claimed')
    `),
    // #453 leaves delivering/running alone because the adapter may still be
    // working. That premise does not hold here: archive runs AFTER a successful
    // dispose, so no completion event is coming. Leaving them active would hold
    // the per-Operator unique-index slot forever. They crossed the adapter
    // boundary, so they settle as `uncertain` — the same classification
    // migration 068 uses for exactly this case — not as `cancelled`.
    uncertainInflightInvocations: db.prepare(`
      UPDATE operator_invocations
         SET status = 'uncertain',
             claim_token = NULL,
             locked_at = NULL,
             waiting_reason = 'operator_archived',
             last_error = COALESCE(last_error, 'Operator instance archived while a turn was in flight'),
             completed_at = ?,
             updated_at = ?
       WHERE operator_instance_id = ?
         AND status IN ('delivering', 'running')
    `),
  };

  function normalizeRef(row) {
    return {
      instance_id: row.instance_id,
      project_id: row.project_id,
      role: row.role,
      created_at: row.created_at,
      project: {
        id: row.project_id,
        name: row.project_name || null,
        directory: row.project_directory || null,
        node_id: row.project_node_id || null,
        source_type: row.project_source_type || null,
      },
    };
  }

  function withRefs(instance) {
    if (!instance) return null;
    return {
      ...instance,
      watchlist_version: Number(instance.watchlist_version) || 0,
      refs: stmts.listRefsForInstance.all(instance.id).map(normalizeRef),
    };
  }

  function assertInstance(id) {
    const instanceId = requiredString(id, 'instance id');
    const instance = stmts.getInstance.get(instanceId);
    if (!instance) throw new NotFoundError(`Operator instance not found: ${instanceId}`);
    return instance;
  }

  function archivedInstanceError(instanceId) {
    const err = new ConflictError(`Operator instance is archived: ${instanceId}`);
    err.httpStatus = 409;
    err.code = 'OPERATOR_ARCHIVED';
    err.retryable = false;
    return err;
  }

  function assertActiveInstance(id) {
    const instance = assertInstance(id);
    if (instance.archived_at) throw archivedInstanceError(instance.id);
    return withRefs(instance);
  }

  function assertProject(id) {
    const projectId = requiredString(id, 'project_id');
    const project = stmts.getProject.get(projectId);
    if (!project) throw new NotFoundError(`Project not found: ${projectId}`);
    return project;
  }

  function bumpWatchlistVersion(instanceId) {
    // W-P6a R1 (Codex): version bump is the LIVE-thread invalidation signal
    // (brief §3.E) — a non-live instance re-reads its refs at next spawn, so
    // an unconditional bump violates the contract.
    if (!activeRunIdForInstance(instanceId)) {
      return Number(stmts.getVersion.get(instanceId)?.watchlist_version) || 0;
    }
    stmts.bumpVersion.run(instanceId);
    return Number(stmts.getVersion.get(instanceId)?.watchlist_version) || 0;
  }

  function withTransaction(fn) {
    return db.transaction(fn)();
  }

  function activeRunIdForInstance(instanceId) {
    if (!managerRegistry || typeof managerRegistry.getActiveRunId !== 'function') return null;
    try {
      return managerRegistry.getActiveRunId(conversationIdForProject(instanceId)) || null;
    } catch {
      return null;
    }
  }

  function latestRunIdForInstance(instanceId) {
    try {
      return stmts.latestRunForInstance.get(instanceId, conversationIdForProject(instanceId))?.id || null;
    } catch {
      return null;
    }
  }

  function annotateInstance(instanceId, payload, { latestFallback = false } = {}) {
    if (!runService || typeof runService.addRunEvent !== 'function') return;
    const runId = activeRunIdForInstance(instanceId) || (latestFallback ? latestRunIdForInstance(instanceId) : null);
    if (!runId) return;
    try {
      runService.addRunEvent(runId, 'operator:watchlist_changed', JSON.stringify(payload));
    } catch (err) {
      log(`operator watch-list annotation failed instance=${instanceId}: ${err.message}`);
    }
  }

  function listInstances() {
    return stmts.listInstances.all().map(withRefs);
  }

  function getInstance(id) {
    return withRefs(assertInstance(id));
  }

  function listInstanceIdsForProfile(profileId) {
    return stmts.listInstanceIdsForProfile.all(profileId).map((row) => row.id);
  }

  function listInstanceIdsForProject(projectId) {
    const normalizedProjectId = requiredString(projectId, 'project_id');
    return stmts.listInstanceIdsForProject.all(normalizedProjectId).map((row) => row.id);
  }

  function getPrimaryProjectIdForInstance(instanceId) {
    return stmts.getPrimaryProjectIdForInstance.get(instanceId)?.project_id || null;
  }

  function setProfileId(instanceId, profileId) {
    const instance = assertActiveInstance(instanceId);
    const profile = stmts.getProfileById.get(profileId);
    if (!profile) throw new NotFoundError(`operator profile not found: ${profileId}`);
    stmts.updateInstanceProfile.run(profile.id, instance.id);
    return withRefs(stmts.getInstance.get(instance.id));
  }

  function preparePreferredAdapterUpdate(instanceId, value) {
    const instance = assertActiveInstance(instanceId);
    const preferredAdapter = normalizePreferredAdapter(value);
    return {
      instance,
      preferredAdapter,
      changed: (instance.preferred_adapter || null) !== preferredAdapter,
    };
  }

  function setPreferredAdapter(instanceId, value) {
    const instance = assertActiveInstance(instanceId);
    const preferredAdapter = normalizePreferredAdapter(value);
    stmts.updatePreferredAdapter.run(preferredAdapter, instance.id);
    return withRefs(stmts.getInstance.get(instance.id));
  }

  function createInstance(input = {}) {
    const profileId = requiredString(input.profile_id, 'profile_id');
    const profile = stmts.getProfileById.get(profileId);
    if (!profile) throw new NotFoundError(`operator profile not found: ${profileId}`);
    const displayName = input.display_name == null || String(input.display_name).trim() === ''
      ? profile.name
      : requiredString(input.display_name, 'display_name');
    if (displayName.length > 120) throw new BadRequestError('display_name must be at most 120 characters');
    const primaryProjectId = input.primary_project_id == null || input.primary_project_id === ''
      ? null
      : requiredString(input.primary_project_id, 'primary_project_id');
    const preferredAdapter = normalizePreferredAdapter(input.preferred_adapter);
    if (primaryProjectId) assertProject(primaryProjectId);
    const id = `oi_${randomUUID()}`;
    db.transaction(() => {
      stmts.insertInstance.run({
        id,
        profile_id: profile.id,
        display_name: displayName,
        preferred_adapter: preferredAdapter,
      });
      if (primaryProjectId) {
        try {
          stmts.insertRef.run(id, primaryProjectId, 'primary');
        } catch (err) {
          uniqueConflictForRef(err);
        }
      }
    })();
    return withRefs(stmts.getInstance.get(id));
  }

  function createPrivateProfileFor(instanceId) {
    const instance = assertActiveInstance(instanceId);
    const newId = `op_priv_${randomUUID()}`;
    const newName = `Private: ${instance.id} (${randomUUID().slice(0, 8)})`;
    db.transaction(() => {
      stmts.insertPrivateProfile.run({ id: newId, name: newName, is_private: 1 });
      const result = stmts.updateInstanceProfile.run(newId, instance.id);
      if (result.changes !== 1) throw new Error(`instance profile update failed for ${instance.id}`);
    })();
    const updated = getInstance(instance.id);
    if (updated.profile_id !== newId) {
      throw new Error(`postcondition: instance ${instance.id} missing private profile`);
    }
    return updated;
  }

  function getPrimaryInstanceForProject(projectId) {
    if (!projectId) return null;
    const row = stmts.primaryForProject.get(projectId);
    if (!row) return null;
    return {
      ...row,
      instanceConversationId: conversationIdForProject(row.id),
      legacySlotId: conversationIdForProject(projectId),
      primaryProjectId: projectId,
    };
  }

  function getLivePrimaryInstanceForProject(projectId) {
    const primary = getPrimaryInstanceForProject(projectId);
    if (!primary) return null;
    const liveRunId = activeRunIdForInstance(primary.id);
    return { ...primary, liveRunId, live: Boolean(liveRunId) };
  }

  function addRef(instanceId, input = {}) {
    const instance = assertActiveInstance(instanceId);
    const project = assertProject(input.project_id);
    const role = normalizeRole(input.role);
    let version = 0;
    const tx = db.transaction(() => {
      try {
        stmts.insertRef.run(instance.id, project.id, role);
      } catch (err) {
        uniqueConflictForRef(err);
      }
      version = bumpWatchlistVersion(instance.id);
    });
    tx();
    annotateInstance(instance.id, {
      action: 'ref_added',
      instance_id: instance.id,
      project_id: project.id,
      role,
      watchlist_version: version,
    });
    return withRefs(stmts.getInstance.get(instance.id));
  }

  function removeRef(instanceId, projectId) {
    const instance = assertActiveInstance(instanceId);
    const normalizedProjectId = requiredString(projectId, 'projectId');
    const ref = stmts.getRef.get(instance.id, normalizedProjectId);
    if (!ref) {
      throw new NotFoundError(`Operator instance ref not found: ${instance.id}/${normalizedProjectId}`);
    }
    if (ref.role === 'primary') {
      throw new ConflictError('primary ref removal is not allowed');
    }
    let version = 0;
    const tx = db.transaction(() => {
      stmts.deleteRef.run(instance.id, normalizedProjectId);
      version = bumpWatchlistVersion(instance.id);
    });
    tx();
    annotateInstance(instance.id, {
      action: 'ref_removed',
      instance_id: instance.id,
      project_id: normalizedProjectId,
      role: ref.role,
      watchlist_version: version,
    });
    return withRefs(stmts.getInstance.get(instance.id));
  }

  function removeRefsForProject(projectId) {
    const project = assertProject(projectId);
    const refs = stmts.refsForProject.all(project.id);
    if (refs.length === 0) return { removed: 0, affected: [] };

    const affected = [];
    const tx = db.transaction(() => {
      stmts.deleteRefsForProject.run(project.id);
      for (const ref of refs) {
        const version = bumpWatchlistVersion(ref.instance_id);
        if (ref.role === 'primary') stmts.clearThread.run(ref.instance_id);
        const remainingRefs = Number(stmts.countRefsForInstance.get(ref.instance_id)?.count) || 0;
        affected.push({
          instance_id: ref.instance_id,
          project_id: project.id,
          role: ref.role,
          watchlist_version: version,
          orphan: remainingRefs === 0,
        });
      }
    });
    tx();

    for (const item of affected) {
      annotateInstance(item.instance_id, {
        action: 'project_deleted_ref_removed',
        instance_id: item.instance_id,
        project_id: item.project_id,
        role: item.role,
        watchlist_version: item.watchlist_version,
        orphan: item.orphan,
      }, { latestFallback: item.role === 'primary' || item.orphan });
    }

    return { removed: refs.length, affected };
  }

  // F-1: set the per-instance Codex Fast Mode toggle. fastMode is normalized to
  // 1 (fast) | 0 (standard) | null (follow PALANTIR_CODEX_FAST env). The tier is
  // read fresh per turn by the codex adapter's resolver, so a live Operator picks
  // up the change on its next turn without a re-spawn.
  function setFastMode(instanceId, fastMode) {
    const instance = assertActiveInstance(instanceId);
    let value;
    if (fastMode === null || fastMode === undefined) value = null;
    else value = fastMode ? 1 : 0;
    stmts.setFastMode.run(value, instance.id);
    return withRefs(stmts.getInstance.get(instance.id));
  }

  function archiveDatabaseState(instanceId, {
    now = new Date(),
    terminalizeQueued = null,
  } = {}) {
    const date = now instanceof Date ? now : new Date(now);
    if (!Number.isFinite(date.getTime())) throw new BadRequestError('now must be a valid timestamp');
    const archivedAt = date.toISOString();

    return db.transaction(() => {
      const current = assertInstance(instanceId);
      if (current.archived_at) {
        return {
          instance: withRefs(current),
          already_archived: true,
          affected_codebases: [],
          archived_schedule_ids: [],
          cancelled_invocation_count: 0,
          uncertain_invocation_count: 0,
          terminalized_queue_messages: [],
        };
      }

      const refs = stmts.listRefsForInstance.all(current.id).map(normalizeRef);
      const scheduleIds = stmts.schedulesForArchive.all(current.id).map((row) => row.id);
      const archiveResult = stmts.archiveInstance.run(archivedAt, archivedAt, current.id);
      if (archiveResult.changes !== 1) {
        throw new ConflictError(`Operator instance archive lost a concurrent update: ${current.id}`);
      }
      stmts.deleteAllRefs.run(current.id);
      stmts.archiveSchedules.run(archivedAt, archivedAt, current.id);
      const cancelledInvocations = stmts.cancelPendingInvocations.run(
        archivedAt,
        archivedAt,
        current.id,
      );
      const uncertainInvocations = stmts.uncertainInflightInvocations.run(
        archivedAt,
        archivedAt,
        current.id,
      );
      // Both the canonical `operator:<instanceId>` conversation AND every legacy
      // `operator:<projectId>` alias this instance answered for. A legacy row
      // left behind would be drained after the refs are gone, which ensures a
      // REPLACEMENT instance and delivers the archived Operator's backlog to it.
      const queueConversationIds = [
        conversationIdForProject(current.id),
        ...refs.map((ref) => conversationIdForProject(ref.project_id)),
      ].filter((value, index, all) => value && all.indexOf(value) === index);
      const terminalizedQueueMessages = typeof terminalizeQueued === 'function'
        ? queueConversationIds.flatMap(
            (conversationId) => terminalizeQueued(conversationId, { now: archivedAt }),
          )
        : [];

      return {
        instance: withRefs(stmts.getInstance.get(current.id)),
        already_archived: false,
        affected_codebases: refs.map((ref) => ({
          id: ref.project_id,
          name: ref.project?.name || null,
          role: ref.role,
        })),
        archived_schedule_ids: scheduleIds,
        cancelled_invocation_count: cancelledInvocations.changes,
        uncertain_invocation_count: uncertainInvocations.changes,
        terminalized_queue_messages: terminalizedQueueMessages,
      };
    }).immediate();
  }

  return {
    withTransaction,
    listInstances,
    getInstance,
    assertActiveInstance,
    listInstanceIdsForProfile,
    listInstanceIdsForProject,
    getPrimaryProjectIdForInstance,
    createInstance,
    setProfileId,
    preparePreferredAdapterUpdate,
    setPreferredAdapter,
    createPrivateProfileFor,
    getPrimaryInstanceForProject,
    getLivePrimaryInstanceForProject,
    addRef,
    removeRef,
    removeRefsForProject,
    setFastMode,
    archiveDatabaseState,
  };
}

module.exports = { createOperatorInstanceService };
