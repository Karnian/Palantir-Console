/**
 * authResolver — manager-adapter auth resolution (PR2).
 *
 * Centralizes:
 *   1. Persisting Claude credentials picked up from a parent Claude Code session
 *      to .claude-auth.json (the logic that used to live in server/index.js).
 *   2. Resolving the auth context for a given adapter type before /api/manager/start
 *      spawns a subprocess. Returns { canAuth, env, sources, diagnostics } so
 *      the route can fail fast with a clear 400 instead of producing a half-spawned
 *      process whose only symptom is "Claude exited with code 1".
 *
 * No DB schema changes — auth lives entirely in env vars + on-disk auth files.
 *
 * D-matrix:
 *   - D8: single-instance only, no shared state across processes
 *   - PR2 contract: type → strategy mapping is hard-coded; PR3 will resolve
 *                   the type from agent_profile_id and start passing
 *                   envAllowlist (today the resolver supports the option but
 *                   no caller exercises it — the only PR2 caller is the
 *                   /api/manager/start preflight which uses defaults).
 *   - For Codex, the presence of ~/.codex/auth.json is a coarse preflight
 *     signal only; the file is NOT parsed/validated here. Real validation
 *     happens when CodexAdapter (PR4) actually spawns `codex exec`.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CLAUDE_AUTH_FILE = path.join(__dirname, '..', '..', '.claude-auth.json');
const CLAUDE_AUTH_KEYS = ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
const CODEX_AUTH_KEYS = ['CODEX_API_KEY', 'OPENAI_API_KEY'];
const CODEX_AUTH_FILE = path.join(os.homedir(), '.codex', 'auth.json');

/**
 * Persist any Claude credentials currently visible in process.env to disk so
 * a future server start outside the Claude Code session still has them.
 *
 * Returns true if credentials were saved or successfully loaded from disk,
 * false if neither path produced usable credentials.
 *
 * Mirrors the logic that previously lived inline in server/index.js.
 */
function bootstrapClaudeAuthFromEnv({ logger = console } = {}) {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) {
    const auth = {};
    for (const k of CLAUDE_AUTH_KEYS) {
      if (process.env[k]) auth[k] = process.env[k];
    }
    try {
      fs.writeFileSync(CLAUDE_AUTH_FILE, JSON.stringify(auth), { mode: 0o600 });
      try { fs.chmodSync(CLAUDE_AUTH_FILE, 0o600); } catch { /* ignore */ }
      logger.log('[authResolver] Saved Claude auth credentials for subprocess use.');
      return true;
    } catch (e) {
      logger.warn('[authResolver] Failed to save Claude auth:', e.message);
      return false;
    }
  }

  // Not in Claude Code session — try loading saved auth file.
  try {
    const auth = JSON.parse(fs.readFileSync(CLAUDE_AUTH_FILE, 'utf-8'));
    let loaded = 0;
    for (const k of CLAUDE_AUTH_KEYS) {
      if (auth[k] && typeof auth[k] === 'string' && !process.env[k]) {
        process.env[k] = auth[k];
        loaded += 1;
      }
    }
    if (loaded > 0) {
      logger.log('[authResolver] Loaded saved Claude auth credentials.');
      return true;
    }
    return false;
  } catch {
    logger.warn('[authResolver] No Claude auth found. Run server from Claude Code session first to save credentials.');
    logger.warn('[authResolver] Or set ANTHROPIC_API_KEY env var.');
    return false;
  }
}

/**
 * Resolve auth for a Claude manager session.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.envAllowlist]  agent profile env_allowlist; if
 *                                        provided, only these keys are
 *                                        forwarded to the subprocess env.
 * @returns {{ canAuth: boolean, env: object, sources: string[], diagnostics: string[] }}
 */
function resolveClaudeAuth({ envAllowlist } = {}) {
  const env = {};
  const sources = [];
  const diagnostics = [];

  const allow = Array.isArray(envAllowlist) && envAllowlist.length > 0
    ? new Set(envAllowlist)
    : new Set(CLAUDE_AUTH_KEYS);

  // Direct env vars
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN && allow.has('CLAUDE_CODE_OAUTH_TOKEN')) {
    env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    sources.push('env:CLAUDE_CODE_OAUTH_TOKEN');
  }
  if (process.env.ANTHROPIC_API_KEY && allow.has('ANTHROPIC_API_KEY')) {
    env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    sources.push('env:ANTHROPIC_API_KEY');
  }
  if (process.env.ANTHROPIC_BASE_URL && allow.has('ANTHROPIC_BASE_URL')) {
    env.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
    sources.push('env:ANTHROPIC_BASE_URL');
  }

  // Saved auth file
  try {
    if (fs.existsSync(CLAUDE_AUTH_FILE)) {
      sources.push('file:.claude-auth.json');
    }
  } catch { /* ignore */ }

  const canAuth = !!(env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY);
  if (!canAuth) {
    diagnostics.push('No Claude credentials found. Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, or start the server once from inside a Claude Code session to seed .claude-auth.json.');
    if (Array.isArray(envAllowlist) && envAllowlist.length > 0) {
      const blocked = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']
        .filter(k => process.env[k] && !allow.has(k));
      if (blocked.length > 0) {
        diagnostics.push(`Profile env_allowlist excluded these present env vars: ${blocked.join(', ')}.`);
      }
    }
  }

  return { canAuth, env, sources, diagnostics };
}

/**
 * Resolve auth for a Codex manager session (PR4 will use this — kept here so
 * PR2 establishes the contract for both adapters).
 */
function resolveCodexAuth({ envAllowlist } = {}) {
  const env = {};
  const sources = [];
  const diagnostics = [];

  const allow = Array.isArray(envAllowlist) && envAllowlist.length > 0
    ? new Set(envAllowlist)
    : new Set(CODEX_AUTH_KEYS);

  if (process.env.CODEX_API_KEY && allow.has('CODEX_API_KEY')) {
    env.CODEX_API_KEY = process.env.CODEX_API_KEY;
    sources.push('env:CODEX_API_KEY');
  }
  if (process.env.OPENAI_API_KEY && allow.has('OPENAI_API_KEY')) {
    env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    sources.push('env:OPENAI_API_KEY');
  }

  let hasCodexFile = false;
  try { hasCodexFile = fs.existsSync(CODEX_AUTH_FILE); } catch { /* ignore */ }
  if (hasCodexFile) sources.push(`file:${CODEX_AUTH_FILE}`);

  const canAuth = !!(env.CODEX_API_KEY || env.OPENAI_API_KEY || hasCodexFile);
  if (!canAuth) {
    diagnostics.push(`No Codex credentials found. Set CODEX_API_KEY/OPENAI_API_KEY or run \`codex login\` to create ${CODEX_AUTH_FILE}.`);
    if (Array.isArray(envAllowlist) && envAllowlist.length > 0) {
      const blocked = CODEX_AUTH_KEYS.filter(k => process.env[k] && !allow.has(k));
      if (blocked.length > 0) {
        diagnostics.push(`Profile env_allowlist excluded these present env vars: ${blocked.join(', ')}.`);
      }
    }
  }

  return { canAuth, env, sources, diagnostics };
}

/**
 * Single entry point used by routes/manager.js. type → strategy.
 */
function resolveManagerAuth(type, opts = {}) {
  if (type === 'codex') return resolveCodexAuth(opts);
  // claude-code is the default for backward compatibility (PR1a-PR2 era);
  // PR3 will require explicit agent_profile_id and turn unknown types into
  // an error.
  return resolveClaudeAuth(opts);
}

/**
 * Build a filtered subprocess env for a manager adapter spawn.
 *
 * Strategy (defensive, low blast radius):
 *   - Start from process.env
 *   - Remove known-credential keys that are NOT on the allowlist. This
 *     prevents a Claude-type profile from leaking CODEX_API_KEY / OPENAI_API_KEY
 *     into the subprocess (and vice versa), which was the explicit threat
 *     model in the PR2/3/4 reviews.
 *   - Keep everything else (PATH, HOME, LANG, tool-specific config dirs)
 *     because both CLIs rely on a lot of environment for normal operation.
 *   - Merge authCtx.env on top so any values that passed the allowlist are
 *     definitely present.
 */
function buildManagerSpawnEnv({ baseEnv = process.env, authEnv = {}, envAllowlist } = {}) {
  const env = { ...baseEnv };
  const allowSet = Array.isArray(envAllowlist) ? new Set(envAllowlist) : null;
  const KNOWN_CREDENTIAL_KEYS = [
    ...CLAUDE_AUTH_KEYS,
    ...CODEX_AUTH_KEYS,
  ];
  for (const key of KNOWN_CREDENTIAL_KEYS) {
    if (allowSet && !allowSet.has(key)) {
      delete env[key];
    }
  }
  // Merge resolved auth env last so it always wins.
  for (const [k, v] of Object.entries(authEnv)) {
    if (v != null) env[k] = v;
  }
  return env;
}

module.exports = {
  bootstrapClaudeAuthFromEnv,
  resolveClaudeAuth,
  resolveCodexAuth,
  resolveManagerAuth,
  buildManagerSpawnEnv,
  // Exposed for tests
  CLAUDE_AUTH_FILE,
  CODEX_AUTH_FILE,
  CLAUDE_AUTH_KEYS,
  CODEX_AUTH_KEYS,
};
