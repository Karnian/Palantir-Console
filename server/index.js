const { createApp } = require('./app');

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
