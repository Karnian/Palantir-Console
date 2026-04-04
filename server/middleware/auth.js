const crypto = require('node:crypto');
const { ForbiddenError } = require('../utils/errors');

/**
 * Bearer token auth middleware.
 * If PALANTIR_TOKEN env var is set, requires Authorization: Bearer <token> header.
 * If not set, auth is disabled (development convenience).
 */
function createAuthMiddleware() {
  const token = process.env.PALANTIR_TOKEN;
  const tokenBuf = token ? Buffer.from(token) : null;

  return (req, res, next) => {
    if (!tokenBuf) return next(); // auth disabled

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new ForbiddenError('Authentication required');
    }

    const provided = authHeader.slice(7);
    const providedBuf = Buffer.from(provided);

    // Timing-safe comparison to prevent timing attacks
    if (providedBuf.length !== tokenBuf.length ||
        !crypto.timingSafeEqual(providedBuf, tokenBuf)) {
      throw new ForbiddenError('Invalid token');
    }

    next();
  };
}

module.exports = { createAuthMiddleware };
