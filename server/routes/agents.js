const express = require('express');
const { execSync } = require('child_process');
const { asyncHandler } = require('../middleware/asyncHandler');

function readKeychainToken() {
  if (process.platform !== 'darwin') return null;
  try {
    const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w', { encoding: 'utf-8', timeout: 5000 }).trim();
    const creds = JSON.parse(raw);
    return creds.claudeAiOauth?.accessToken || null;
  } catch { return null; }
}

function fetchClaudeCodeUsage() {
  const now = new Date().toISOString();
  const base = { id: 'anthropic', name: 'claude' };

  // Get account info via CLI
  let account = null;
  try {
    const authInfo = JSON.parse(execSync('claude auth status', { encoding: 'utf-8', timeout: 5000 }).trim());
    if (authInfo.loggedIn) {
      account = {
        email: authInfo.email,
        type: authInfo.authMethod,
        planType: authInfo.subscriptionType,
        orgName: authInfo.orgName
      };
    }
  } catch { /* claude CLI unavailable */ }

  // Get usage data via curl (avoids Node TLS cert issues)
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY || readKeychainToken();
  if (!token) {
    return { ...base, account, limits: [{ label: 'usage', remainingPct: null, resetAt: null, errorMessage: 'No Claude auth token found' }], updatedAt: now };
  }

  try {
    const raw = execSync(
      `curl -s -H "Authorization: Bearer ${token}" -H "anthropic-beta: oauth-2025-04-20" -H "Accept: application/json" "https://api.anthropic.com/api/oauth/usage"`,
      { encoding: 'utf-8', timeout: 10000 }
    );
    const data = JSON.parse(raw);
    const limits = [];
    const labelMap = {
      five_hour: '5h limit', seven_day: 'weekly limit',
      seven_day_opus: 'weekly opus', seven_day_sonnet: 'weekly sonnet',
      seven_day_oauth_apps: 'weekly oauth apps', seven_day_cowork: 'weekly cowork',
      extra_usage: 'extra usage',
    };
    for (const [key, value] of Object.entries(data)) {
      if (!value || typeof value !== 'object') continue;
      let remainingPct = null;
      if (typeof value.utilization === 'number') remainingPct = Math.max(0, Math.min(100, 100 - value.utilization));
      else if (typeof value.used_credits === 'number' && typeof value.monthly_limit === 'number' && value.monthly_limit > 0)
        remainingPct = Math.max(0, Math.min(100, 100 - (value.used_credits / value.monthly_limit) * 100));
      else if (value.is_enabled !== undefined && remainingPct === null) remainingPct = 100;
      const resetAt = value.resets_at ? new Date(value.resets_at) : null;
      limits.push({ label: labelMap[key] || key, remainingPct, resetAt });
    }
    if (!limits.length) limits.push({ label: 'usage', remainingPct: null, resetAt: null, errorMessage: 'No usage data found' });
    return { ...base, account, limits, updatedAt: now };
  } catch (err) {
    return { ...base, account, limits: [{ label: 'usage', remainingPct: null, resetAt: null, errorMessage: err.message || 'Failed to fetch usage' }], updatedAt: now };
  }
}

function createAgentsRouter({ agentProfileService, codexService, fetchAnthropicUsage, fetchGeminiUsage }) {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    const agents = agentProfileService.listProfiles();
    res.json({ agents });
  }));

  // Usage info — must be before /:id to avoid param capture
  router.get('/:id/usage', asyncHandler(async (req, res) => {
    const agent = agentProfileService.getProfile(req.params.id);
    const type = (agent.type || '').toLowerCase();
    let usage = null;

    const fallback = (msg) => ({
      id: type || 'unknown',
      name: agent.name,
      limits: [{ label: 'usage', remainingPct: null, resetAt: null, errorMessage: msg }],
      updatedAt: new Date().toISOString()
    });

    try {
      if (type === 'codex' && codexService) {
        usage = await codexService.getProviderStatus();
      } else if (type === 'claude-code') {
        usage = fetchClaudeCodeUsage();
      } else if (type === 'gemini' && fetchGeminiUsage) {
        const apiKey = process.env.GEMINI_API_KEY || '';
        usage = await fetchGeminiUsage(apiKey);
      } else {
        usage = fallback(`No usage provider for type: ${type}`);
      }
    } catch (err) {
      usage = fallback(err.message || 'Failed to fetch usage');
    }

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
