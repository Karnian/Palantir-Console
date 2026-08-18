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

function workerProposalRunId(req) {
  const rawPath = String(req.originalUrl || req.url || '').split('?')[0];
  const match = /^\/api\/runs\/([^/]+)\/memory\/propose\/?$/.exec(rawPath);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

function workerQuestionRunId(req) {
  const rawPath = String(req.originalUrl || '').split('?')[0];
  const method = String(req.method || '').toUpperCase();
  let match = null;
  if (method === 'POST') {
    match = /^\/api\/runs\/([^/]+)\/questions\/?$/.exec(rawPath);
  } else if (method === 'GET') {
    match = /^\/api\/runs\/([^/]+)\/questions\/[^/]+\/wait\/?$/.exec(rawPath);
  }
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

function conversationMessageTarget(rawPath) {
  const match = /^\/api\/conversations\/([^/]+)\/message\/?$/.exec(rawPath);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

function managerCapabilityRequestAllowed(req, grant = null) {
  const rawPath = String(req.originalUrl || req.url || '').split('?')[0];
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET') {
    return /^\/api\/(?:runs(?:\/[^/]+(?:\/(?:events|output))?)?|tasks(?:\/[^/]+)?|projects(?:\/[^/]+\/(?:tasks|memory|skill-packs))?|agents|skill-packs|operator\/profiles|conversations\/[^/]+\/events)\/?$/.test(rawPath)
      || (
        grant?.layer !== 'top'
        && /^\/api\/verify-checks(?:\/[^/]+)?\/?$/.test(rawPath)
      );
  }
  if (method === 'POST') {
    const conversationTarget = conversationMessageTarget(rawPath);
    if (
      grant?.layer === 'top'
      && (
        rawPath === '/api/dispatch-audit'
        || /^\/api\/runs\/[^/]+\/(?:input|cancel)\/?$/.test(rawPath)
        // `/api/conversations/worker:<runId>/message` is an alias for worker
        // input. Apply the same Top-layer intervention restriction to both
        // literal and percent-encoded conversation ids.
        || conversationTarget?.startsWith('worker:')
      )
    ) {
      return false;
    }
    return rawPath === '/api/tasks'
      || rawPath === '/api/dispatch-audit'
      || (
        grant?.layer !== 'top'
        && (
          rawPath === '/api/verify-checks'
          || rawPath === '/api/verify-checks/assign'
        )
      )
      || /^\/api\/tasks\/[^/]+\/execute\/?$/.test(rawPath)
      || /^\/api\/runs\/[^/]+\/(?:input|cancel)\/?$/.test(rawPath)
      || /^\/api\/conversations\/[^/]+\/(?:message|memory\/propose)\/?$/.test(rawPath)
      || rawPath === '/api/operator/specialist';
  }
  if (method === 'PATCH') {
    // `/reorder` is declared before `/:id` in routes/tasks.js, so a request the
    // router resolves to that literal segment reaches the reorder handler —
    // which rewrites sort_order for arbitrary task ids with no project scoping.
    // Express matches literal routes case-insensitively by default, so
    // `/api/tasks/REORDER` reaches it: lowercasing is what actually closes the
    // bypass. Decoding first is belt-and-braces — Express does NOT percent-decode
    // before matching a literal route (`%72eorder` resolves to `/:id`), and
    // refusing that form too costs nothing because no real task id decodes to
    // "reorder". An undecodable segment is refused rather than passed through.
    const taskSegment = /^\/api\/tasks\/([^/]+)\/?$/.exec(rawPath);
    if (taskSegment) {
      let decoded;
      try { decoded = decodeURIComponent(taskSegment[1]); } catch { return false; }
      if (decoded.toLowerCase() === 'reorder') return false;
    }
    return /^\/api\/tasks\/[^/]+(?:\/status)?\/?$/.test(rawPath)
      || (
        grant?.layer !== 'top'
        && /^\/api\/verify-checks\/[^/]+\/?$/.test(rawPath)
      );
  }
  if (method === 'DELETE') {
    return /^\/api\/tasks\/[^/]+\/?$/.test(rawPath)
      || (
        grant?.layer !== 'top'
        && /^\/api\/verify-checks\/[^/]+\/?$/.test(rawPath)
      );
  }
  return false;
}

function createAuthMiddleware({
  token = process.env.PALANTIR_TOKEN,
  pmToken = process.env.PALANTIR_PM_TOKEN,
  workerProposalTokenService = null,
  managerCapabilityTokenService = null,
  isManagerCapabilityActive = null,
} = {}) {
  return (req, res, next) => {
    // req.auth.method records HOW the caller authenticated so routes can make
    // actor decisions (ML R4: cookie=human→active vs bearer=PM/CLI→candidate).
    //
    // Managers use a boot-local, run-bound capability and are represented as
    // bearer actors so memory writes remain candidate-only. PALANTIR_PM_TOKEN
    // is retained only for trusted external bearer automation. A human holding
    // PALANTIR_TOKEN can still present it as bearer intentionally; cookie auth
    // is the sole human-review authority. See routes/memory.js R4 + docs.
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
      const managerGrant = managerCapabilityTokenService
        && typeof managerCapabilityTokenService.verify === 'function'
        ? managerCapabilityTokenService.verify(presented)
        : null;
      if (managerGrant) {
        const active = typeof isManagerCapabilityActive === 'function'
          && isManagerCapabilityActive(managerGrant);
        if (!active) {
          throw new ForbiddenError('Manager capability is no longer active');
        }
        if (!managerCapabilityRequestAllowed(req, managerGrant)) {
          throw new ForbiddenError('Manager capability is limited to orchestration endpoints');
        }
        // Keep method='bearer' for existing route actor semantics: manager
        // memory writes are proposals, never human-active writes.
        req.auth = {
          method: 'bearer',
          actor: 'manager',
          managerRunId: managerGrant.runId,
          conversationId: managerGrant.conversationId,
          layer: managerGrant.layer,
        };
        return next();
      }
      const workerGrant = workerProposalTokenService
        && typeof workerProposalTokenService.verify === 'function'
        ? workerProposalTokenService.verify(presented)
        : null;
      if (workerGrant) {
        const pathRunId = workerProposalRunId(req);
        const questionRunId = workerQuestionRunId(req);
        const memoryProposalAllowed = req.method === 'POST' && pathRunId === workerGrant.runId;
        const workerQuestionAllowed = questionRunId === workerGrant.runId;
        if (!memoryProposalAllowed && !workerQuestionAllowed) {
          throw new ForbiddenError('Worker token is limited to its memory proposal endpoint');
        }
        req.auth = {
          method: 'worker',
          runId: workerGrant.runId,
          projectId: workerGrant.projectId || null,
        };
        return next();
      }
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

module.exports = {
  createAuthMiddleware,
  parseCookies,
  timingSafeEqualStr,
  workerProposalRunId,
  workerQuestionRunId,
  managerCapabilityRequestAllowed,
};
