const express = require('express');
const path = require('path');
const { asyncHandler } = require('../middleware/asyncHandler');
const { AppError, ForbiddenError } = require('../utils/errors');

function createFsRouter({ fsService }) {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    const requested = typeof req.query.path === 'string' && req.query.path.trim()
      ? req.query.path.trim()
      : fsService.fsRoot;
    const showHidden = req.query.showHidden === '1' || req.query.showHidden === 'true';
    const resolved = path.resolve(requested);
    if (!fsService.isWithinRoot(fsService.fsRoot, resolved)) {
      throw new ForbiddenError('Path not allowed');
    }

    try {
      const result = await fsService.listDirectories(resolved, showHidden);
      res.json(result);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new AppError('Path not found', 404);
      }
      if (error.code === 'EACCES') {
        throw new AppError('Access denied', 403);
      }
      throw new AppError('Failed to read directory', 500);
    }
  }));

  return router;
}

module.exports = { createFsRouter };
