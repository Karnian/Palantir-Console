/**
 * Claude Code provider adapter — desktop OAuth flavor.
 *
 * Distinct from anthropic.js: this path resolves the auth token from the
 * Claude Code desktop OAuth flow (CLAUDE_CODE_OAUTH_TOKEN env, then falls back
 * to ANTHROPIC_API_KEY, then the native platform credential store — macOS
 * Keychain, or ~/.claude/.credentials.json on Linux/Windows — via
 * authResolver's shared readers). It also tries `claude auth status`
 * to enrich the response with account info. Both paths still hit the Anthropic
 * OAuth usage endpoint, but the auth source matters — collapsing them would
 * silently break Claude Code installs that don't have ANTHROPIC_API_KEY exported.
 */

const { execSync } = require('node:child_process');
const { readClaudeKeychainToken, readClaudeLinuxCredentialsToken } = require('../authResolver');

/**
 * OAuth usage 응답 → canonical limits 배열.
 *
 * Only entries that carry an actual utilization signal become limits — the
 * endpoint also ships meta objects (e.g. `limits`, `spend`) that used to be
 * enumerated verbatim as "limits ?%" / "spend ?%" cards. An entry qualifies
 * when we can derive remainingPct from it (utilization / credits / is_enabled).
 * Shared by the local adapter and the pod-side probe (nodeUsageService) so
 * both surfaces parse identically.
 */
function parseOAuthUsageLimits(data) {
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
  for (const [key, value] of Object.entries(data || {})) {
    if (!value || typeof value !== 'object') continue;
    let remainingPct = null;
    if (typeof value.utilization === 'number') {
      remainingPct = Math.max(0, Math.min(100, 100 - value.utilization));
    } else if (typeof value.used_credits === 'number' && typeof value.monthly_limit === 'number' && value.monthly_limit > 0) {
      remainingPct = Math.max(0, Math.min(100, 100 - (value.used_credits / value.monthly_limit) * 100));
    } else if (value.is_enabled === true) {
      // Enabled-flag-only entries (extra_usage without spend yet) read as
      // fully available; a false flag is a disabled feature, not a limit —
      // skip it instead of rendering 100% (Codex security R1 SERIOUS 3).
      remainingPct = 100;
    } else {
      // No utilization signal — meta object, not a rate limit. Skip.
      continue;
    }
    const resetAt = value.resets_at ? new Date(value.resets_at) : null;
    limits.push({ label: labelMap[key] || key, remainingPct, resetAt });
  }
  if (!limits.length) {
    limits.push({ label: 'usage', remainingPct: null, resetAt: null, errorMessage: 'No usage data found' });
  }
  return limits;
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

  // Auth token resolution: env vars first, then native platform credential
  // store as a last resort — macOS Keychain, or (Linux/Windows) the CLI's
  // own ~/.claude/.credentials.json file. Delegates to authResolver's
  // shared, platform-gated, expiry-checked readers instead of duplicating
  // that logic here (this file used to have its own darwin-only keychain
  // reader, which silently returned null — and this "No Claude auth token
  // found" error — on any non-macOS box regardless of actual login state).
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY
    || readClaudeKeychainToken() || readClaudeLinuxCredentialsToken();
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
    const limits = parseOAuthUsageLimits(JSON.parse(raw));
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

module.exports = { fetchClaudeCodeUsage, parseOAuthUsageLimits };
