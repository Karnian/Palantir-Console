const { createApp } = require('./app');

// Check for Claude Code auth before starting
if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.warn('[auth] WARNING: No ANTHROPIC_API_KEY set.');
  console.warn('[auth] Manager session requires an API key. Set it before starting:');
  console.warn('[auth]   export ANTHROPIC_API_KEY=sk-ant-... && node server/index.js');
  // Try to extract from shell login profile
  try {
    const { execSync } = require('node:child_process');
    const shellKey = execSync('bash -l -c "echo $ANTHROPIC_API_KEY"', { timeout: 3000 }).toString().trim();
    if (shellKey) {
      process.env.ANTHROPIC_API_KEY = shellKey;
      console.log('[auth] Found ANTHROPIC_API_KEY from shell profile.');
    }
  } catch { /* ignore */ }
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
