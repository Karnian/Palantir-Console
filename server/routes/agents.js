const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');

/**
 * Agent routes. Per-agent usage dispatch goes through the provider registry,
 * which is the single source of truth for usage envelope shapes and adapter
 * selection. See server/services/providers/index.js for the dispatch table.
 */
function createAgentsRouter({ agentProfileService, providerRegistry }) {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    const agents = agentProfileService.listProfiles();
    res.json({ agents });
  }));

  // Usage info — must be before /:id to avoid param capture
  router.get('/:id/usage', asyncHandler(async (req, res) => {
    const agent = agentProfileService.getProfile(req.params.id);
    const usage = providerRegistry
      ? await providerRegistry.getUsageForAgent(agent)
      : {
          id: 'unknown',
          name: agent.name,
          limits: [{ label: 'usage', remainingPct: null, resetAt: null, errorMessage: 'Provider registry unavailable' }],
          updatedAt: new Date().toISOString(),
        };
    const runningCount = agentProfileService.getRunningCount(agent.id);
    res.json({ agent, usage, runningCount });
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
