'use strict';

/**
 * Central resolver for the working directory used to spawn agent processes
 * (managers, PMs, workers, opencode sessions).
 *
 * This is the SINGLE source of truth for spawn-cwd resolution. All spawn
 * paths (streamJsonEngine, lifecycleService worker exec, pmSpawnService,
 * codexAdapter, routes/manager boot resume + manager start, messageService
 * → opencode) MUST route through here so that the no-dir policy is defined
 * in exactly one place.
 *
 * No-dir policy (documented, behavior-preserving):
 *   A workspace directory is OPTIONAL. Project-less tasks/sessions (tasks with
 *   no project_id, or projects whose `directory` is null) are an allowed,
 *   pre-existing mode — they spawn in the SERVER cwd (process.cwd()). This
 *   matches the historical fallback (e.g. lifecycleService worker exec and
 *   pmSpawnService both did `project.directory || process.cwd()`), which the
 *   existing test suite treats as correct behavior. Do NOT change this.
 *
 * Folder-less fail-closed hook (P-A0, structure only — NOT wired yet):
 *   `requireExplicit: true` makes a missing workspaceDir throw instead of
 *   falling back to server cwd. This is the seam P-A1 will use to enforce an
 *   explicit binding model. There is intentionally NO caller passing
 *   requireExplicit:true today; this branch exists only so the policy switch
 *   lives in one place.
 *
 * NOTE: This resolver does NOT validate existence or path-safety of the
 * directory. Existence checks (streamJsonEngine's fs.existsSync guard) and
 * the manager-start allowlist (home/server-root containment in
 * routes/manager.js) remain the callers' responsibility — this helper only
 * decides WHICH directory string to use, preserving each caller's downstream
 * checks unchanged.
 *
 * @param {object} [opts]
 * @param {string|null|undefined} [opts.workspaceDir] explicit workspace dir
 *   (e.g. git worktree path, project.directory, validated request cwd).
 * @param {boolean} [opts.requireExplicit=false] when true, throw if no
 *   workspaceDir is provided (folder-less fail-closed; not wired yet).
 * @returns {string} the resolved spawn cwd.
 */
function resolveSpawnCwd({ workspaceDir, requireExplicit = false } = {}) {
  if (workspaceDir) return workspaceDir;
  if (requireExplicit) {
    throw new Error('resolveSpawnCwd: workspaceDir is required (requireExplicit)');
  }
  // No-dir policy: project-less tasks/sessions spawn in the server cwd.
  return process.cwd();
}

module.exports = { resolveSpawnCwd };
