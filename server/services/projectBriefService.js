const { BadRequestError, NotFoundError } = require('../utils/errors');

/**
 * Project Brief service (v3 Phase 1).
 *
 * A project_brief is the persistent, per-project memory used by the v3
 * manager redesign. See docs/specs/manager-v3-multilayer.md §7.
 *
 * - Created on-demand (first-read-or-first-write upserts a row).
 * - conventions + known_pitfalls are injected as part of the first user
 *   message when a manager session starts (Top today, PM in Phase 3a).
 * - pm_thread_id is written by the PM lazy-creation path (Phase 3a) when
 *   Codex emits thread.started; null until then.
 * - pm_adapter records the *actual* adapter that owns the current
 *   pm_thread_id. May differ from projects.preferred_pm_adapter until
 *   the next reset.
 *
 * CRITICAL: project_briefs.pm_thread_id is NOT the same concept as
 * runs.manager_thread_id (from migration 005). The former is per-project
 * (persistent across sessions); the latter is per-manager-run (transient).
 * See spec §8.1.
 */

const VALID_PM_ADAPTERS = ['claude', 'codex'];

function createProjectBriefService(db) {
  const stmts = {
    getById: db.prepare('SELECT * FROM project_briefs WHERE project_id = ?'),
    insert: db.prepare(`
      INSERT INTO project_briefs (
        project_id, conventions, known_pitfalls, pm_thread_id, pm_adapter,
        created_at, updated_at
      )
      VALUES (@project_id, @conventions, @known_pitfalls, @pm_thread_id, @pm_adapter,
              datetime('now'), datetime('now'))
    `),
    // dynamic update — see updateBrief() below
    delete: db.prepare('DELETE FROM project_briefs WHERE project_id = ?'),
    clearPmThread: db.prepare(`
      UPDATE project_briefs
         SET pm_thread_id = NULL, pm_adapter = NULL, updated_at = datetime('now')
       WHERE project_id = ?
    `),
    setPmThread: db.prepare(`
      UPDATE project_briefs
         SET pm_thread_id = @pm_thread_id, pm_adapter = @pm_adapter, updated_at = datetime('now')
       WHERE project_id = @project_id
    `),
  };

  /**
   * Get the brief for a project. Returns null if none exists yet.
   * Does NOT auto-create; callers that need an auto-created row should
   * use ensureBrief().
   */
  function getBrief(projectId) {
    if (!projectId) throw new BadRequestError('project_id is required');
    return stmts.getById.get(projectId) || null;
  }

  /**
   * Ensure a row exists for the project, creating an empty one if needed.
   * Idempotent. Returns the brief row.
   */
  function ensureBrief(projectId) {
    if (!projectId) throw new BadRequestError('project_id is required');
    let brief = stmts.getById.get(projectId);
    if (brief) return brief;
    stmts.insert.run({
      project_id: projectId,
      conventions: null,
      known_pitfalls: null,
      pm_thread_id: null,
      pm_adapter: null,
    });
    return stmts.getById.get(projectId);
  }

  const BRIEF_UPDATABLE = ['conventions', 'known_pitfalls'];

  /**
   * Update brief content (conventions / known_pitfalls). Does NOT touch
   * PM thread fields — those are managed by setPmThread / clearPmThread.
   */
  function updateBrief(projectId, fields) {
    ensureBrief(projectId);
    const setClauses = [];
    const params = { project_id: projectId };
    for (const col of BRIEF_UPDATABLE) {
      if (col in fields) {
        setClauses.push(`${col} = @${col}`);
        params[col] = fields[col] ?? null;
      }
    }
    if (setClauses.length === 0) return stmts.getById.get(projectId);
    setClauses.push("updated_at = datetime('now')");
    db.prepare(
      `UPDATE project_briefs SET ${setClauses.join(', ')} WHERE project_id = @project_id`
    ).run(params);
    return stmts.getById.get(projectId);
  }

  /**
   * Record a newly-created PM thread for this project. Called by the
   * lazy-creation path in the router (Phase 3a). Writes both pm_thread_id
   * and the actual adapter that owns that thread.
   */
  function setPmThread(projectId, { pm_thread_id, pm_adapter }) {
    if (!pm_thread_id) throw new BadRequestError('pm_thread_id is required');
    if (!VALID_PM_ADAPTERS.includes(pm_adapter)) {
      throw new BadRequestError(`Invalid pm_adapter: ${pm_adapter}`);
    }
    ensureBrief(projectId);
    stmts.setPmThread.run({ project_id: projectId, pm_thread_id, pm_adapter });
    return stmts.getById.get(projectId);
  }

  /**
   * Clear the PM thread reference. Called by pmCleanupService (Phase 3a)
   * on disable / adapter switch / project delete / manual reset.
   * Idempotent.
   */
  function clearPmThread(projectId) {
    const brief = stmts.getById.get(projectId);
    if (!brief) return null;
    stmts.clearPmThread.run(projectId);
    return stmts.getById.get(projectId);
  }

  function deleteBrief(projectId) {
    stmts.delete.run(projectId);
  }

  return {
    getBrief,
    ensureBrief,
    updateBrief,
    setPmThread,
    clearPmThread,
    deleteBrief,
  };
}

module.exports = { createProjectBriefService };
