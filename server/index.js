const { createApp } = require('./app');
const fs = require('node:fs');
const path = require('node:path');

// Persist Claude auth env vars so subprocesses can use them.
// When server is started from within a Claude Code session, these vars are available.
// When started standalone (e.g., launch.json), we load from saved file.
const AUTH_FILE = path.join(__dirname, '..', '.claude-auth.json');
const AUTH_KEYS = ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];

if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) {
  // Running inside Claude Code session — save auth for future use
  const auth = {};
  for (const k of AUTH_KEYS) {
    if (process.env[k]) auth[k] = process.env[k];
  }
  try {
    fs.writeFileSync(AUTH_FILE, JSON.stringify(auth), { mode: 0o600 });
    fs.chmodSync(AUTH_FILE, 0o600); // enforce permissions even if file existed
    console.log('[auth] Saved Claude auth credentials for subprocess use.');
  } catch (e) {
    console.warn('[auth] Failed to save auth:', e.message);
  }
} else {
  // Not in Claude Code session — try loading saved auth
  try {
    const auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
    // Only load known auth keys — prevent arbitrary env injection from tampered file
    for (const k of AUTH_KEYS) {
      if (auth[k] && typeof auth[k] === 'string' && !process.env[k]) {
        process.env[k] = auth[k];
      }
    }
    console.log('[auth] Loaded saved Claude auth credentials.');
  } catch {
    console.warn('[auth] No Claude auth found. Run server from Claude Code session first to save credentials.');
    console.warn('[auth] Or set ANTHROPIC_API_KEY env var.');
  }
}

const port = process.env.PORT || 4177;
const app = createApp();

// Security: bind to localhost only when auth is disabled
const hasAuth = Boolean(process.env.PALANTIR_TOKEN);
const host = hasAuth ? '0.0.0.0' : '127.0.0.1';

if (!hasAuth) {
  console.warn('[security] WARNING: No PALANTIR_TOKEN set — auth disabled, binding to localhost only.');
  console.warn('[security] Set PALANTIR_TOKEN env var to enable auth and allow remote access.');
}

app.listen(port, host, () => {
  console.log(`Palantir Console running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
});
