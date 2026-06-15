// server/routes/memory.js
//
// Memory Layer PR1: read-only GET surface for L1 project memory.
//
//   GET /api/projects/:projectId/memory  -> { memory: [...active rows] }
//
// PR1 is read→inject ONLY. There is intentionally NO write endpoint here:
// the external `remember` write API is PR2 (R4) and is gated on a
// cookie-vs-bearer actor distinction (spec §8). Adding a write here now
// would reopen the spoof boundary the brief explicitly closed for PR1.

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { BadRequestError, NotFoundError } = require('../utils/errors');

function createMemoryRouter({ memoryService, projectService }) {
  const router = express.Router();

  router.get('/:projectId/memory', asyncHandler(async (req, res) => {
    if (!memoryService) {
      return res.status(501).json({ error: 'memoryService_unavailable' });
    }
    const { projectId } = req.params;
    if (!projectId) throw new BadRequestError('projectId is required');
    // Verify the project exists before listing — otherwise a typo'd or
    // deleted project id returns a misleading 200 [] (Codex cross-review
    // SERIOUS: other project-scoped routes do this existence check too).
    if (projectService) {
      let project = null;
      try { project = projectService.getProject(projectId); } catch { project = null; }
      if (!project) throw new NotFoundError(`project not found: ${projectId}`);
    }
    res.json({ memory: memoryService.listForProject(projectId) });
  }));

  return router;
}

module.exports = { createMemoryRouter };
