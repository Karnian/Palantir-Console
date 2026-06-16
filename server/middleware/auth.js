const crypto = require('node:crypto');
const { ForbiddenError } = require('../utils/errors');

/**
 * Bearer token auth middleware.
 * If PALANTIR_TOKEN env var is set, requires either:
 *   - Authorization: Bearer <token> header (for CLI / server-to-server), OR
 *   - palantir_token=<token> cookie (for browsers, including EventSource SSE)
 *
 * The cookie path exists because browser EventSource cannot send custom
 * headers — without it, enabling PALANTIR_TOKEN structurally breaks the
 * /api/events SSE stream (Codex-discovered regression NEW-S1). The cookie is
 * set by POST /api/auth/login after a one-time token exchange, and by the
 * tiny /login.html bootstrap page.
 *
 * Both paths use timing-safe comparison.
 *
 * If PALANTIR_TOKEN is not set, auth is disabled entirely (development
 * convenience). `server/index.js` gates the 0.0.0.0 bind on this flag so
 * unauthenticated mode cannot listen on a public interface by accident.
 */
function parseCookies(header) {
  // Minimal cookie parser — we only care about palantir_token, and adding
  // cookie-parser as a dependency for one field isn't worth it. Lenient on
  // whitespace, intolerant of malformed pairs (safer to ignore than guess).
  const out = Object.create(null);
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function createAuthMiddleware({ token = process.env.PALANTIR_TOKEN, pmToken = process.env.PALANTIR_PM_TOKEN } = {}) {
  return (req, res, next) => {
    // req.auth.method records HOW the caller authenticated so routes can make
    // actor decisions (ML R4: cookie=human→active vs bearer=PM/CLI→candidate).
    //
    // Actor split & spoofing: when a distinct PALANTIR_PM_TOKEN is configured,
    // the PM/CLI authenticates with it as bearer and CANNOT present the human
    // cookie (which only matches PALANTIR_TOKEN) — that's the spoof-proof path,
    // PROVIDED the PM is given only PALANTIR_PM_TOKEN. Without a separate PM
    // token the bearer/cookie split falls back to the shared PALANTIR_TOKEN and
    // is a best-effort actor hint, NOT a security boundary (a token holder can
    // present either form). See routes/memory.js R4 + docs.
    if (!token) { req.auth = { method: 'none' }; return next(); } // auth disabled

    // Precedence: Bearer header is evaluated FIRST, and a present-but-
    // invalid Bearer header is treated as an explicit auth failure —
    // we do NOT fall through to the cookie path in that case. Rationale:
    //   - CLI callers / server-to-server clients use the header path and
    //     a wrong value is almost always a configuration bug they want
    //     to hear about loudly, not a silent fallback to whatever cookie
    //     happens to be in the jar.
    //   - Mixing header + cookie and allowing either to succeed is a
    //     classic request-smuggling foothold.
    // Browsers never send Authorization unless the app adds it (which we
    // no longer do post-PR1), so this policy doesn't affect the SPA.
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const presented = authHeader.slice(7);
      // A separate PM token (if set) is bearer-only and never matches the human
      // cookie path below, so a PM holding only it cannot spoof a human write.
      if (pmToken && timingSafeEqualStr(presented, pmToken)) { req.auth = { method: 'bearer' }; return next(); }
      if (timingSafeEqualStr(presented, token)) { req.auth = { method: 'bearer' }; return next(); }
      throw new ForbiddenError('Invalid token');
    }

    // Cookie path (browser — required for EventSource SSE since it cannot
    // send custom headers). Set by POST /api/auth/login, never by the
    // server automatically. Only the human PALANTIR_TOKEN authenticates here;
    // a PM token presented as a cookie does NOT (keeps the human path distinct).
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.palantir_token && timingSafeEqualStr(cookies.palantir_token, token)) {
      req.auth = { method: 'cookie' };
      return next();
    }

    throw new ForbiddenError('Authentication required');
  };
}

module.exports = { createAuthMiddleware, parseCookies, timingSafeEqualStr };
