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
const { execFileSync } = require('node:child_process');

const CLAUDE_AUTH_FILE = path.join(__dirname, '..', '..', '.claude-auth.json');
const CLAUDE_AUTH_KEYS = ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CODEX_AUTH_KEYS = ['CODEX_API_KEY', 'OPENAI_API_KEY'];
const CODEX_AUTH_FILE = path.join(os.homedir(), '.codex', 'auth.json');

/**
 * Check whether the macOS Keychain has a Claude Code OAuth credentials item.
 *
 * Why this exists: server/services/providers/claude-code.js uses the
 * keychain as a token fallback when neither CLAUDE_CODE_OAUTH_TOKEN nor
 * ANTHROPIC_API_KEY is set in process.env. Before this helper, the manager
 * preflight (resolveClaudeAuth) was unaware of the keychain entirely, which
 * produced false-negative "no credentials" errors for the very common case
 * of a user logged in via the Claude Code desktop app: agent detail modal
 * showed live usage data (because the usage path read keychain directly),
 * but the manager picker rendered "no credentials" and /api/manager/start
 * returned 400 manager_auth_unavailable. See PR #18.
 *
 * Implementation notes:
 *   - We deliberately do NOT pass `-w` to `security`. Without `-w`, the
 *     password payload is never written to our process memory. We only
 *     learn whether the item exists. The Claude CLI itself reads the
 *     payload at spawn time, so we don't need it in the preflight.
 *   - execFileSync (not execSync) — argv array, no shell, no injection.
 *   - 3s timeout because keychain ACL prompts can stall otherwise.
 *   - non-darwin platforms short-circuit to false; the `security` binary
 *     does not exist there.
 *   - Failures (item missing, ACL denied, command not found) all collapse
 *     to false. preflight is a hint, not a guarantee — if keychain says
 *     "yes" and the actual spawn later fails, the spawn-time error is the
 *     authoritative signal.
 */
function hasClaudeKeychainCredentials() {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('security', ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE], {
      stdio: 'pipe',
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read .claude-auth.json on demand and merge any keys that pass the
 * allowlist into the returned env object. This is a DEFERRED read so
 * users who manually drop the file in (without restarting the server
 * to re-run bootstrap) still see canAuth flip to true on the next
 * picker refresh. Returns {} on any failure (file missing, parse error,
 * non-object payload).
 */
function readClaudeAuthFile(allowSet) {
  try {
    const raw = fs.readFileSync(CLAUDE_AUTH_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const k of CLAUDE_AUTH_KEYS) {
      if (typeof parsed[k] === 'string' && parsed[k] && allowSet.has(k)) {
        out[k] = parsed[k];
      }
    }
    return out;
  } catch {
    return {};
  }
}

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
 * Source parity (matches server/services/providers/claude-code.js):
 *   1. process.env (CLAUDE_CODE_OAUTH_TOKEN > ANTHROPIC_API_KEY)
 *   2. .claude-auth.json on disk (re-read on demand so a freshly seeded
 *      file flips canAuth without a server restart)
 *   3. macOS Keychain item "Claude Code-credentials" (existence only —
 *      payload is read at spawn time by Claude CLI itself)
 *
 * env returned in the result is what should be FORWARDED to the spawned
 * subprocess. The keychain entry is intentionally NOT materialized into
 * env: Claude CLI reads keychain itself and forwarding it would just
 * leak the secret further.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.envAllowlist]  agent profile env_allowlist; if
 *                                        provided, only these keys are
 *                                        forwarded to the subprocess env.
 * @param {() => boolean} [opts.hasKeychain] DI hook for tests; defaults
 *                                           to the real keychain probe.
 * @returns {{ canAuth: boolean, env: object, sources: string[], diagnostics: string[] }}
 */
function resolveClaudeAuth({ envAllowlist, hasKeychain = hasClaudeKeychainCredentials } = {}) {
  const env = {};
  const sources = [];
  const diagnostics = [];

  const allow = Array.isArray(envAllowlist) && envAllowlist.length > 0
    ? new Set(envAllowlist)
    : new Set(CLAUDE_AUTH_KEYS);

  // (1) Direct env vars
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

  // (2) Saved auth file — re-read on demand. If the file has keys we
  //     don't yet have in env, merge them. This makes "drop file in,
  //     refresh picker" work without a server restart.
  let fileEnv = {};
  let fileExists = false;
  try {
    fileExists = fs.existsSync(CLAUDE_AUTH_FILE);
  } catch { /* ignore */ }
  if (fileExists) {
    fileEnv = readClaudeAuthFile(allow);
    if (Object.keys(fileEnv).length > 0) {
      sources.push('file:.claude-auth.json');
      for (const [k, v] of Object.entries(fileEnv)) {
        if (!env[k]) env[k] = v;
      }
    }
  }

  // (3) macOS Keychain — existence only. NOT merged into env (Claude CLI
  //     reads keychain itself; forwarding the secret would leak it).
  const keychain = hasKeychain();
  if (keychain) sources.push('keychain:Claude Code-credentials');

  const canAuth = !!(env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY || keychain);
  if (!canAuth) {
    diagnostics.push('No Claude credentials found. Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, run the Claude Code desktop app to populate the macOS keychain, or start the server once from inside a Claude Code session to seed .claude-auth.json.');
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
 * Read the Claude Code credentials payload from the macOS keychain and
 * extract the OAuth access token that can be passed as ANTHROPIC_API_KEY.
 *
 * Unlike hasClaudeKeychainCredentials(), this uses `security -w` which
 * materializes the payload into our process memory. Only called from the
 * isolated preset path (Phase 10D) where token materialization is
 * intentional — the CLI is spawned with `--bare` and cannot read keychain
 * itself.
 *
 * Returns the JSON-parsed `claudeAiOauth.accessToken` string, or null on
 * any failure (platform !== darwin, missing keychain item, parse error).
 */
function readClaudeKeychainToken() {
  if (process.platform !== 'darwin') return null;
  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-w'],
      { stdio: 'pipe', timeout: 3000, encoding: 'utf8' },
    ).trim();
    if (!raw) return null;
    // Claude Code stores its credentials as JSON in the keychain payload.
    // Fields of interest: claudeAiOauth.accessToken.
    try {
      const parsed = JSON.parse(raw);
      const token = parsed?.claudeAiOauth?.accessToken;
      if (typeof token === 'string' && token) return token;
    } catch {
      // Older schemas might store a bare token string instead of JSON.
      if (/^[\w.-]+$/.test(raw)) return raw;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve Claude auth for an **isolated preset** spawn (Phase 10D, §6.9).
 *
 * `--bare` strips the CLI's ability to read OAuth / keychain / settings, so
 * we must materialize a token as `ANTHROPIC_API_KEY` and wire it via either
 * an `apiKeyHelper` script (default — token stays off `ps`/`/proc`) or an
 * env pass-through (fallback — test / temporary use).
 *
 * Token source priority (first hit wins):
 *   1. env `ANTHROPIC_API_KEY`
 *   2. `.claude-auth.json` — `ANTHROPIC_API_KEY` if present, else OAuth
 *      token (API accepts OAuth access tokens in the API-key slot —
 *      confirmed by Phase 10A spike, PR #87).
 *   3. macOS keychain item "Claude Code-credentials"
 *      (JSON `claudeAiOauth.accessToken`)
 *
 * Fail-closed: when no token materializes, `{ canAuth: false, diagnostics }`.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.envAllowlist]
 * @param {() => boolean} [opts.hasKeychain]
 * @param {() => string|null} [opts.readKeychainToken]
 * @param {'apiKeyHelper'|'env'} [opts.prefer]  Default 'apiKeyHelper'.
 * @param {string} [opts.tmpRoot]               Override (tests).
 * @returns {{
 *   canAuth: boolean,
 *   env: Record<string,string>,
 *   sources: string[],
 *   diagnostics: string[],
 *   apiKeyHelperSettings?: { settingsPath, helperPath, tmpDir, cleanup },
 * }}
 */
function resolveClaudeAuthForIsolated({
  envAllowlist,
  hasKeychain = hasClaudeKeychainCredentials,
  readKeychainToken = readClaudeKeychainToken,
  prefer = 'apiKeyHelper',
  tmpRoot = os.tmpdir(),
} = {}) {
  const sources = [];
  const diagnostics = [];

  const allow = Array.isArray(envAllowlist) && envAllowlist.length > 0
    ? new Set(envAllowlist)
    : new Set(CLAUDE_AUTH_KEYS);

  let token = null;

  if (process.env.ANTHROPIC_API_KEY && allow.has('ANTHROPIC_API_KEY')) {
    token = process.env.ANTHROPIC_API_KEY;
    sources.push('env:ANTHROPIC_API_KEY');
  }

  if (!token) {
    // Read the on-disk file directly with the broadest allowlist — once we
    // are in the isolated path we WILL materialize the token, and the
    // allowlist exists to restrict what leaks into the child env, not to
    // constrain which on-disk fields we may read.
    let fileEnv = {};
    try {
      fileEnv = readClaudeAuthFile(new Set(CLAUDE_AUTH_KEYS));
    } catch { /* ignore */ }
    if (fileEnv.ANTHROPIC_API_KEY) {
      token = fileEnv.ANTHROPIC_API_KEY;
      sources.push('file:.claude-auth.json:ANTHROPIC_API_KEY');
    } else if (fileEnv.CLAUDE_CODE_OAUTH_TOKEN) {
      // Phase 10A spike (PR #87) confirmed OAuth access tokens are
      // accepted in the ANTHROPIC_API_KEY slot — so we forward the OAuth
      // token into the API-key materialization path here.
      token = fileEnv.CLAUDE_CODE_OAUTH_TOKEN;
      sources.push('file:.claude-auth.json:CLAUDE_CODE_OAUTH_TOKEN');
    }
  }

  if (!token) {
    if (hasKeychain()) {
      // sources note added after success only — the probe alone isn't
      // proof of extraction.
      const kcToken = readKeychainToken();
      if (kcToken) {
        token = kcToken;
        sources.push('keychain:Claude Code-credentials:claudeAiOauth.accessToken');
      }
    }
  }

  if (!token) {
    diagnostics.push(
      'Isolated preset requires Claude auth. Set ANTHROPIC_API_KEY, run Palantir from a Claude Code session to seed .claude-auth.json, or ensure the macOS keychain has a "Claude Code-credentials" item.',
    );
    return { canAuth: false, env: {}, sources, diagnostics };
  }

  // Fallback path: expose token via env. Leaks the token to `ps`/`/proc` of
  // the child process; documented — only use when apiKeyHelper is
  // explicitly unavailable or opted out.
  if (prefer === 'env') {
    sources.push('materialize:env:ANTHROPIC_API_KEY');
    return {
      canAuth: true,
      env: { ANTHROPIC_API_KEY: token },
      sources,
      diagnostics,
    };
  }

  // Default: write a temp apiKeyHelper script + settings.json. Token is
  // kept off env. Caller is responsible for invoking cleanup on process
  // exit — streamJsonEngine wires this into the child's 'close' handler.
  const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'palantir-claude-iso-'));
  const helperPath = path.join(tmpDir, 'api-key-helper.sh');
  const settingsPath = path.join(tmpDir, 'settings.json');

  // Shell-safe embedding: single-quote + escape existing quotes.
  const shEscaped = String(token).replace(/'/g, `'\\''`);
  const script = `#!/bin/sh\nprintf '%s' '${shEscaped}'\n`;
  fs.writeFileSync(helperPath, script, { mode: 0o700 });
  fs.writeFileSync(settingsPath, JSON.stringify({ apiKeyHelper: helperPath }), { mode: 0o600 });

  sources.push('materialize:apiKeyHelper');

  const cleanup = () => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  };

  return {
    canAuth: true,
    env: {},
    sources,
    diagnostics,
    apiKeyHelperSettings: { settingsPath, helperPath, tmpDir, cleanup },
  };
}

/**
 * Single entry point used by routes/manager.js. type → strategy.
 *
 * opts is forwarded to the strategy. Tests may inject `hasKeychain` here
 * to make resolveClaudeAuth deterministic.
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
  resolveClaudeAuthForIsolated,
  readClaudeKeychainToken,
  resolveCodexAuth,
  resolveManagerAuth,
  buildManagerSpawnEnv,
  hasClaudeKeychainCredentials,
  // Exposed for tests
  CLAUDE_AUTH_FILE,
  CODEX_AUTH_FILE,
  CLAUDE_AUTH_KEYS,
  CODEX_AUTH_KEYS,
  CLAUDE_KEYCHAIN_SERVICE,
};
