const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');

function createAgentsRouter({ agentProfileService }) {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    const agents = agentProfileService.listProfiles();
    res.json({ agents });
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const agent = agentProfileService.getProfile(req.params.id);
    const runningCount = agentProfileService.getRunningCount(req.params.id);
    res.json({ agent, runningCount });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const agent = agentProfileService.createProfile(req.body || {});
    res.status(201).json({ agent });
  }));

  router.patch('/:id', asyncHandler(async (req, res) => {
    const agent = agentProfileService.updateProfile(req.params.id, req.body || {});
    res.json({ agent });
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    agentProfileService.deleteProfile(req.params.id);
    res.json({ status: 'ok' });
  }));

  return router;
}

module.exports = { createAgentsRouter };
