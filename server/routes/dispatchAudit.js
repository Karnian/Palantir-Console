// server/routes/dispatchAudit.js
//
// v3 Phase 4: annotate-only reconciliation HTTP surface.
//
// Endpoints:
//   POST /api/dispatch-audit       — record a PM dispatch/status claim
//   GET  /api/dispatch-audit       — list recent claims (optional filters)
//
// The POST path is intentionally exposed so the PM itself can curl it
// from inside its sandboxed session when it wants to record "I just
// did X". This matches how the rest of the manager system prompt works
// (PMs and Tops already drive REST endpoints via Bash curl). A future
// phase may auto-parse PM responses server-side, but that's a harder
// problem (item.completed interception + structured claim extraction)
// and out of scope for annotate-only Phase 4.

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { BadRequestError } = require('../utils/errors');

function createDispatchAuditRouter({ reconciliationService }) {
  const router = express.Router();

  router.post('/', asyncHandler(async (req, res) => {
    if (!reconciliationService) {
      return res.status(501).json({ error: 'reconciliationService_unavailable' });
    }
    const {
      project_id, task_id, pm_run_id, selected_agent_profile_id, rationale, pm_claim,
    } = req.body || {};
    if (!project_id) throw new BadRequestError('project_id is required');
    if (!pm_claim || typeof pm_claim !== 'object') {
      throw new BadRequestError('pm_claim object is required');
    }
    try {
      const row = reconciliationService.recordClaim({
        projectId: project_id,
        taskId: task_id || null,
        pmRunId: pm_run_id || null,
        selectedAgentProfileId: selected_agent_profile_id || null,
        rationale: rationale || null,
        pmClaim: pm_claim,
      });
      res.status(201).json({ audit: row });
    } catch (err) {
      if (err && err.httpStatus === 400) throw new BadRequestError(err.message);
      if (err && err.httpStatus) {
        return res.status(err.httpStatus).json({ error: err.message });
      }
      throw err;
    }
  }));

  router.get('/', asyncHandler(async (req, res) => {
    if (!reconciliationService) {
      return res.status(501).json({ error: 'reconciliationService_unavailable' });
    }
    const projectId = req.query.project_id || undefined;
    // Accept both ?incoherent_only=1 and ?incoherent_only=true
    const raw = req.query.incoherent_only;
    const incoherentOnly = raw === '1' || raw === 'true';
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const rows = reconciliationService.listClaims({
      projectId,
      incoherentOnly,
      limit,
    });
    res.json({ audit: rows });
  }));

  return router;
}

module.exports = { createDispatchAuditRouter };
