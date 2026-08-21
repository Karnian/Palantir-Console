'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { ForbiddenError } = require('../utils/errors');

// Same gate routes/modelPolicies.js uses, for the same reason: declaring a
// provider widens what a spawned agent may receive, so it is a human action.
// PALANTIR_PM_TOKEN is bearer-only and unscoped, and a goal-mode Operator's own
// spawn env legitimately contains it — without this an Operator could declare a
// provider, bind it to its profile, and widen its own effective allowlist for
// the next spawn, with no human in the loop.
function assertHumanWrite(req) {
  if (!req.auth || req.auth.method !== 'cookie') {
    throw new ForbiddenError('cookie auth required');
  }
  const origin = req.headers.origin;
  // Cookie mutations require a positive same-origin signal. Browsers normally
  // send Origin for these methods; accepting an absent header makes CSRF
  // enforcement depend on browser heuristics instead of this boundary.
  if (!origin) throw new ForbiddenError('same-origin Origin header required');
  if (!req.headers.host) throw new ForbiddenError('cross-origin write blocked');
  let requestOrigin;
  let suppliedOrigin;
  try {
    suppliedOrigin = new URL(origin).origin;
    requestOrigin = new URL(`${req.protocol}://${req.headers.host}`).origin;
  } catch {
    throw new ForbiddenError('cross-origin write blocked');
  }
  if (suppliedOrigin.toLowerCase() !== requestOrigin.toLowerCase()) {
    throw new ForbiddenError('cross-origin write blocked');
  }
}

function createEnvironmentProvidersRouter({ environmentProviderService }) {
  if (!environmentProviderService) {
    throw new Error('createEnvironmentProvidersRouter: environmentProviderService is required');
  }
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    res.json({ providers: environmentProviderService.listProviders() });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    assertHumanWrite(req);
    const provider = environmentProviderService.createProvider(req.body || {});
    res.status(201).json({ provider });
  }));

  router.get('/:id/references', asyncHandler(async (req, res) => {
    res.json({ references: environmentProviderService.findReferences(req.params.id) });
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    res.json({ provider: environmentProviderService.getProvider(req.params.id) });
  }));

  router.patch('/:id', asyncHandler(async (req, res) => {
    assertHumanWrite(req);
    res.json({
      provider: environmentProviderService.updateProvider(req.params.id, req.body || {}),
    });
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    assertHumanWrite(req);
    res.json({ provider: environmentProviderService.deleteProvider(req.params.id) });
  }));

  return router;
}

module.exports = { createEnvironmentProvidersRouter, assertHumanWrite };
