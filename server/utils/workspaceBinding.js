'use strict';

/**
 * Operator workspace binding contract (Operator P-B, slice P-B0).
 *
 * brief §2: `OperatorInstance = Profile × WorkspaceBinding(none|folder) ×
 * ExecutionMode`. A folder-less specialist is `workspace:none`; today's coder PM
 * is `workspace:folder`.
 *
 * Safety inversion (brief §2 + §8 NO-GO #2): a `workspace:none` operator must
 * NOT touch folder-bound surfaces — spawn cwd, shell, direct FS, a projects row,
 * a git worktree, the cross-project scan, L1 (workspace) memory capture, or the
 * `pm:<projectId>` project route. A folder-less agent inheriting `process.cwd()`
 * + shell would be *more* dangerous than a bound one (no boundary to violate),
 * so the rule is fail-closed: deny by default, never a silent fallback.
 *
 * This module is the SINGLE contract for that rule — mirroring how
 * `resolveSpawnCwd({ requireExplicit })` (#225) put the cwd policy switch in one
 * place. It is intentionally NOT WIRED yet: there is no caller today. The
 * specialist spawn path (P-B2) will call `assertWorkspaceBound` at each
 * folder-bound surface. The contract + tests land first so P-B2 builds on a
 * fixed, reviewed boundary rather than scattering ad-hoc checks.
 */

const WORKSPACE_BINDING = Object.freeze({ NONE: 'none', FOLDER: 'folder' });

// Surfaces that REQUIRE a folder binding. Reaching any of these from a
// workspace:none operator is a hard, fail-closed error.
const WORKSPACE_BOUND_SURFACES = Object.freeze([
  'spawn_cwd',      // working dir for a process spawn
  'shell',          // shell command execution
  'fs',             // direct filesystem access
  'project_scope',  // a projects row OR any project-scoped row/API access —
                    // tasks.project_id, project_briefs, /api/projects/:id/*,
                    // project skill-pack bindings (Codex review: not just one row)
  'worktree',       // a git worktree
  'xproject_scan',  // cross-project memory scan
  'l1_capture',     // workspace (L1) memory capture
  'project_route',  // pm:<projectId> conversation routing
]);

const SURFACE_SET = new Set(WORKSPACE_BOUND_SURFACES);
const BINDING_SET = new Set([WORKSPACE_BINDING.NONE, WORKSPACE_BINDING.FOLDER]);

/**
 * Assert that an operator with `binding` may access `surface`.
 *
 * - `folder` → always allowed (legacy/coder behavior preserved verbatim).
 * - `none`   → throws (code `WORKSPACE_UNBOUND`) for any workspace-bound surface.
 * - unknown `surface` → throws (typo guard; never silently allow an unlisted one).
 * - unknown `binding` → throws (only `none`|`folder` are valid).
 *
 * @param {'none'|'folder'} binding
 * @param {string} surface  one of WORKSPACE_BOUND_SURFACES
 * @returns {void}
 */
function assertWorkspaceBound(binding, surface) {
  if (!SURFACE_SET.has(surface)) {
    throw new Error(`assertWorkspaceBound: unknown surface "${surface}"`);
  }
  if (!BINDING_SET.has(binding)) {
    throw new Error(`assertWorkspaceBound: invalid binding "${binding}" (expected none|folder)`);
  }
  if (binding === WORKSPACE_BINDING.FOLDER) return; // bound → allowed
  // binding === none → fail-closed
  const e = new Error(`workspace:none operator cannot access folder-bound surface "${surface}"`);
  e.code = 'WORKSPACE_UNBOUND';
  throw e;
}

module.exports = { WORKSPACE_BINDING, WORKSPACE_BOUND_SURFACES, assertWorkspaceBound };
