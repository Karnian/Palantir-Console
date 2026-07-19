'use strict';

// Operator Profile CRUD (PF-1). Validation lives in operatorProfileService
// (mirrors workerPresets). Errors (BadRequest/Conflict/NotFound) are thrown by
// the service and routed to the central errorHandler by Express 5.

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');

function createOperatorProfilesRouter({ operatorProfileService, operatorIdentityLifecycleService }) {
  if (!operatorProfileService) {
    throw new Error('createOperatorProfilesRouter: operatorProfileService is required');
  }
  if (!operatorIdentityLifecycleService) {
    throw new Error('createOperatorProfilesRouter: operatorIdentityLifecycleService is required');
  }
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    res.json({ profiles: operatorProfileService.listProfiles() });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const profile = operatorProfileService.createProfile(req.body || {});
    res.status(201).json({ profile });
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    res.json({ profile: operatorProfileService.getProfile(req.params.id) });
  }));

  router.patch('/:id', asyncHandler(async (req, res) => {
    const profile = operatorIdentityLifecycleService.updateProfileContent(req.params.id, req.body || {});
    res.json({ profile });
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const profile = operatorIdentityLifecycleService.deleteProfile(req.params.id);
    res.json({ profile });
  }));

  return router;
}

module.exports = { createOperatorProfilesRouter };
