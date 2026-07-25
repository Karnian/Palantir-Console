const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');

function createFsRouter({ fsService }) {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    const requested = typeof req.query.path === 'string' && req.query.path.trim()
      ? req.query.path.trim()
      : null;
    const showHidden = req.query.showHidden === '1' || req.query.showHidden === 'true';
    // task_85d43f96: absent/`local` keeps the control-plane behaviour byte for
    // byte; any other id browses that execution node through its executor.
    const nodeId = typeof req.query.nodeId === 'string' ? req.query.nodeId.trim() : '';

    try {
      const result = await fsService.browse({ nodeId, path: requested, showHidden });
      res.json(result);
    } catch (error) {
      // Answered here rather than through the shared error handler because the
      // picker needs `reason` on 5xx too (an unreachable node is a 502), and
      // errorHandler only forwards `reason` for 4xx.
      const mapped = fsService.classifyBrowseError(error);
      res.status(mapped.status).json({ error: mapped.message, reason: mapped.reason });
    }
  }));

  return router;
}

module.exports = { createFsRouter };
