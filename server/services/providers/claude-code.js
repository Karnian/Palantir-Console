/**
 * Claude Code provider adapter — desktop OAuth flavor.
 *
 * OAuth value access is disabled by default. Legacy mode resolves env OAuth,
 * then native credential stores; actual API keys are never sent to this endpoint.
 * Account status remains CLI-owned in both modes.
 */

const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const {
  legacyClaudeCredentialAccessEnabled,
  isClaudeOAuthTokenValue,
  CLAUDE_AUTH_KEYS,
  stripClaudeOAuthEnv,
  readClaudeKeychainToken,
  readClaudeLinuxCredentialsToken,
  hostCredentialDiscoveryDisabled,
} = require('../authResolver');
const { sanitizeMessage } = require('../../utils/errors');

const execFileAsync = promisify(execFile);

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

async function fetchClaudeCodeUsage({
  spawn: spawnFn = spawn,
  execFile: execFileFn = execFileAsync,
  readKeychainToken = readClaudeKeychainToken,
  readCredentialsFileToken = readClaudeLinuxCredentialsToken,
} = {}) {
  const now = new Date().toISOString();
  const base = { id: 'anthropic', name: 'claude' };

  // Account info via CLI (best effort — Claude CLI may be missing or return non-JSON).
  // The CLI does its own credential discovery, so it would report the host
  // account even with every credential env var cleared — skip it under isolation.
  let account = null;
  try {
    if (hostCredentialDiscoveryDisabled()) throw new Error('host credential discovery disabled');
    const { stdout } = await execFileFn('claude', ['auth', 'status'], { encoding: 'utf-8', timeout: 5000, env: stripClaudeOAuthEnv({ ...process.env }) });
    const authInfo = JSON.parse(stdout.trim());
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
  if (!legacyClaudeCredentialAccessEnabled()) {
    return { ...base, account, updatedAt: now, limits: [{ label: 'usage', remainingPct: null, resetAt: null,
      errorMessage: '자격 조회 꺼짐: PALANTIR_LEGACY_CLAUDE_CREDENTIAL_ACCESS=1 required' }] };
  }
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN
    || (isClaudeOAuthTokenValue(process.env.ANTHROPIC_API_KEY) ? process.env.ANTHROPIC_API_KEY : null)
    || await readKeychainToken() || await readCredentialsFileToken();
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
    if (/[\r\n\0]/.test(token)) throw new Error('Invalid OAuth token header');
    const env = { ...process.env };
    for (const key of CLAUDE_AUTH_KEYS) delete env[key];
    stripClaudeOAuthEnv(env);
    const raw = await new Promise((resolve, reject) => {
      const child = spawnFn('curl', ['-q', '-s', '-H', '@-', '-H', 'anthropic-beta: oauth-2025-04-20',
        '-H', 'Accept: application/json', 'https://api.anthropic.com/api/oauth/usage'],
      { env, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', () => {});
      child.on('error', reject);
      child.stdin.on('error', reject);
      child.on('close', (code, signal) => code === 0 && !signal
        ? resolve(output) : reject(new Error('OAuth usage curl failed')));
      child.stdin.end(`Authorization: Bearer ${token}\n`);
    });
    const limits = parseOAuthUsageLimits(JSON.parse(raw));
    return { ...base, account, limits, updatedAt: now };
  } catch (err) {
    return {
      ...base,
      account,
      limits: [{
        label: 'usage',
        remainingPct: null,
        resetAt: null,
        errorMessage: sanitizeMessage(err?.message || 'Failed to fetch usage', [token]),
      }],
      updatedAt: now,
    };
  }
}

module.exports = { fetchClaudeCodeUsage, parseOAuthUsageLimits };
