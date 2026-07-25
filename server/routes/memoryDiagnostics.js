'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');

function createMemoryDiagnosticsRouter({ memoryService, getDistillStatus }) {
  const router = express.Router();

  router.get('/status', asyncHandler(async (req, res) => {
    if (!memoryService) {
      return res.status(501).json({ error: 'memoryService_unavailable' });
    }
    const distiller = typeof getDistillStatus === 'function'
      ? getDistillStatus()
      : { state: 'unavailable', enabled: false };
    res.json({
      distiller,
      queue: memoryService.getCandidateQueueSummary(),
      approval: {
        requires_cookie: true,
        actor: req.auth && req.auth.method ? req.auth.method : 'unknown',
        can_review: !!(req.auth && req.auth.method === 'cookie'),
      },
    });
  }));

  return router;
}

module.exports = { createMemoryDiagnosticsRouter };
