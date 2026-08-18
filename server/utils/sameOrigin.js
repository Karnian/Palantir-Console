'use strict';

const { ForbiddenError } = require('./errors');

// NOTE: this is a same-HOST check, not a strict same-origin one -- it does not
// compare scheme, and a missing Origin header is allowed (non-browser clients).
// That is the policy inherited from modelPolicies; tightening it is a separate
// change that would affect both call sites.
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
