// server/routes/router.js
//
// v3 Phase 6: thin HTTP wrapper over routerService.resolveTarget.
// The client calls this once per user send (after UI selection is
// known) so the 3-step matcher runs in exactly one place. A future
// Top-layer LLM dispatcher can reuse the same routerService module
// directly without going through HTTP.
//
// Endpoint:
//   POST /api/router/resolve
//   body: { text, currentConversationId?, defaultConversationId? }
//   → { target, text, matchedRule, ambiguous?, candidates? }

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { BadRequestError } = require('../utils/errors');

function createRouterRouter({ routerService }) {
  const router = express.Router();

  router.post('/resolve', asyncHandler(async (req, res) => {
    if (!routerService) {
      return res.status(501).json({ error: 'routerService_unavailable' });
    }
    const { text, currentConversationId, defaultConversationId } = req.body || {};
    if (typeof text !== 'string') {
      throw new BadRequestError('text (string) is required');
    }
    const result = routerService.resolveTarget({
      text,
      currentConversationId: currentConversationId || undefined,
      defaultConversationId: defaultConversationId || 'top',
    });
    res.json(result);
  }));

  return router;
}

module.exports = { createRouterRouter };
