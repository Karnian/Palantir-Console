// server/routes/conversations.js
//
// v3 Phase 1.5: new 1st-class conversation surface. The routes delegate
// all real work to conversationService — this file is pure HTTP glue.
//
// Endpoints:
//   POST /api/conversations/:id/message  — send a message to a conversation
//   GET  /api/conversations/:id/events   — fetch events (?after= cursor)
//   GET  /api/conversations/:id          — resolve a conversation to its run
//
// The `id` path segment is a conversation id as understood by
// conversationService.parseConversationId: 'top', 'pm:<projectId>', or
// 'worker:<runId>'. URL encoding the colon is optional — Express routers
// decode it automatically.
//
// Legacy /api/manager/* endpoints remain alive as thin aliases (they
// internally call the same conversationService). The client migration is
// incremental: hooks.js switches over in Phase 1.5 too, but any third
// party using /api/manager keeps working.

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');

function createConversationsRouter({ conversationService, runService }) {
  const router = express.Router();

  function mapError(err, res) {
    if (err && err.httpStatus) {
      return res.status(err.httpStatus).json({ error: err.message });
    }
    throw err;
  }

  // GET /api/conversations/:id
  // Returns { conversation: { kind, conversationId, run? } } or 404.
  router.get('/:id', asyncHandler(async (req, res) => {
    const { id } = req.params;
    const resolved = conversationService.resolveConversation(id);
    if (!resolved) {
      return res.status(400).json({ error: `invalid conversation id: ${id}` });
    }
    res.json({ conversation: resolved });
  }));

  // POST /api/conversations/:id/message
  router.post('/:id/message', asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { text, images } = req.body || {};
    try {
      const result = conversationService.sendMessage(id, { text, images });
      res.json(result);
    } catch (err) {
      return mapError(err, res);
    }
  }));

  // GET /api/conversations/:id/events
  router.get('/:id/events', asyncHandler(async (req, res) => {
    const { id } = req.params;
    const parsed = conversationService.parseConversationId(id);
    if (!parsed) {
      return res.status(400).json({ error: `invalid conversation id: ${id}` });
    }
    const rawAfter = req.query.after ? Number(req.query.after) : undefined;
    const afterId = (rawAfter != null && !Number.isNaN(rawAfter)) ? rawAfter : undefined;
    const events = conversationService.getEvents(id, afterId);
    res.json({ events });
  }));

  return router;
}

module.exports = { createConversationsRouter };
