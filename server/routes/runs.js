const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { asyncHandler } = require('../middleware/asyncHandler');

// R2-B.2: maximum unified-diff payload size, in bytes. Diffs larger than
// this are truncated and the client is warned via a `truncated` flag so
// long-running generation sessions don't push megabytes of text across
// the wire on every poll. 1 MiB matches the ceiling noted in the R2-B
// plan; change here + in the route tests if this ever moves.
const DIFF_MAX_BYTES = 1 * 1024 * 1024;
// Walltime cap — we never want `git diff` to hang the runs router.
const DIFF_TIMEOUT_MS = 10 * 1000;

/**
 * Run `git diff` inside a worktree and return the unified diff output
 * (stdout) as UTF-8 text. Uses `execFile` (no shell) with an explicit
 * maxBuffer so we always return a predictable shape, even when the
 * worktree's diff would exceed `DIFF_MAX_BYTES`.
 *
 * Resolves to `{ diff: string, truncated: boolean, empty: boolean }`.
 *   - `empty`     — worktree had no tracked changes (git diff produced "")
 *   - `truncated` — output hit `DIFF_MAX_BYTES`; callers should surface a
 *     warning. The diff text returned is the prefix that fit.
 *
 * Rejects only on non-zero exit / git not available / timeout. Callers
 * upstream translate those into a 502 with `{ diff: null, reason }`.
 */
function runGitDiff(cwd) {
  return new Promise((resolve, reject) => {
    // `git diff HEAD --no-color` covers staged + unstaged changes
    // relative to the worktree's current commit — exactly what the
    // user edited since the run started. `--no-color` keeps the text
    // parseable / displayable without ANSI escapes.
    //
    // Security hardening (Codex R2-B review, High):
    //   --no-ext-diff  — disables `diff.external` / `GIT_EXTERNAL_DIFF`.
    //                    Without this, a repo carrying a hostile git
    //                    config could have git spawn an arbitrary
    //                    external program on every diff. The endpoint
    //                    runs with server process privileges, so this
    //                    is a remote-code-exec primitive for any user
    //                    who can point a project at a malicious repo.
    //   --no-textconv  — disables `textconv` filters configured via
    //                    gitattributes. Same vector (arbitrary binary
    //                    invocation on binary files like .png/.pdf).
    // We also wipe `GIT_EXTERNAL_DIFF` from the child env as
    // belt-and-suspenders — `--no-ext-diff` should cover it, but an
    // older git build or a future CLI flag regression could put the
    // door back. Explicitly clearing the env var closes both.
    execFile(
      'git',
      ['diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD'],
      {
        cwd,
        timeout: DIFF_TIMEOUT_MS,
        maxBuffer: DIFF_MAX_BYTES + 1024,
        encoding: 'utf-8',
        env: { ...process.env, GIT_EXTERNAL_DIFF: '', GIT_TEXTCONV_DIFF: '' },
      },
      (err, stdout) => {
        if (err) {
          // ERR_CHILD_PROCESS_STDIO_MAXBUFFER: buffer exceeded cap.
          // stdout may still contain a usable prefix.
          if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            const text = String(stdout || '').slice(0, DIFF_MAX_BYTES);
            return resolve({ diff: text, truncated: true, empty: false });
          }
          return reject(err);
        }
        const text = String(stdout || '');
        if (text.length > DIFF_MAX_BYTES) {
          return resolve({ diff: text.slice(0, DIFF_MAX_BYTES), truncated: true, empty: false });
        }
        resolve({ diff: text, truncated: false, empty: text.length === 0 });
      },
    );
  });
}

/**
 * Phase 10F / Phase D1: compute a shallow drift summary between a run's frozen
 * preset snapshot and the current preset row. Returns
 * `{ deleted, changed_fields[], changed_files[], has_drift, drift_error? }`.
 *
 * `changed_fields` — subset of core fields that differ.
 *   Legacy snapshots that were persisted before Phase D may omit `description`
 *   in `snapshot_json`. The hasOwnProperty guard below skips those fields so
 *   old rows do not spuriously appear as drifted.
 * `changed_files`  — [{path, old_hash, new_hash, status: 'modified'|'deleted'|'added'}]
 *   comparing snapshotFileHashes (stored at run time) with currentFileHashes (disk now).
 *   When `currentFileHashes` is `null` (file recomputation failed), file comparison
 *   is skipped and `changed_files` is returned as `[]`.
 * `has_drift`      — true if any changed_fields or changed_files exist, or preset deleted.
 *   A `drift_error` alone does NOT set `has_drift`.
 * `drift_error`    — present (string) when file hash recomputation failed. Core-field
 *   comparison is still attempted; only the file diff is unavailable.
 *
 * @param {Object} snapshotCore        — JSON-parsed preset core at run time
 * @param {Object|null} currentPreset  — current preset row (null if deleted)
 * @param {Array}  snapshotFileHashes  — [{path, sha256}] stored at snapshot time
 * @param {Array|null} currentFileHashes — [{path, sha256}] recomputed from disk, or null
 * @param {Object} [opts]
 * @param {string|null} [opts.driftError] — error message from file-hash recomputation
 */
function computePresetDrift(snapshotCore, currentPreset,
  snapshotFileHashes = [], currentFileHashes = null, { driftError = null } = {}) {
  if (!snapshotCore) return null;
  if (!currentPreset) return { deleted: true, changed_fields: [], changed_files: [], has_drift: true };

  const FIELDS = [
    'name', 'description', 'isolated', 'plugin_refs', 'mcp_server_ids',
    'base_system_prompt', 'setting_sources', 'min_claude_version',
  ];
  const changed_fields = [];
  for (const f of FIELDS) {
    // Backward-compat shim: legacy snapshot_json rows created before Phase D may
    // omit `description`. Skip comparison for any field not present in the snapshot
    // so we do not create spurious drift on old runs.
    if (!Object.prototype.hasOwnProperty.call(snapshotCore, f)) continue;
    const a = snapshotCore[f];
    const b = currentPreset[f];
    const aJson = JSON.stringify(a == null ? null : a);
    const bJson = JSON.stringify(b == null ? null : b);
    if (aJson !== bJson) changed_fields.push(f);
  }

  // File-level drift: skip entirely when currentFileHashes is null (recomputation failed).
  const changed_files = [];
  if (currentFileHashes !== null) {
    const snapMap = new Map((snapshotFileHashes || []).map(e => [e.path, e.sha256]));
    const currMap = new Map(currentFileHashes.map(e => [e.path, e.sha256]));

    // Files in snapshot: check if modified or deleted
    for (const [p, oldHash] of snapMap) {
      const newHash = currMap.get(p);
      if (newHash === undefined) {
        changed_files.push({ path: p, old_hash: oldHash, new_hash: null, status: 'deleted' });
      } else if (newHash !== oldHash) {
        changed_files.push({ path: p, old_hash: oldHash, new_hash: newHash, status: 'modified' });
      }
    }
    // Files on disk but not in snapshot: added
    for (const [p, newHash] of currMap) {
      if (!snapMap.has(p)) {
        changed_files.push({ path: p, old_hash: null, new_hash: newHash, status: 'added' });
      }
    }
    changed_files.sort((a, b) => a.path.localeCompare(b.path));
  }

  // has_drift is based on actual diff only — drift_error alone does not set it.
  const has_drift = changed_fields.length > 0 || changed_files.length > 0;
  const result = { deleted: false, changed_fields, changed_files, has_drift };
  if (driftError) result.drift_error = driftError;
  return result;
}

/**
 * M3: detect MCP templates that were modified after this run's preset
 * snapshot was captured. The preset snapshot freezes `mcp_server_ids` but
 * NOT the template bodies (command/args/allowed_env_keys). Before M3 the
 * table was code-seed-only so there was no reader for template drift;
 * with UI CRUD now open a run's effective MCP spawn config can silently
 * diverge from what the snapshot describes. We surface that as an
 * info-level badge rather than a hard drift field because the spawn has
 * already happened — the user only needs to know "the template used here
 * has moved since".
 *
 * Comparison is lexicographic on SQLite's `YYYY-MM-DD HH:MM:SS` format —
 * both `template.updated_at` and `snapshot.applied_at` come from the same
 * `datetime('now')` source so string ordering matches chronological
 * ordering without parsing.
 *
 * Returns `{ templates: [{id, alias, updated_at}], modified_count }` or
 * null when the snapshot has no mcp_server_ids.
 */
function computeMcpTemplateDrift(snapshotCore, snapshotAppliedAt, mcpTemplateService) {
  if (!mcpTemplateService || !snapshotCore || !snapshotAppliedAt) return null;
  const ids = Array.isArray(snapshotCore.mcp_server_ids) ? snapshotCore.mcp_server_ids : [];
  if (ids.length === 0) return null;
  const drifted = [];
  for (const id of ids) {
    let tpl = null;
    try { tpl = mcpTemplateService.getTemplate(id); }
    catch { continue; /* template deleted — preset drift handles this separately */ }
    if (!tpl.updated_at) continue;
    if (tpl.updated_at > snapshotAppliedAt) {
      drifted.push({ id: tpl.id, alias: tpl.alias, updated_at: tpl.updated_at });
    }
  }
  return { templates: drifted, modified_count: drifted.length };
}

function createRunsRouter({ runService, lifecycleService, executionEngine, streamJsonEngine, conversationService, presetService, mcpTemplateService, projectService, taskService }) {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    const { task_id, status } = req.query;
    const runs = runService.listRuns({ task_id, status });
    res.json({ runs });
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const run = runService.getRun(req.params.id);
    res.json({ run });
  }));

  // Phase 10F: per-run preset snapshot + drift comparison against current
  // preset. Returns 200 with `snapshot: null, drift: null` when the run
  // has no preset bound. When the preset has been deleted since,
  // `currentPreset` is null and `drift.deleted` is true.
  router.get('/:id/preset-snapshot', asyncHandler(async (req, res) => {
    if (!presetService) {
      return res.status(501).json({ error: 'Preset service unavailable' });
    }
    const run = runService.getRun(req.params.id);
    const snapshot = presetService.getSnapshotForRun(req.params.id);
    if (!snapshot) {
      return res.json({ run_id: run.id, snapshot: null, current_preset: null, drift: null });
    }
    let currentPreset = null;
    try { currentPreset = presetService.getPreset(snapshot.preset_id); }
    catch { currentPreset = null; }

    let snapshotCore = null;
    try { snapshotCore = JSON.parse(snapshot.snapshot_json); }
    catch { snapshotCore = null; }

    // Phase D1: compute current file hashes from disk for drift comparison.
    // snapshotFileHashes were frozen at run time; currentFileHashes are now.
    // On failure, surface drift_error in the response (200) rather than crashing —
    // core-field drift is still reported; only file comparison is unavailable.
    const snapshotFileHashes = Array.isArray(snapshot.file_hashes) ? snapshot.file_hashes : [];
    let currentFileHashes = null;
    let driftError = null;
    if (currentPreset) {
      const pluginRefs = Array.isArray(currentPreset.plugin_refs)
        ? currentPreset.plugin_refs
        : (snapshotCore?.plugin_refs || []);
      try {
        currentFileHashes = presetService.computeCurrentFileHashes(pluginRefs);
      } catch (err) {
        driftError = err?.message || 'Failed to compute current plugin file hashes';
        currentFileHashes = null;
      }
    }

    const drift = computePresetDrift(snapshotCore, currentPreset, snapshotFileHashes, currentFileHashes, { driftError });
    const mcpTemplateDrift = computeMcpTemplateDrift(
      snapshotCore, snapshot.applied_at, mcpTemplateService,
    );
    res.json({
      run_id: run.id,
      snapshot: {
        preset_id: snapshot.preset_id,
        preset_snapshot_hash: snapshot.preset_snapshot_hash,
        applied_at: snapshot.applied_at,
        core: snapshotCore,
        file_hashes: snapshotFileHashes,
      },
      current_preset: currentPreset,
      drift,
      mcp_template_drift: mcpTemplateDrift,
    });
  }));

  // R2-B.2: per-run worktree diff. Returns a unified diff of the run's
  // worktree against HEAD — what the agent changed in its isolated
  // branch, staged + unstaged.
  //
  // Response shape (always 200 for known runs):
  //   { diff: string | null, truncated?: boolean, reason?: string }
  // - `diff: null`         — run has no worktree (shared cwd, pre-worktree
  //   boot, or the directory was cleaned up). `reason` explains which.
  // - `diff: ""`           — worktree exists but there are no changes.
  //   `empty: true` is also set.
  // - `diff: "<text>"`     — unified diff body, capped at DIFF_MAX_BYTES.
  //   When capped, `truncated: true` is set so the client can warn.
  //
  // Security: the worktree path is validated to live under the run's
  // project directory before exec. Paths outside the project boundary
  // (e.g. fabricated runs or stale rows after a project move) are
  // rejected with 400 rather than silently falling back — we do not want
  // to run `git diff` in an arbitrary cwd.
  router.get('/:id/diff', asyncHandler(async (req, res) => {
    const run = runService.getRun(req.params.id);
    if (!run.worktree_path) {
      return res.json({ diff: null, reason: 'no_worktree' });
    }
    if (!fs.existsSync(run.worktree_path)) {
      return res.json({ diff: null, reason: 'worktree_missing' });
    }

    // Resolve the owning project directory so we can bound the worktree
    // path. Without `projectService` / `taskService` wired (legacy test
    // harnesses), fall back to trusting `run.worktree_path` directly —
    // production code path always has both services present.
    let projectDir = null;
    try {
      if (taskService && projectService && run.task_id) {
        const task = taskService.getTask(run.task_id);
        if (task?.project_id) {
          const project = projectService.getProject(task.project_id);
          projectDir = project?.directory || null;
        }
      }
    } catch { /* fall through to unbounded check */ }

    if (projectDir) {
      // Resolve to canonical (symlink-free) paths before comparison.
      // path.resolve alone would happily accept a worktree_path that
      // looks like `/<proj>/evil` where `evil` is a symlink to `/etc` —
      // the string prefix passes but `git diff` would then run in `/etc`.
      // fs.realpathSync follows every component, so the startsWith check
      // runs against the actual filesystem location.
      //
      // If either path isn't realpathable (deleted mid-request, perm
      // error, etc.) we fall back to the non-real variant, which at
      // worst allows the request — but the earlier fs.existsSync on
      // worktree_path has already enforced existence, so the failure
      // mode is narrow.
      let resolvedProject = path.resolve(projectDir);
      let resolvedWorktree = path.resolve(run.worktree_path);
      try { resolvedProject = fs.realpathSync(resolvedProject); } catch { /* fall through */ }
      try { resolvedWorktree = fs.realpathSync(resolvedWorktree); } catch { /* fall through */ }
      // The worktree must be under the project root OR the project root
      // itself (non-git-worktree runs share the base cwd). Anything else
      // is either a bug or a malicious payload.
      const underProject = resolvedWorktree === resolvedProject
        || resolvedWorktree.startsWith(resolvedProject + path.sep);
      if (!underProject) {
        return res.status(400).json({
          diff: null,
          reason: 'worktree_outside_project',
        });
      }
    }

    try {
      const result = await runGitDiff(run.worktree_path);
      return res.json({
        diff: result.diff,
        truncated: result.truncated || false,
        empty: result.empty || false,
      });
    } catch (err) {
      // git exec failed — most likely the worktree isn't a git checkout
      // anymore (it got pruned) or git isn't on PATH. Annotate-only: we
      // respond 200 with diff:null so the tab shows an empty state
      // rather than a toast error that would fire on every poll.
      return res.json({
        diff: null,
        reason: 'git_failed',
        error: err?.message || 'git diff failed',
      });
    }
  }));

  router.get('/:id/events', asyncHandler(async (req, res) => {
    const afterId = req.query.after ? Number(req.query.after) : undefined;
    const events = runService.getRunEvents(req.params.id, afterId);
    res.json({ events });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const run = runService.createRun(req.body || {});
    res.status(201).json({ run });
  }));

  router.patch('/:id/status', asyncHandler(async (req, res) => {
    const { status } = req.body || {};
    const run = runService.updateRunStatus(req.params.id, status);
    res.json({ run });
  }));

  // Send input to a running agent.
  //
  // v3 Phase 1.5: this endpoint is now a thin alias for
  //   POST /api/conversations/worker:<runId>/message
  // so every worker direct-chat path goes through conversationService and
  // therefore triggers the parent-notice router (lock-in #2, principle 9).
  // The pre-1.5 code called lifecycleService.sendAgentInput directly,
  // which bypassed the notice queue and violated principle 9.
  //
  // Backward-compatible fallback: if conversationService is not wired (old
  // test setups), fall back to lifecycleService directly.
  router.post('/:id/input', asyncHandler(async (req, res) => {
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text is required' });

    if (conversationService) {
      try {
        const result = conversationService.sendMessage(`worker:${req.params.id}`, { text });
        // Preserve legacy alias contract: { status: 'ok' }. The newer
        // conversationService shape ({ status: 'sent', target: {...} }) is
        // surfaced under `delivery` so callers that want the extra detail
        // can still pull it out, but the top-level `status` must stay 'ok'
        // or the existing UI treats the call as a failure (spec §9.3).
        return res.json({ status: 'ok', delivery: result });
      } catch (err) {
        if (err && err.httpStatus) {
          return res.status(err.httpStatus).json({ error: err.message });
        }
        throw err;
      }
    }

    if (!lifecycleService) {
      return res.status(501).json({ error: 'Lifecycle service not configured' });
    }
    const sent = lifecycleService.sendAgentInput(req.params.id, text);
    if (!sent) return res.status(502).json({ error: 'Failed to deliver input to agent' });
    res.json({ status: 'ok' });
  }));

  // Cancel a running agent
  router.post('/:id/cancel', asyncHandler(async (req, res) => {
    if (!lifecycleService) {
      return res.status(501).json({ error: 'Lifecycle service not configured' });
    }
    lifecycleService.cancelRun(req.params.id);
    res.json({ status: 'ok' });
  }));

  // Get live output from agent's tmux/subprocess
  router.get('/:id/output', asyncHandler(async (req, res) => {
    if (!executionEngine) {
      return res.status(501).json({ error: 'Execution engine not configured' });
    }
    const lines = Math.min(Math.max(1, Number(req.query.lines || 100)), 2000);
    // Try streamJsonEngine first (claude workers), fall back to executionEngine (tmux)
    const output = (streamJsonEngine && streamJsonEngine.getOutput(req.params.id, lines))
      || executionEngine.getOutput(req.params.id, lines);
    res.json({ output });
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    // Kill any running process before deleting
    const run = runService.getRun(req.params.id);
    if (['running', 'queued', 'needs_input'].includes(run.status)) {
      if (lifecycleService) {
        try { lifecycleService.cancelRun(req.params.id); } catch {}
      } else if (executionEngine) {
        try { executionEngine.kill(req.params.id); } catch {}
      }
    }
    runService.deleteRun(req.params.id);
    res.json({ status: 'ok' });
  }));

  return router;
}

module.exports = {
  createRunsRouter,
  computePresetDrift,
  computeMcpTemplateDrift,
  runGitDiff,
  DIFF_MAX_BYTES,
};
