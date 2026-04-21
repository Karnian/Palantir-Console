const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');

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

function createRunsRouter({ runService, lifecycleService, executionEngine, streamJsonEngine, conversationService, presetService, mcpTemplateService }) {
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

module.exports = { createRunsRouter, computePresetDrift, computeMcpTemplateDrift };
