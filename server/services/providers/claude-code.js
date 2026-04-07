/**
 * Claude Code provider adapter — desktop OAuth flavor.
 *
 * Distinct from anthropic.js: this path resolves the auth token from the
 * Claude Code desktop OAuth flow (CLAUDE_CODE_OAUTH_TOKEN env, then falls back
 * to ANTHROPIC_API_KEY, then macOS Keychain). It also tries `claude auth status`
 * to enrich the response with account info. Both paths still hit the Anthropic
 * OAuth usage endpoint, but the auth source matters — collapsing them would
 * silently break Claude Code installs that don't have ANTHROPIC_API_KEY exported.
 */

const { execSync } = require('node:child_process');

function readKeychainToken() {
  if (process.platform !== 'darwin') return null;
  try {
    const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    const creds = JSON.parse(raw);
    return creds.claudeAiOauth?.accessToken || null;
  } catch {
    return null;
  }
}

function fetchClaudeCodeUsage() {
  const now = new Date().toISOString();
  const base = { id: 'anthropic', name: 'claude' };

  // Account info via CLI (best effort — Claude CLI may be missing or return non-JSON)
  let account = null;
  try {
    const authInfo = JSON.parse(execSync('claude auth status', { encoding: 'utf-8', timeout: 5000 }).trim());
    if (authInfo.loggedIn) {
      account = {
        email: authInfo.email,
        type: authInfo.authMethod,
        planType: authInfo.subscriptionType,
        orgName: authInfo.orgName,
      };
    }
  } catch { /* claude CLI unavailable */ }

  // Auth token resolution: env vars first, keychain on macOS as last resort
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY || readKeychainToken();
  if (!token) {
    return {
      ...base,
      account,
      limits: [{ label: 'usage', remainingPct: null, resetAt: null, errorMessage: 'No Claude auth token found' }],
      updatedAt: now,
    };
  }

  // We use curl rather than fetch() to dodge Node TLS cert issues we hit on some envs.
  try {
    const raw = execSync(
      `curl -s -H "Authorization: Bearer ${token}" -H "anthropic-beta: oauth-2025-04-20" -H "Accept: application/json" "https://api.anthropic.com/api/oauth/usage"`,
      { encoding: 'utf-8', timeout: 10000 }
    );
    const data = JSON.parse(raw);
    const limits = [];
    const labelMap = {
      five_hour: '5h limit',
      seven_day: 'weekly limit',
      seven_day_opus: 'weekly opus',
      seven_day_sonnet: 'weekly sonnet',
      seven_day_oauth_apps: 'weekly oauth apps',
      seven_day_cowork: 'weekly cowork',
      extra_usage: 'extra usage',
    };
    for (const [key, value] of Object.entries(data)) {
      if (!value || typeof value !== 'object') continue;
      let remainingPct = null;
      if (typeof value.utilization === 'number') {
        remainingPct = Math.max(0, Math.min(100, 100 - value.utilization));
      } else if (typeof value.used_credits === 'number' && typeof value.monthly_limit === 'number' && value.monthly_limit > 0) {
        remainingPct = Math.max(0, Math.min(100, 100 - (value.used_credits / value.monthly_limit) * 100));
      } else if (value.is_enabled !== undefined && remainingPct === null) {
        remainingPct = 100;
      }
      const resetAt = value.resets_at ? new Date(value.resets_at) : null;
      limits.push({ label: labelMap[key] || key, remainingPct, resetAt });
    }
    if (!limits.length) {
      limits.push({ label: 'usage', remainingPct: null, resetAt: null, errorMessage: 'No usage data found' });
    }
    return { ...base, account, limits, updatedAt: now };
  } catch (err) {
    return {
      ...base,
      account,
      limits: [{ label: 'usage', remainingPct: null, resetAt: null, errorMessage: err.message || 'Failed to fetch usage' }],
      updatedAt: now,
    };
  }
}

module.exports = { fetchClaudeCodeUsage };
