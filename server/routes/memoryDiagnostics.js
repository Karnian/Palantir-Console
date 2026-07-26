'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');

function createMemoryDiagnosticsRouter({
  memoryService,
  masterMemoryService,
  getDistillStatus,
  actorBoundary = 'auth_disabled',
}) {
  const router = express.Router();

  router.get('/status', asyncHandler(async (req, res) => {
    if (!memoryService) {
      return res.status(501).json({ error: 'memoryService_unavailable' });
    }
    const distiller = typeof getDistillStatus === 'function'
      ? getDistillStatus()
      : { state: 'unavailable', enabled: false };
    const localQueue = memoryService.getCandidateQueueSummary();
    const masterQueue = masterMemoryService && typeof masterMemoryService.getCandidateQueueSummary === 'function'
      ? masterMemoryService.getCandidateQueueSummary()
      : {
          pending: 0,
          user_pending: 0,
          cross_project_pending: 0,
          deterministic_pending: 0,
          distillation_pending: 0,
          oldest_pending_at: null,
        };
    const oldest = [localQueue.oldest_pending_at, masterQueue.oldest_pending_at]
      .filter(Boolean)
      .sort()[0] || null;
    res.json({
      distiller,
      queue: {
        pending: localQueue.pending + masterQueue.pending,
        workspace_pending: localQueue.workspace_pending,
        profile_pending: localQueue.profile_pending,
        user_pending: masterQueue.user_pending,
        cross_project_pending: masterQueue.cross_project_pending,
        deterministic_pending: localQueue.deterministic_pending + masterQueue.deterministic_pending,
        distillation_pending: localQueue.distillation_pending + masterQueue.distillation_pending,
        oldest_pending_at: oldest,
      },
      approval: {
        requires_cookie: true,
        actor: req.auth && req.auth.method ? req.auth.method : 'unknown',
        can_review: !!(req.auth && req.auth.method === 'cookie'),
        actor_boundary: actorBoundary,
      },
    });
  }));

  return router;
}

module.exports = { createMemoryDiagnosticsRouter };
