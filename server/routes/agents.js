const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { resolveManagerAuth } = require('../services/authResolver');

/**
 * Agent routes. Per-agent usage dispatch goes through the provider registry,
 * which is the single source of truth for usage envelope shapes and adapter
 * selection. See server/services/providers/index.js for the dispatch table.
 */

// PR5: profile.type → manager adapter type. Mirrors PROFILE_TYPE_TO_ADAPTER in
// routes/manager.js. Profiles whose type is not in this set cannot back a
// manager session, so we don't attach an auth preflight for them.
const MANAGER_PROFILE_TYPES = {
  'claude-code': 'claude-code',
  'codex': 'codex',
};

function computeAuthForProfile(profile, resolverOpts = {}) {
  const adapterType = MANAGER_PROFILE_TYPES[profile && profile.type];
  if (!adapterType) return null;
  let envAllowlist;
  if (profile.env_allowlist) {
    // D7 fail-closed: must match the strict parse in routes/manager.js
    // /api/manager/start. Both syntax errors AND non-array JSON must
    // produce canAuth=false so the picker cannot false-green a profile
    // that the actual start path will reject.
    let parsed;
    try {
      parsed = JSON.parse(profile.env_allowlist);
    } catch {
      return {
        canAuth: false,
        sources: [],
        diagnostics: ['env_allowlist is not valid JSON'],
      };
    }
    if (!Array.isArray(parsed)) {
      return {
        canAuth: false,
        sources: [],
        diagnostics: ['env_allowlist must be a JSON array'],
      };
    }
    envAllowlist = parsed;
  }
  const ctx = resolveManagerAuth(adapterType, { envAllowlist, ...resolverOpts });
  return {
    canAuth: !!ctx.canAuth,
    sources: ctx.sources || [],
    diagnostics: ctx.diagnostics || [],
  };
}

// authResolverOpts is forwarded to resolveManagerAuth so tests can inject
// `hasKeychain` (and any future DI hooks) without monkey-patching globals.
// Production callers leave this empty and get the real keychain probe.
function createAgentsRouter({ agentProfileService, providerRegistry, authResolverOpts = {} }) {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    const agents = agentProfileService.listProfiles();
    // PR5: attach per-profile manager auth preflight so the frontend picker
    // can render a green/red status dot without N+1 probing. Non-manager
    // profiles get `auth: null` and stay untouched.
    const enriched = agents.map(a => ({ ...a, auth: computeAuthForProfile(a, authResolverOpts) }));
    res.json({ agents: enriched });
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
    // PR5: include auth preflight so a targeted fetch (e.g. picker refresh
    // after credentials are added) doesn't need a second round-trip.
    const auth = computeAuthForProfile(agent, authResolverOpts);
    res.json({ agent: { ...agent, auth }, runningCount });
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
