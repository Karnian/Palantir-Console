const express = require('express');
const { timingSafeEqualStr } = require('../middleware/auth');

/**
 * POST /api/auth/login
 *   body: { token: string }
 *   → 204 + Set-Cookie palantir_token=<token>; HttpOnly; SameSite=Lax; Path=/
 *
 * POST /api/auth/logout
 *   → 204 + Set-Cookie palantir_token=; Max-Age=0
 *
 * These endpoints are intentionally NOT gated by the main auth middleware —
 * /api/auth is mounted BEFORE /api auth in app.js. Login performs its own
 * timing-safe comparison against PALANTIR_TOKEN. If no token is configured,
 * the endpoint 404s (there is nothing to log into).
 */
function createAuthRouter({ token = process.env.PALANTIR_TOKEN } = {}) {
  const router = express.Router();

  router.post('/login', (req, res) => {
    const configured = token;
    if (!configured) {
      return res.status(404).json({ error: 'Auth not configured on this server' });
    }
    const provided = typeof req.body?.token === 'string' ? req.body.token : '';
    if (!timingSafeEqualStr(provided, configured)) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    // SameSite=Lax is enough here: SSE / XHR are same-origin, and we never
    // want the cookie on cross-site navigations. Secure flag is NOT set
    // because the console is typically served over plain http on LAN; a
    // proxy that terminates TLS can layer Secure on top.
    const cookie = [
      `palantir_token=${encodeURIComponent(configured)}`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      'Max-Age=2592000', // 30d
    ].join('; ');
    res.setHeader('Set-Cookie', cookie);
    res.status(204).end();
  });

  router.post('/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'palantir_token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    res.status(204).end();
  });

  return router;
}

module.exports = { createAuthRouter };
