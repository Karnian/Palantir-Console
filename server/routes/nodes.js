const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');

function createNodesRouter({ nodeService, nodeUsageService } = {}) {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    res.json({ nodes: nodeService.listNodes() });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const node = nodeService.createNode(req.body || {});
    res.status(201).json({ node });
  }));

  if (nodeUsageService) {
    router.get('/:id/usage', asyncHandler(async (req, res) => {
      const usage = await nodeUsageService.getUsageSnapshot(req.params.id);
      res.json(usage);
    }));
  }

  router.get('/:id', asyncHandler(async (req, res) => {
    const node = nodeService.getNode(req.params.id);
    res.json({ node });
  }));

  router.patch('/:id', asyncHandler(async (req, res) => {
    const node = nodeService.updateNode(req.params.id, req.body || {});
    res.json({ node });
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    nodeService.deleteNode(req.params.id);
    res.json({ status: 'ok' });
  }));

  return router;
}

module.exports = { createNodesRouter };
