const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');

function createNodesRouter({ nodeService, nodeUsageService, nodeSummaryService, lifecycleService } = {}) {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    res.json({ nodes: nodeService.listNodes() });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const node = nodeService.createNode(req.body || {});
    res.status(201).json({ node });
  }));

  if (nodeSummaryService) {
    router.get('/summary', asyncHandler(async (req, res) => {
      res.json(nodeSummaryService.getSummary());
    }));
  }

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
    const before = nodeService.getNode(req.params.id);
    const node = nodeService.updateNode(req.params.id, req.body || {});
    // Uncordon (cordoned 1→0) must wake this node's queue, mirroring the
    // heartbeat-recovery drain (N0-2). A manual PATCH is the only trigger for
    // this transition, so without it queued runs pinned to the node stay
    // asleep until the next run:ended or a server restart (Codex N3 review,
    // SERIOUS). scheduleDrainForNode is node-scoped + never-throws.
    if (lifecycleService
        && typeof lifecycleService.scheduleDrainForNode === 'function'
        && Number(before.cordoned) === 1
        && Number(node.cordoned) === 0) {
      lifecycleService.scheduleDrainForNode(node.id);
    }
    res.json({ node });
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    nodeService.deleteNode(req.params.id);
    res.json({ status: 'ok' });
  }));

  return router;
}

module.exports = { createNodesRouter };
