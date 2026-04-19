const { createApp } = require('./app');
const { bootstrapClaudeAuthFromEnv } = require('./services/authResolver');

// PR2: Claude auth bootstrap now lives in authResolver. The behavior is
// identical: if running inside a Claude Code session, persist credentials to
// .claude-auth.json; otherwise load them back into process.env.
bootstrapClaudeAuthFromEnv();

const port = process.env.PORT || 4177;
const app = createApp();

// Bind policy (PR1 / NEW-S1 + P0-1): do NOT expose an unauthenticated
// console to the network. Default to loopback. Allow 0.0.0.0 only when:
//   (a) PALANTIR_TOKEN is set (auth enforced), OR
//   (b) the operator explicitly sets HOST (e.g. HOST=0.0.0.0).
// This is a breaking change for deployments that previously relied on the
// implicit 0.0.0.0 bind — see README "Binding policy" for the migration.
const hasAuth = Boolean(process.env.PALANTIR_TOKEN);
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

const server = app.listen(port, host, () => {
  const display = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  console.log(`Palantir Console running at http://${display}:${port}`);
});

// Graceful shutdown: wire OS signals to app.shutdown() which disposes
// manager sessions, stops lifecycle monitor, and closes the database.
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, shutting down...`);
  if (app.shutdown) app.shutdown();
  server.close(() => {
    console.log('[shutdown] HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => {
    console.warn('[shutdown] Forcing exit after timeout');
    process.exit(1);
  }, 10000).unref();
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
