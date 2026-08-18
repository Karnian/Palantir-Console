'use strict';

const { ForbiddenError } = require('./errors');

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;

  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ForbiddenError('cross-origin write blocked');
  }

  const requestHost = req.headers.host;
  if (!requestHost || originHost.toLowerCase() !== String(requestHost).toLowerCase()) {
    throw new ForbiddenError('cross-origin write blocked');
  }
}

module.exports = { assertSameOrigin };
