const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const {
  AppError,
  BadRequestError,
  NotFoundError
} = require('../utils/errors');

function createSessionsRouter({
  sessionService,
  messageService,
  trashService,
  opencodeService,
  storageRoot
}) {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    try {
      const sessions = await sessionService.loadSessions();
      res.json({ sessions, storageRoot });
    } catch (error) {
      throw new AppError('Failed to load sessions', 500);
    }
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const { id } = req.params;
    const limit = Number(req.query.limit || 200);
    try {
      const session = await sessionService.loadSessionMeta(id);
      const messages = await messageService.loadSessionMessages(id, limit);
      res.json({ session, messages });
    } catch (error) {
      throw new AppError('Failed to load session', 500);
    }
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const { title, projectId, directory } = req.body || {};
    if (!title || typeof title !== 'string') {
      throw new BadRequestError('title is required');
    }

    try {
      const session = await sessionService.createSession({ title, projectId, directory });
      res.status(201).json({ session });
    } catch (error) {
      throw new AppError('Failed to create session', 500);
    }
  }));

  router.patch('/:id', asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { title } = req.body || {};
    if (!title || typeof title !== 'string') {
      throw new BadRequestError('title is required');
    }

    try {
      const session = await sessionService.renameSession(id, title);
      if (!session) {
        throw new NotFoundError('Session not found');
      }
      res.json({ session });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('Failed to rename session', 500);
    }
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const { id } = req.params;
    try {
      const result = await trashService.moveSessionToTrash(id);
      if (!result) {
        throw new NotFoundError('Session not found');
      }
      res.json({ status: 'ok', trashRoot: result.trashRoot, moved: result.moved });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('Failed to delete session', 500);
    }
  }));

  router.post('/:id/message', asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { content } = req.body || {};
    if (!content || typeof content !== 'string') {
      throw new BadRequestError('content is required');
    }

    try {
      const session = await sessionService.loadSessionMeta(id);
      const cwd = await messageService.resolveCwd(session?.directory);
      const result = await opencodeService.queueMessage({ sessionId: id, content, cwd });
      res.json(result);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('Failed to send message', 500);
    }
  }));

  return router;
}

module.exports = { createSessionsRouter };
