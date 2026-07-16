'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { ForbiddenError } = require('../utils/errors');

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;

  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ForbiddenError('cross-origin write blocked');
  }

  const requestHost = req.headers.host;
  if (!requestHost || originHost.toLowerCase() !== String(requestHost).toLowerCase()) {
    throw new ForbiddenError('cross-origin write blocked');
  }
}

function createModelPoliciesRouter({ modelPolicyService }) {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    res.json({ policies: modelPolicyService.listPolicies() });
  }));

  router.get('/effective', asyncHandler(async (req, res) => {
    const effective = modelPolicyService.resolveEffective({
      layer: req.query.layer,
      vendor: req.query.vendor,
      projectId: req.query.projectId,
      env: process.env,
    });
    res.json({ effective });
  }));

  router.put('/:scope_type/:scope_id/:vendor', asyncHandler(async (req, res) => {
    if (!req.auth || req.auth.method !== 'cookie') {
      throw new ForbiddenError('cookie auth required');
    }
    assertSameOrigin(req);

    const body = req.body || {};
    const policy = modelPolicyService.putPolicy({
      ...req.params,
      params: body.params,
      expectedRevision: body.expectedRevision,
      changed_by: 'human',
    });
    res.json({ policy });
  }));

  router.delete('/:scope_type/:scope_id/:vendor', asyncHandler(async (req, res) => {
    if (!req.auth || req.auth.method !== 'cookie') {
      throw new ForbiddenError('cookie auth required');
    }
    assertSameOrigin(req);

    const result = modelPolicyService.deletePolicy({
      ...req.params,
      changed_by: 'human',
    });
    res.json(result);
  }));

  return router;
}

module.exports = { createModelPoliciesRouter };
