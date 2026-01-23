const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { AppError, NotFoundError, ConflictError } = require('../utils/errors');

function createTrashRouter({ trashService }) {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    try {
      const items = await trashService.listTrashedSessions();
      res.json({ items });
    } catch (error) {
      throw new AppError('Failed to load trash', 500);
    }
  }));

  router.post('/:trashId/restore', asyncHandler(async (req, res) => {
    const { trashId } = req.params;
    try {
      const result = await trashService.restoreTrashedSession(trashId);
      if (!result) {
        throw new NotFoundError('Trash item not found');
      }
      if (result.conflict) {
        throw new ConflictError('Session already exists');
      }
      res.json({ status: 'ok', session: result.session });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('Failed to restore session', 500);
    }
  }));

  router.delete('/:trashId', asyncHandler(async (req, res) => {
    const { trashId } = req.params;
    try {
      await trashService.deleteTrashItem(trashId);
      res.json({ status: 'ok' });
    } catch (error) {
      throw new AppError('Failed to delete trash item', 500);
    }
  }));

  return router;
}

module.exports = { createTrashRouter };
