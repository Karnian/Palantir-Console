// server/routes/memory.js
//
// Memory Layer: read-only GET surface for L1 project memory.
//
//   GET /api/projects/:projectId/memory  -> { memory: [...active rows] }
//
// Read→inject only. No external write endpoint here: the `remember` write API
// is PR2b (R4) and is gated on a cookie-vs-bearer actor distinction (spec §8).
// PR2a adds R6 env facts whose evidence_json carries run provenance, so the
// GET response is field-whitelisted (no evidence_json / content_hash leak).

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { BadRequestError, NotFoundError } = require('../utils/errors');

// PR2a: whitelist the fields the GET surface exposes. evidence_json (run/task
// provenance, potential secrets), content_hash, superseded_by, rowid_pk are
// deliberately excluded (Codex cross-review BLOCKER — evidence must not leak).
const PUBLIC_FIELDS = [
  'id', 'project_id', 'kind', 'content', 'fact_key',
  'importance', 'source_count', 'status', 'valid_to',
  'created_at', 'updated_at', 'reviewed_at',
];

function toPublicMemory(row) {
  const out = {};
  for (const field of PUBLIC_FIELDS) {
    if (row && field in row) out[field] = row[field];
  }
  return out;
}

function createMemoryRouter({ memoryService, projectService }) {
  const router = express.Router();

  router.get('/:projectId/memory', asyncHandler(async (req, res) => {
    if (!memoryService) {
      return res.status(501).json({ error: 'memoryService_unavailable' });
    }
    const { projectId } = req.params;
    if (!projectId) throw new BadRequestError('projectId is required');
    // Verify the project exists before listing — otherwise a typo'd or
    // deleted project id returns a misleading 200 [] (Codex cross-review).
    if (projectService) {
      let project = null;
      try { project = projectService.getProject(projectId); } catch { project = null; }
      if (!project) throw new NotFoundError(`project not found: ${projectId}`);
    }
    res.json({ memory: memoryService.listForProject(projectId).map(toPublicMemory) });
  }));

  return router;
}

module.exports = { createMemoryRouter, toPublicMemory };
