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
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const CLAUDE_AUTH_FILE = path.join(__dirname, '..', '..', '.claude-auth.json');
const CLAUDE_AUTH_KEYS = ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CODEX_AUTH_KEYS = ['CODEX_API_KEY', 'OPENAI_API_KEY'];
const CODEX_AUTH_FILE = path.join(os.homedir(), '.codex', 'auth.json');
// The Claude Code CLI's own credential store on platforms without a system
// keychain (Linux — e.g. `claude login` on a headless box). Same JSON shape
// as the macOS keychain payload (`claudeAiOauth.accessToken`).
const CLAUDE_LINUX_CREDENTIALS_FILE = path.join(os.homedir(), '.claude', '.credentials.json');

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
 * Existence+shape check for the Claude Code CLI's own credential file
 * (`~/.claude/.credentials.json`), the file-based counterpart to the macOS
 * Keychain item checked by hasClaudeKeychainCredentials() — used on any
 * platform without that native keychain integration (Linux, Windows). A
 * `claude login` on such a box writes credentials here instead, and
 * process.env never sees them (no CLAUDE_CODE_OAUTH_TOKEN export) — so
 * without this check resolveClaudeAuth() reports canAuth:false even though
 * the user is fully logged in.
 *
 * Platform-gated to non-macOS: excludes darwin specifically (covered by
 * hasClaudeKeychainCredentials() instead, avoiding a false "logged in"
 * positive from a stray same-shape file left over on a Mac whose CLI
 * actually reads the keychain) — NOT gated to Linux-only, since Windows has
 * no keychain integration here either and would otherwise be silently
 * broken (Codex adversarial re-review of PR #374 follow-up, round 4).
 *
 * Existence-only, mirroring the keychain path: we don't validate expiry
 * here. The spawned `claude` subprocess inherits HOME, reads this same
 * file itself, and can use the refresh token — an expired accessToken
 * doesn't mean canAuth should be false. (Expiry DOES matter for the
 * isolated path — see readClaudeLinuxCredentialsToken(), which extracts a
 * single static token with no refresh capability.)
 */
function hasClaudeLinuxCredentials() {
  if (process.platform === 'darwin') return false;
  try {
    const raw = fs.readFileSync(CLAUDE_LINUX_CREDENTIALS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed?.claudeAiOauth?.accessToken === 'string' && !!parsed.claudeAiOauth.accessToken;
  } catch {
    return false;
  }
}

/**
 * Read the access token out of ~/.claude/.credentials.json. File-based
 * counterpart to readClaudeKeychainToken() (non-macOS platforms — see
 * hasClaudeLinuxCredentials() for the gate rationale). Used where the token
 * must be materialized directly: isolated preset workers and usage queries.
 * (`--bare` strips an isolated worker's ability to read the credential file,
 * leaving it with no refresh capability once the token is extracted.)
 *
 * Rejects an already-expired accessToken (returns null) rather than handing
 * a materialized token to `--bare` that's guaranteed to fail at spawn time —
 * the normal (non-isolated) path doesn't need this because the live `claude`
 * subprocess can refresh itself from the same file's refreshToken.
 */
async function readClaudeLinuxCredentialsToken() {
  if (process.platform === 'darwin') return null;
  try {
    const raw = await fsp.readFile(CLAUDE_LINUX_CREDENTIALS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    const oauth = parsed?.claudeAiOauth;
    const token = oauth?.accessToken;
    if (typeof token !== 'string' || !token) return null;
    if (typeof oauth.expiresAt === 'number' && Date.now() >= oauth.expiresAt) return null;
    return token;
  } catch {
    return null;
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

  // Not in Claude Code session — try loading saved auth file. Always
  // attempted regardless of native-store presence: process.env.ANTHROPIC_API_KEY
  // is also read directly (outside this resolver) by other app features
  // (goal judge, memory distiller, specialist backend, usage provider) that
  // have no other way to pick up a persisted key.
  let loaded = 0;
  try {
    const auth = JSON.parse(fs.readFileSync(CLAUDE_AUTH_FILE, 'utf-8'));
    for (const k of CLAUDE_AUTH_KEYS) {
      if (auth[k] && typeof auth[k] === 'string' && !process.env[k]) {
        process.env[k] = auth[k];
        loaded += 1;
      }
    }
  } catch { /* file missing, unreadable, or invalid JSON — fall through below */ }

  if (loaded > 0) {
    logger.log('[authResolver] Loaded saved Claude auth credentials.');
    return true;
  }

  // No usable .claude-auth.json (missing, unparseable, or present but empty
  // of matching keys — all three land here, not just a thrown parse error).
  // On platforms without a system keychain (Linux, Windows), `claude login`
  // writes credentials straight to ~/.claude/.credentials.json — the spawned
  // `claude` subprocess reads that file itself (HOME inherited), so there's
  // nothing to persist here. This just avoids the misleading "no auth
  // found" warning when the user is in fact logged in.
  if (hasClaudeLinuxCredentials()) {
    logger.log('[authResolver] Found Claude Code CLI credentials at ~/.claude/.credentials.json — subprocess will read them directly.');
    return true;
  }
  logger.warn('[authResolver] No Claude auth found. Run server from Claude Code session first to save credentials.');
  logger.warn('[authResolver] Or set ANTHROPIC_API_KEY env var.');
  return false;
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
 *   4. Linux ~/.claude/.credentials.json (same existence-only treatment,
 *      for platforms without a system keychain)
 *
 * env returned in the result is what should be FORWARDED to the spawned
 * subprocess. Native store entries (keychain / Linux credentials file) are
 * intentionally NOT materialized into env: Claude CLI reads them itself
 * and forwarding would just leak the secret further.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.envAllowlist]  agent profile env_allowlist; if
 *                                        provided, only these keys are
 *                                        forwarded to the subprocess env.
 * @param {() => boolean} [opts.hasKeychain] DI hook for tests; defaults
 *                                           to the real keychain probe.
 * @param {() => boolean} [opts.hasCredentialsFile] DI hook for tests;
 *                                           defaults to the real Linux
 *                                           credentials-file probe.
 * @returns {{ canAuth: boolean, env: object, sources: string[], diagnostics: string[] }}
 */
function resolveClaudeAuth({
  envAllowlist,
  hasKeychain = hasClaudeKeychainCredentials,
  hasCredentialsFile = hasClaudeLinuxCredentials,
} = {}) {
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

  // (4) Linux Claude Code CLI credential file — same existence-only
  //     treatment as the keychain. `claude login` on a headless box writes
  //     here instead of a keychain; the spawned `claude` subprocess reads
  //     it itself (HOME inherited), so we never materialize the token.
  const credentialsFile = hasCredentialsFile();
  if (credentialsFile) sources.push('file:~/.claude/.credentials.json');

  const canAuth = !!(env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY || keychain || credentialsFile);
  if (!canAuth) {
    diagnostics.push('No Claude credentials found. Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, run `claude login` (populates the macOS keychain, or ~/.claude/.credentials.json on Linux/Windows), or start the server once from inside a Claude Code session to seed .claude-auth.json.');
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
 * materializes the payload into our process memory. Used where token
 * materialization is intentional: isolated preset workers (the CLI is
 * spawned with `--bare` and cannot read keychain itself) and usage queries.
 *
 * Returns the JSON-parsed `claudeAiOauth.accessToken` string, or null on
 * any failure (platform !== darwin, missing keychain item, parse error, or
 * an already-expired accessToken — see below).
 *
 * Rejects an already-expired accessToken (returns null) rather than handing
 * a materialized token to `--bare` that's guaranteed to fail at spawn time
 * — the isolated path has no refresh capability once a token is extracted,
 * unlike a live `claude` subprocess reading the keychain itself. Only
 * applies to the modern JSON shape, which is the only one carrying expiry
 * data; the legacy bare-string fallback below is unaffected.
 */
async function readClaudeKeychainToken() {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-w'],
      { stdio: 'pipe', timeout: 3000, encoding: 'utf8' },
    );
    const raw = stdout.trim();
    if (!raw) return null;
    // Claude Code stores its credentials as JSON in the keychain payload.
    // Fields of interest: claudeAiOauth.accessToken (+ expiresAt).
    try {
      const parsed = JSON.parse(raw);
      const oauth = parsed?.claudeAiOauth;
      const token = oauth?.accessToken;
      if (typeof token !== 'string' || !token) return null;
      if (typeof oauth.expiresAt === 'number' && Date.now() >= oauth.expiresAt) return null;
      return token;
    } catch {
      // Older schemas / test fixtures may store a bare token string instead
      // of JSON. Accept any non-empty string — the Anthropic API itself is
      // the authoritative validator of whether the value is a usable token.
      // No structured payload here, so no expiry data to check against.
      return raw;
    }
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
 * Token source priority (first hit wins) — normative per
 * docs/specs/worker-preset-and-plugin-injection.md §6.9:
 *   1. env `ANTHROPIC_API_KEY`
 *   2. `.claude-auth.json` — `ANTHROPIC_API_KEY` if present, else OAuth
 *      token (API accepts OAuth access tokens in the API-key slot —
 *      confirmed by Phase 10A spike, PR #87).
 *   3. macOS keychain item "Claude Code-credentials"
 *      (JSON `claudeAiOauth.accessToken`)
 *   4. Linux `~/.claude/.credentials.json` (same JSON shape; rejects an
 *      already-expired accessToken since this path has no refresh
 *      capability once extracted — see readClaudeLinuxCredentialsToken()).
 *
 * Fail-closed: when no token materializes, `{ canAuth: false, diagnostics }`.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.envAllowlist]
 * @param {() => boolean} [opts.hasKeychain]
 * @param {() => Promise<string|null>|string|null} [opts.readKeychainToken]
 * @param {() => boolean} [opts.hasCredentialsFile]
 * @param {() => Promise<string|null>|string|null} [opts.readCredentialsFileToken]
 * @param {'apiKeyHelper'|'env'} [opts.prefer]  Default 'apiKeyHelper'.
 * @param {string} [opts.tmpRoot]               Override (tests).
 * @returns {Promise<{
 *   canAuth: boolean,
 *   env: Record<string,string>,
 *   sources: string[],
 *   diagnostics: string[],
 *   apiKeyHelperSettings?: { settingsPath, helperPath, tmpDir, cleanup },
 * }>}
 */
async function resolveClaudeAuthForIsolated({
  envAllowlist,
  hasKeychain = hasClaudeKeychainCredentials,
  readKeychainToken = readClaudeKeychainToken,
  hasCredentialsFile = hasClaudeLinuxCredentials,
  readCredentialsFileToken = readClaudeLinuxCredentialsToken,
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
      const kcToken = await readKeychainToken();
      if (kcToken) {
        token = kcToken;
        sources.push('keychain:Claude Code-credentials:claudeAiOauth.accessToken');
      }
    }
  }

  if (!token) {
    // Linux fallback: ~/.claude/.credentials.json (no system keychain).
    if (hasCredentialsFile()) {
      const fileToken = await readCredentialsFileToken();
      if (fileToken) {
        token = fileToken;
        sources.push('file:~/.claude/.credentials.json:claudeAiOauth.accessToken');
      }
    }
  }

  if (!token) {
    diagnostics.push(
      'Isolated preset requires Claude auth. Set ANTHROPIC_API_KEY, run Palantir from a Claude Code session to seed .claude-auth.json, run `claude login` (macOS keychain, or ~/.claude/.credentials.json on Linux/Windows).',
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
 *
 * M4-a: `bearerEnvKeys` is an optional list of env var names that the
 * spawned worker NEEDS to read (Codex CLI's `bearer_token_env_var` lookup
 * happens inside the child process, not in argv). When supplied:
 *   - keys are auto-added to the allowlist (so the credential-strip step
 *     leaves them alone)
 *   - their values are forwarded from baseEnv to the child env. This is
 *     the M4-a single auto-allowlist hook so per-template bearer env vars
 *     don't have to be hand-listed in agent_profiles.env_allowlist.
 *   - Hard-denied keys (ENV_HARD_DENYLIST) are STILL refused — the auto-
 *     allowlist exemption is only for the credential-strip pass, not for
 *     the global denylist (which runs at template create time, so a
 *     hard-denied bearer_token_env_var never reaches this layer anyway).
 */
function buildManagerSpawnEnv({
  baseEnv = process.env,
  authEnv = {},
  envAllowlist,
  bearerEnvKeys,
  scrubHumanToken = false,
} = {}) {
  const env = { ...baseEnv };
  const baseAllowlist = Array.isArray(envAllowlist) ? envAllowlist : null;
  // M4-a: bearerEnvKeys auto-extend the allowlist. Empty/missing list means
  // no auto-allowlist behavior — back-compatible with PR2/PR3 callers.
  const bearer = Array.isArray(bearerEnvKeys)
    ? bearerEnvKeys.filter(k => typeof k === 'string' && k)
    : [];
  // When no baseAllowlist is provided we keep the legacy "no credential
  // strip" behavior — every key in baseEnv (including the bearer ones)
  // already flows through. The bearer auto-allowlist only adds value
  // when a baseAllowlist exists; without one, the bearer keys are
  // already forwarded by virtue of the unfiltered baseEnv copy.
  const allowSet = baseAllowlist
    ? new Set([...baseAllowlist, ...bearer])
    : null;

  const KNOWN_CREDENTIAL_KEYS = [
    ...CLAUDE_AUTH_KEYS,
    ...CODEX_AUTH_KEYS,
  ];
  for (const key of KNOWN_CREDENTIAL_KEYS) {
    if (allowSet && !allowSet.has(key)) {
      delete env[key];
    }
  }
  // Forward bearer env values from base when present. Without an explicit
  // baseAllowlist the env starts as a full copy of process.env, so the
  // values are already there — this loop is a defensive belt-and-suspenders
  // and a no-op in the common case.
  for (const key of bearer) {
    if (baseEnv[key] != null && env[key] == null) env[key] = baseEnv[key];
  }
  // G2 §6 (Codex BLOCKER-1): in goal mode the Operator must NOT be able to read
  // the human PALANTIR_TOKEN from its environment — otherwise it could send that
  // as a cookie and spoof the cookie-only human gate on command verify_checks.
  // Strip PALANTIR_TOKEN and keep only the separated PALANTIR_PM_TOKEN as the
  // Operator's bearer. Off by default → non-goal spawns are byte-identical.
  if (scrubHumanToken) {
    delete env.PALANTIR_TOKEN;
    if (baseEnv.PALANTIR_PM_TOKEN != null) env.PALANTIR_PM_TOKEN = baseEnv.PALANTIR_PM_TOKEN;
  }
  // Merge resolved auth env last so it always wins.
  for (const [k, v] of Object.entries(authEnv)) {
    if (v != null) env[k] = v;
  }
  // Defense-in-depth: authEnv must never smuggle the human token back in when
  // scrubbing (it shouldn't contain it, but enforce the invariant).
  if (scrubHumanToken) delete env.PALANTIR_TOKEN;
  return env;
}

/**
 * M4-a §L6.1/§L6.2: single entry point for resolving a bearer-token env
 * value at HTTP-MCP preflight time. Returns:
 *
 *   { ok: true,  value: '<token>' }    — env var present + non-empty
 *   { ok: false, reason: 'missing' }   — env var absent or empty
 *   { ok: false, reason: 'invalid_name' }  — name is malformed
 *
 * The token VALUE is never logged, never echoed in SSE payloads, never
 * included in error.message strings — only the *key name* surfaces (and
 * even then only via the explicit `name` echoed back). `value` returned
 * to the caller is intended for one immediate use (`Authorization: Bearer
 * <value>` header) and MUST NOT be persisted.
 */
function resolveBearerForPreflight(envVarName) {
  if (typeof envVarName !== 'string' || !envVarName) {
    return { ok: false, reason: 'invalid_name', name: envVarName };
  }
  // POSIX env var name guard — same as mcpTemplateService.validateBearerTokenEnvVar.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envVarName)) {
    return { ok: false, reason: 'invalid_name', name: envVarName };
  }
  const v = process.env[envVarName];
  if (typeof v !== 'string' || !v) {
    return { ok: false, reason: 'missing', name: envVarName };
  }
  return { ok: true, value: v, name: envVarName };
}

module.exports = {
  bootstrapClaudeAuthFromEnv,
  resolveClaudeAuth,
  resolveClaudeAuthForIsolated,
  readClaudeKeychainToken,
  resolveCodexAuth,
  resolveManagerAuth,
  buildManagerSpawnEnv,
  resolveBearerForPreflight,
  hasClaudeKeychainCredentials,
  hasClaudeLinuxCredentials,
  readClaudeLinuxCredentialsToken,
  // Exposed for tests
  CLAUDE_AUTH_FILE,
  CODEX_AUTH_FILE,
  CLAUDE_AUTH_KEYS,
  CODEX_AUTH_KEYS,
  CLAUDE_KEYCHAIN_SERVICE,
  CLAUDE_LINUX_CREDENTIALS_FILE,
};
