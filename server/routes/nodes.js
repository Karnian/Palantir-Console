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
    // Uncordon and manual reachability recovery must wake this node's queue,
    // mirroring the heartbeat-recovery drain (N0-2). Heartbeat is optional, so
    // a reachable 0→1 PATCH is the recovery trigger for installations that keep
    // it disabled. scheduleDrainForNode is node-scoped + never-throws.
    const becameDispatchable = (
      (Number(before.cordoned) === 1 && Number(node.cordoned) === 0)
      || (Number(before.reachable) === 0 && Number(node.reachable) === 1)
    );
    if (lifecycleService
        && typeof lifecycleService.scheduleDrainForNode === 'function'
        && becameDispatchable) {
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
