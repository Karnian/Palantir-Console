const { createApp } = require('./app');
const { bootstrapClaudeAuthFromEnv } = require('./services/authResolver');

// PR2: Claude auth bootstrap now lives in authResolver. The behavior is
// identical: if running inside a Claude Code session, persist credentials to
// .claude-auth.json; otherwise load them back into process.env.
bootstrapClaudeAuthFromEnv();

const port = process.env.PORT || 4177;
const app = createApp();

// Always bind to 0.0.0.0 for remote access
const hasAuth = Boolean(process.env.PALANTIR_TOKEN);
const host = '0.0.0.0';

if (!hasAuth) {
  console.warn('[security] WARNING: No PALANTIR_TOKEN set — auth disabled, open to all network access.');
  console.warn('[security] Set PALANTIR_TOKEN env var to require authentication.');
}

app.listen(port, host, () => {
  console.log(`Palantir Console running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
});
