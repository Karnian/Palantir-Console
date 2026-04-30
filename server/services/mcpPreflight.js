// M4-a §L6: HTTP MCP preflight healthcheck.
//
// stdio MCP spawns the server process — failure surfaces as a normal child
// exit and lifecycleService catches it. HTTP MCP just hands a URL to Codex
// CLI; if the endpoint is dead the worker silently spawns and starts
// failing tool calls deep into the run. Preflight closes that gap by
// hitting the URL with a HEAD request right before the worker spawn.
//
// Policy (from spec §L6):
//   - Method: HEAD only. No OPTIONS fallback (avoids per-endpoint guesses).
//   - Pass: status ∈ {200, 204, 405, 501}. 405/501 means "endpoint exists,
//     just doesn't implement HEAD" — same signal as a 200 for our purposes.
//   - Timeout: 3s. preflight_timeout reason on miss.
//   - Redirect: manual. 3xx → fail-closed reason="redirect_blocked"
//     (prevents redirect-to-private bypass).
//   - Authorization: when cfg has `bearer_token_env_var`, look up the
//     value via authResolver.resolveBearerForPreflight and attach
//     `Authorization: Bearer <value>`. Missing env var = fail-closed
//     reason="bearer_env_missing".
//   - DNS rebinding (TOCTOU): assertSafeUrl returns the resolved IP; the
//     HEAD request uses an Agent with a custom `lookup` hook that returns
//     that exact IP, so fetch never does its own DNS resolution. Host
//     header + TLS SNI stay as the original hostname (virtual hosting).
//   - Skip: `PALANTIR_MCP_ALLOW_PREFLIGHT_SKIP=1` env disables preflight
//     entirely (debug toggle).
//
// On failure the caller (lifecycleService) emits `preset:mcp_unreachable`
// and marks the run failed. Payload shape (no env values):
//   { alias, url, reason, status?, ip? }
// where reason ∈ {
//   'preflight_timeout', 'preflight_4xx', 'preflight_5xx',
//   'preflight_connect_refused', 'redirect_blocked',
//   'bearer_env_missing', 'ssrf_blocked',
// }.

const http = require('node:http');
const https = require('node:https');

const { assertSafeUrl } = require('./ssrf');
const { resolveBearerForPreflight } = require('./authResolver');

const PREFLIGHT_TIMEOUT_MS = 3000;
const PASS_STATUSES = new Set([200, 204, 405, 501]);

function isPreflightSkipped() {
  return process.env.PALANTIR_MCP_ALLOW_PREFLIGHT_SKIP === '1';
}

/**
 * @typedef {object} HttpMcpAlias
 * @property {string} alias
 * @property {object} cfg
 *   - cfg.url required
 *   - cfg.bearer_token_env_var optional
 */

/**
 * Walk a merged MCP config object and return only the http-transport
 * aliases (cfg has `url`). Aliases without `url` are stdio (or
 * misconfigured — flatten will catch the bad ones later).
 */
function collectHttpAliases(mcpConfig) {
  const out = [];
  if (!mcpConfig || typeof mcpConfig !== 'object') return out;
  const servers = mcpConfig.mcpServers;
  if (!servers || typeof servers !== 'object') return out;
  for (const [alias, cfg] of Object.entries(servers)) {
    if (cfg && typeof cfg === 'object' && typeof cfg.url === 'string' && cfg.url) {
      out.push({ alias, cfg });
    }
  }
  return out;
}

/**
 * Issue ONE HEAD request with the SSRF-validated IP pinned. Returns
 * `{ ok: true, status }` or `{ ok: false, reason, status?, ip? }`.
 *
 * Internal — exported only for tests.
 */
function issueHeadRequest({ urlStr, hostname, ip, family, port, bearerValue, timeoutMs }) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(urlStr); } catch {
      resolve({ ok: false, reason: 'invalid_url' });
      return;
    }
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    const headers = {
      Host: hostname,
      'User-Agent': 'PalantirConsole-McpPreflight/1.0',
      Accept: '*/*',
    };
    if (bearerValue) {
      headers.Authorization = `Bearer ${bearerValue}`;
    }
    const reqOpts = {
      method: 'HEAD',
      host: hostname,
      port: Number(port) || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers,
      timeout: timeoutMs,
      // DNS rebinding TOCTOU guard — pin lookup to the IP assertSafeUrl
      // already validated. If undici / Node decides to retry resolution,
      // it'll keep getting the same answer.
      lookup: (host, opts, cb) => {
        if (opts && opts.all) cb(null, [{ address: ip, family }]);
        else cb(null, ip, family);
      },
    };
    if (isHttps) reqOpts.servername = hostname;

    const req = transport.request(reqOpts, (res) => {
      // Drain so the socket is released cleanly.
      res.resume();
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400) {
        resolve({ ok: false, reason: 'redirect_blocked', status, ip });
        return;
      }
      if (PASS_STATUSES.has(status)) {
        resolve({ ok: true, status });
        return;
      }
      if (status === 401 || status === 403) {
        // Auth-related failures bubble up as preflight_4xx with the
        // status — operator sees `auth required` vs `not implemented`
        // (405/501) without us overinterpreting.
        resolve({ ok: false, reason: 'preflight_4xx', status, ip });
        return;
      }
      if (status >= 400 && status < 500) {
        resolve({ ok: false, reason: 'preflight_4xx', status, ip });
        return;
      }
      if (status >= 500) {
        resolve({ ok: false, reason: 'preflight_5xx', status, ip });
        return;
      }
      // Unknown / 0 status — treat as connect failure.
      resolve({ ok: false, reason: 'preflight_unknown', status, ip });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, reason: 'preflight_timeout', ip });
    });
    req.on('error', (err) => {
      const code = err && err.code;
      if (code === 'ECONNREFUSED') {
        resolve({ ok: false, reason: 'preflight_connect_refused', ip });
      } else if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
        resolve({ ok: false, reason: 'preflight_timeout', ip });
      } else {
        resolve({ ok: false, reason: 'preflight_network_error', ip, errCode: code || null });
      }
    });

    req.end();
  });
}

/**
 * Preflight a single http MCP alias.
 *
 * Returns:
 *   { ok: true,  alias, url }
 *   { ok: false, alias, url, reason, status?, ip? }
 *
 * `url` echoed back is the canonical form returned by assertSafeUrl (so
 * callers logging on failure see the same URL Codex will dial).
 */
async function preflightHttpAlias({ alias, cfg, fetchHook }) {
  const rawUrl = cfg.url;
  // 1. SSRF + DNS resolve (returns canonical URL + pinned IP).
  let resolved;
  try {
    resolved = await assertSafeUrl(rawUrl);
  } catch (err) {
    return {
      ok: false,
      alias,
      url: rawUrl,
      reason: 'ssrf_blocked',
      message: err.message,
    };
  }

  // 2. Bearer token lookup (if template has bearer_token_env_var).
  let bearerValue = null;
  let bearerEnvKey = null;
  if (cfg.bearer_token_env_var) {
    bearerEnvKey = cfg.bearer_token_env_var;
    const lookup = resolveBearerForPreflight(cfg.bearer_token_env_var);
    if (!lookup.ok) {
      return {
        ok: false,
        alias,
        url: resolved.url,
        reason: lookup.reason === 'invalid_name' ? 'bearer_env_invalid_name' : 'bearer_env_missing',
        bearer_env: cfg.bearer_token_env_var,
      };
    }
    bearerValue = lookup.value;
  }

  // 3. HEAD request, IP-pinned. fetchHook lets tests inject a fake
  //    transport. Default uses the real http(s) module via issueHeadRequest.
  const issue = typeof fetchHook === 'function' ? fetchHook : issueHeadRequest;
  const result = await issue({
    urlStr: resolved.url,
    hostname: resolved.hostname,
    ip: resolved.ip,
    family: resolved.family,
    port: resolved.port,
    bearerValue,
    timeoutMs: PREFLIGHT_TIMEOUT_MS,
  });

  if (result.ok) {
    return { ok: true, alias, url: resolved.url };
  }
  return {
    ok: false,
    alias,
    url: resolved.url,
    reason: result.reason,
    status: result.status,
    ip: resolved.ip,
    ...(bearerEnvKey ? { bearer_env: bearerEnvKey } : {}),
  };
}

/**
 * Preflight every http alias in an mcp config object. Returns a list of
 * results — caller decides how to react (lifecycleService emits a
 * `preset:mcp_unreachable` event per failure and aborts the spawn).
 *
 * Skip handling: when `PALANTIR_MCP_ALLOW_PREFLIGHT_SKIP=1`, returns an
 * empty `failures` list with `skipped: true` for every http alias so the
 * caller can audit-log without firing off requests.
 */
async function preflightHttpMcpConfig(mcpConfig, { fetchHook } = {}) {
  const aliases = collectHttpAliases(mcpConfig);
  if (aliases.length === 0) return { results: [], failures: [], skipped: false };
  if (isPreflightSkipped()) {
    return {
      results: aliases.map(a => ({ ok: true, alias: a.alias, url: a.cfg.url, skipped: true })),
      failures: [],
      skipped: true,
    };
  }
  const results = [];
  const failures = [];
  // Run sequentially — n is small (1~2 aliases per template policy in spec
  // §3.1) and parallel preflights would just multiply the worker spawn
  // latency cost without changing the worst-case 3s timeout per alias.
  for (const { alias, cfg } of aliases) {
    const r = await preflightHttpAlias({ alias, cfg, fetchHook });
    results.push(r);
    if (!r.ok) failures.push(r);
  }
  return { results, failures, skipped: false };
}

module.exports = {
  preflightHttpMcpConfig,
  preflightHttpAlias,
  collectHttpAliases,
  // exposed for tests
  _issueHeadRequest: issueHeadRequest,
  PREFLIGHT_TIMEOUT_MS,
  PASS_STATUSES,
};
