const {
  prepareActorTokenEnvironment,
  resolveDotEnvPath,
  buildActorTokenAppOptions,
} = require('./services/actorTokenPolicy');

// Actor credentials must never live in the repository .env that a
// Top/Operator CLI can read. A one-shot mode-0600 JSON file is validated,
// consumed, and unlinked before dotenv or any agent starts.
// Resolve the path once and pass that exact path to both the security check
// and dotenv. dotenv.config() does not itself honor DOTENV_CONFIG_PATH.
const dotenvPath = resolveDotEnvPath();
const actorTokenBootstrap = prepareActorTokenEnvironment({ envPath: dotenvPath });

// quiet: true — dotenv prints a promotional "tip" line (linking an unrelated
// third-party site) on every load by default; suppress it for clean boot logs.
// PALANTIR_SKIP_DOTENV opts out entirely — playwright.config.js sets it for
// both e2e webServers so a developer's local .env (PALANTIR_TOKEN, PORT,
// etc.) can't leak into test runs that assume no-auth on the default port.
if (!process.env.PALANTIR_SKIP_DOTENV) {
  require('dotenv').config({ quiet: true, path: dotenvPath });
}

const { createApp } = require('./app');
const { bootstrapClaudeAuthFromEnv } = require('./services/authResolver');
const { cleanupStaleTmuxStartupArtifacts } = require('./services/executionEngine');

// PR2: Claude auth bootstrap now lives in authResolver. The behavior is
// identical: if running inside a Claude Code session, persist credentials to
// .claude-auth.json; otherwise load them back into process.env.
bootstrapClaudeAuthFromEnv();

// A SIGKILL between persisting a worker's stdin/capability and the tmux
// bootstrap consuming it bypasses in-process cleanup. Sweep only Palantir's
// exact one-shot artifact names before any worker can be recovered or spawned.
const staleTmuxArtifacts = cleanupStaleTmuxStartupArtifacts();
if (staleTmuxArtifacts.prompts || staleTmuxArtifacts.capabilities) {
  console.warn(
    `[security] Removed stale tmux worker artifacts: prompts=${staleTmuxArtifacts.prompts} capabilities=${staleTmuxArtifacts.capabilities}`,
  );
}

const port = process.env.PORT || 4177;
const app = createApp(buildActorTokenAppOptions({
  env: process.env,
  actorTokenBootstrap,
}));

// Bind policy (PR1 / NEW-S1 + P0-1): do NOT expose an unauthenticated
// console to the network. Default to loopback. Allow 0.0.0.0 only when:
//   (a) PALANTIR_TOKEN is set (auth enforced), OR
//   (b) the operator explicitly sets HOST (e.g. HOST=0.0.0.0).
// This is a breaking change for deployments that previously relied on the
// implicit 0.0.0.0 bind — see README "Binding policy" for the migration.
const hasAuth = Boolean(actorTokenBootstrap?.authToken || process.env.PALANTIR_TOKEN);
const explicitHost = process.env.HOST;
let host;
if (explicitHost) {
  host = explicitHost;
  if (!hasAuth && (host === '0.0.0.0' || host === '::')) {
    console.warn(`[security] WARNING: HOST=${host} without PALANTIR_TOKEN — listening on all interfaces WITHOUT authentication. Set PALANTIR_TOKEN or bind to 127.0.0.1.`);
  }
} else {
  host = hasAuth ? '0.0.0.0' : '127.0.0.1';
}

if (!hasAuth) {
  console.warn('[security] No PALANTIR_TOKEN set — auth disabled.');
  console.warn(`[security] Listening on ${host}. Set PALANTIR_TOKEN to require auth and expose on 0.0.0.0.`);
}
if (hasAuth && process.env.PALANTIR_AGENT_PROCESS_ISOLATION !== 'verified') {
  console.warn('[security] Agent API capabilities disabled: managers/workers are not declared OS-user/container isolated.');
}

const bootInfo = app.bootInfo || {};
console.log(`[boot] packageVersion=${bootInfo.packageVersion || 'null'} gitSha=${bootInfo.gitSha || 'null'} startedAt=${bootInfo.startedAt || 'null'} bootId=${bootInfo.bootId || 'null'}`);

const server = app.listen(port, host, () => {
  const display = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  console.log(`Palantir Console running at http://${display}:${port}`);
});
server.on('error', (err) => {
  const code = err?.code || err?.message || 'UNKNOWN';
  console.error(`[boot] listen failed on ${host}:${port}: ${code}`);
  process.exit(1);
});

// Graceful shutdown: wire OS signals to app.shutdown() which disposes
// manager sessions, stops lifecycle monitor, and closes the database.
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, shutting down...`);
  // Watchdog FIRST: installed before any await so a hung in-flight distill drain
  // (or a rejecting app.shutdown) can never block exit (Codex BLOCKER).
  const watchdog = setTimeout(() => {
    console.warn('[shutdown] Forcing exit after timeout');
    process.exit(1);
  }, 10000);
  watchdog.unref();
  // Refuse new connections BEFORE the (possibly slow) async cleanup, so requests
  // don't arrive against torn-down services / a closing DB (Codex SERIOUS).
  server.close(() => console.log('[shutdown] HTTP server closed'));
  // PR5b: app.shutdown() may return a promise (waits for an in-flight distill
  // drain before closing the DB).
  try {
    if (app.shutdown) await app.shutdown();
  } catch (err) {
    console.warn('[shutdown] app.shutdown error:', err && err.message);
  }
  clearTimeout(watchdog);
  process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
