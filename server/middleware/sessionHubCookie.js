'use strict';
function chatError(res, code, status = 403) {
  return res.status(status).json({ error: code, reason: code });
}
function requireSessionHubCookie(req, res, next) {
    res.set('Cache-Control', 'no-store');
    if (req.auth?.method !== 'cookie') return chatError(res, 'forbidden');
    if (req.method === 'POST' || req.method === 'DELETE') {
      const origin = req.headers.origin;
      const scheme = req.socket.encrypted ? 'https' : 'http';
      // Compare the serialized origin exactly. Neither proxy headers nor Referer grant access.
      if (typeof origin !== 'string' || origin !== `${scheme}://${req.headers.host}`) {
        return chatError(res, 'forbidden');
      }
    } else if (req.method === 'GET') {
      const site = req.headers['sec-fetch-site'];
      if (site !== undefined && site !== 'same-origin' && site !== 'none') return chatError(res, 'forbidden');
    } else return chatError(res, 'not_found', 404);
    return next();
}

module.exports = { requireSessionHubCookie };
