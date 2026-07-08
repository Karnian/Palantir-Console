'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');

function createOperatorInstancesRouter({ operatorInstanceService }) {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    res.json({ instances: operatorInstanceService.listInstances() });
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    res.json({ instance: operatorInstanceService.getInstance(req.params.id) });
  }));

  router.post('/:id/refs', asyncHandler(async (req, res) => {
    const instance = operatorInstanceService.addRef(req.params.id, req.body || {});
    const ref = instance.refs.find((item) => item.project_id === req.body?.project_id) || null;
    res.status(201).json({ instance, ref });
  }));

  router.delete('/:id/refs/:projectId', asyncHandler(async (req, res) => {
    const instance = operatorInstanceService.removeRef(req.params.id, req.params.projectId);
    res.json({ instance });
  }));

  return router;
}

module.exports = { createOperatorInstancesRouter };
