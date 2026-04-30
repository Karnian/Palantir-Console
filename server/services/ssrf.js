// SSRF defense module for Skill Pack Gallery v1.1 Install from URL.
// Spec: docs/specs/skill-pack-gallery-v1.1.md §6.2

const dns = require('node:dns').promises;
const https = require('node:https');
const crypto = require('node:crypto');
const net = require('node:net');

// ─── Blocked IP ranges ───

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => isNaN(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) >>> 0) + ((parts[1] << 16) >>> 0) + ((parts[2] << 8) >>> 0) + parts[3];
}

function inCidrV4(ip, cidr) {
  const [net_, bits] = cidr.split('/');
  const ipInt = ipv4ToInt(ip);
  const netInt = ipv4ToInt(net_);
  if (ipInt == null || netInt == null) return false;
  const mask = bits === '32' ? 0xffffffff : (0xffffffff << (32 - Number(bits))) >>> 0;
  return (ipInt & mask) === (netInt & mask);
}

const BLOCKED_V4_CIDRS = [
  '127.0.0.0/8',      // loopback
  '10.0.0.0/8',        // RFC1918
  '172.16.0.0/12',     // RFC1918
  '192.168.0.0/16',    // RFC1918
  '169.254.0.0/16',    // link-local (incl. AWS/GCP metadata 169.254.169.254)
  '100.64.0.0/10',     // CGNAT
  '0.0.0.0/8',         // unspecified
  '255.255.255.255/32', // broadcast
];

function isBlockedIPv4(ip) {
  return BLOCKED_V4_CIDRS.some(cidr => inCidrV4(ip, cidr));
}

function isBlockedIPv6(ip) {
  const lower = ip.toLowerCase();
  // Strip zone index if any
  const addr = lower.split('%')[0];
  // Unspecified / loopback
  if (addr === '::' || addr === '::1') return true;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d)
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIPv4(mapped[1]);
  // fc00::/7 (ULA) — first byte 0xfc or 0xfd
  if (/^f[cd][0-9a-f]{2}:/.test(addr)) return true;
  // fe80::/10 (link-local) — first byte 0xfe, top 2 bits of next nibble 10
  if (/^fe[89ab][0-9a-f]:/.test(addr)) return true;
  return false;
}

function isBlockedIP(ip, family) {
  if (family === 4 || net.isIPv4(ip)) return isBlockedIPv4(ip);
  if (family === 6 || net.isIPv6(ip)) return isBlockedIPv6(ip);
  return true; // unknown family — reject
}

// ─── Blocked hostnames ───

const BLOCKED_HOSTNAME_SUFFIXES = ['.local', '.internal'];
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
]);

function isBlockedHostname(hostname) {
  const lower = hostname.toLowerCase().replace(/\.$/, ''); // strip trailing dot
  if (BLOCKED_HOSTNAMES.has(lower)) return true;
  if (BLOCKED_HOSTNAME_SUFFIXES.some(suffix => lower.endsWith(suffix))) return true;
  return false;
}

// ─── URL canonicalization ───

const SENSITIVE_PARAM_NAMES = /^(token|access_token|refresh_token|api_key|apikey|key|secret|sig|signature|password|pw)$/i;

/**
 * Canonicalize a URL per spec §6.2 Step 0a.
 * Returns { url, display } — both as strings.
 * url: full canonical URL (query included) for server-side fetch + unique index
 * display: query/fragment-stripped canonical URL for UI/logs
 * Throws BadRequestError-compatible Error on any violation.
 */
function canonicalizeUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw badRequest('URL required', 'invalid_url');
  }
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw badRequest('Invalid URL format', 'invalid_url');
  }
  if (u.protocol !== 'https:') {
    throw badRequest(`URL scheme must be https: (got ${u.protocol})`, 'invalid_scheme');
  }
  if (u.username || u.password) {
    throw badRequest('URL must not contain userinfo (username/password)', 'userinfo_forbidden');
  }
  // hostname: URL auto-lowercases + applies IDN/punycode
  let hostname = u.hostname;
  // Strip trailing dot
  if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
  if (!hostname) throw badRequest('URL hostname required', 'invalid_url');

  // Port policy: 443 only (explicit or default)
  if (u.port && u.port !== '443') {
    throw badRequest(`URL port must be 443 (got ${u.port})`, 'invalid_port');
  }

  // Build canonical URL string: always omit port (default 443 elided)
  u.hostname = hostname;
  u.port = '';
  u.hash = ''; // strip fragment
  const fullCanonical = u.toString();

  // Display URL: strip query + fragment
  const displayUrl = `${u.protocol}//${hostname}${u.pathname}`;

  return { url: fullCanonical, display: displayUrl, hostname };
}

// ─── DNS resolve + IP validation ───

async function resolveAndValidate(hostname) {
  if (isBlockedHostname(hostname)) {
    throw badRequest(`Hostname blocked by SSRF policy: ${hostname}`, 'ssrf_blocked');
  }
  // If hostname is already an IP literal, validate directly
  if (net.isIP(hostname)) {
    const family = net.isIPv6(hostname) ? 6 : 4;
    if (isBlockedIP(hostname, family)) {
      throw badRequest(`IP blocked by SSRF policy: ${hostname}`, 'ssrf_blocked');
    }
    return { address: hostname, family };
  }
  let records;
  try {
    records = await dns.lookup(hostname, { all: true, family: 0 });
  } catch (err) {
    throw badRequest(`DNS lookup failed for ${hostname}: ${err.code || err.message}`, 'dns_failed');
  }
  if (!records || records.length === 0) {
    throw badRequest(`DNS returned no records for ${hostname}`, 'dns_failed');
  }
  // All records must pass (reject if any is blocked)
  for (const r of records) {
    if (isBlockedIP(r.address, r.family)) {
      throw badRequest(`IP blocked by SSRF policy: ${r.address}`, 'ssrf_blocked');
    }
  }
  // Pin to first record
  return records[0];
}

// ─── Fetch with pinned IP ───

const MAX_RESPONSE_BYTES = 256 * 1024; // 256KB
const FETCH_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
const ALLOWED_CONTENT_TYPES = ['application/json', 'text/plain'];

/**
 * Fetch a URL with SSRF pinning + size cap + manual redirect revalidation.
 * Returns { bodyText, hash, finalUrl }
 */
async function fetchUrlSafe(rawUrl) {
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { url: canonical, hostname } = canonicalizeUrl(currentUrl);
    const pinned = await resolveAndValidate(hostname);
    const result = await doHttpsGet(canonical, hostname, pinned);
    if (result.redirect) {
      if (hop === MAX_REDIRECTS) {
        throw badRequest('Too many redirects', 'too_many_redirects');
      }
      currentUrl = result.redirect;
      continue;
    }
    return { bodyText: result.body, hash: result.hash, finalUrl: canonical };
  }
  throw badRequest('Redirect loop', 'too_many_redirects');
}

function doHttpsGet(canonicalUrl, originalHostname, pinned) {
  return new Promise((resolve, reject) => {
    const u = new URL(canonicalUrl);
    const agent = new https.Agent({
      // Force connection to pinned IP, preserving SNI and Host header.
      // Node's http.Agent passes `{ all: true }` in modern versions —
      // when `all` is true, the callback must receive an array of
      // `{address, family}`; when false/omitted, the 3-arg form
      // `(err, address, family)`. Support both.
      lookup: (_host, opts, cb) => {
        if (opts && opts.all) {
          cb(null, [{ address: pinned.address, family: pinned.family }]);
        } else {
          cb(null, pinned.address, pinned.family);
        }
      },
    });

    const req = https.request({
      agent,
      host: originalHostname,
      servername: originalHostname, // TLS SNI
      port: 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Host': originalHostname,
        'User-Agent': 'PalantirConsole-SkillPackInstaller/1.1',
      },
      timeout: FETCH_TIMEOUT_MS,
    });

    req.on('timeout', () => {
      req.destroy(badRequest('Fetch timeout (5s)', 'timeout'));
    });

    req.on('error', err => {
      // already an AppError? pass through; else wrap
      if (err.status) return reject(err);
      reject(badRequest(`Fetch failed: ${err.message}`, 'fetch_failed'));
    });

    req.on('response', res => {
      // Manual redirect handling
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // drain
        let target = res.headers.location;
        // Resolve relative URL
        try {
          target = new URL(target, canonicalUrl).toString();
        } catch {
          return reject(badRequest('Invalid redirect target', 'invalid_redirect'));
        }
        return resolve({ redirect: target });
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(badRequest(`Upstream status ${res.statusCode}`, 'upstream_error'));
      }
      // Check Content-Length if present
      const cl = res.headers['content-length'];
      if (cl && Number(cl) > MAX_RESPONSE_BYTES) {
        res.destroy();
        return reject(badRequest(`Response exceeds ${MAX_RESPONSE_BYTES} bytes (Content-Length: ${cl})`, 'too_large'));
      }
      // Content-Type check
      const ct = (res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!ALLOWED_CONTENT_TYPES.includes(ct)) {
        res.destroy();
        // Common mistake: users paste a GitHub repo page URL instead of raw JSON
        const hint = ct === 'text/html'
          ? ' (URL returned HTML — use a raw JSON URL, e.g. raw.githubusercontent.com/...)'
          : '';
        return reject(badRequest(`Content-Type not allowed: ${ct}${hint}`, 'invalid_content_type'));
      }

      const chunks = [];
      let total = 0;
      const hasher = crypto.createHash('sha256');
      res.on('data', chunk => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          res.destroy();
          return reject(badRequest(`Response exceeds ${MAX_RESPONSE_BYTES} bytes`, 'too_large'));
        }
        chunks.push(chunk);
        hasher.update(chunk);
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        const hash = hasher.digest('hex');
        resolve({ body, hash });
      });
      res.on('error', err => reject(badRequest(`Response error: ${err.message}`, 'fetch_failed')));
    });

    req.end();
  });
}

// ─── Helpers ───

function badRequest(message, code) {
  const err = new Error(message);
  err.status = 400;
  err.code = code;
  return err;
}

/**
 * Mask sensitive query parameters in a URL string (for logs/audit).
 */
function maskSensitiveParams(urlStr) {
  try {
    const u = new URL(urlStr);
    let changed = false;
    for (const key of [...u.searchParams.keys()]) {
      if (SENSITIVE_PARAM_NAMES.test(key)) {
        u.searchParams.set(key, '***');
        changed = true;
      }
    }
    return changed ? u.toString() : urlStr;
  } catch {
    return urlStr;
  }
}

// ─── M4-a: assertSafeUrl — async helper shared by mcpTemplateService validator
//     and the worker preflight (lifecycleService). Single source of truth so
//     CRUD validation and spawn-time preflight cannot diverge. Spec §L4.1.
//
// Differences from canonicalizeUrl + resolveAndValidate:
//   - http: scheme allowed (Bifrost / loopback dev). Skill Pack URL install
//     stays https-only (canonicalizeUrl), so Skill Pack call sites are
//     unchanged. MCP HTTP templates can target localhost:3100/mcp etc.
//   - localhost / 127.0.0.1 / ::1 explicit allowlist (toggled by
//     PALANTIR_MCP_ALLOW_LOCALHOST env). Default = allow.
//   - Returns { ip, family, hostname, port, url } so the caller can pin a
//     subsequent fetch's connection to the resolved IP (DNS rebinding TOCTOU
//     guard, spec §L4.1 r5).
//   - Multi-A: rejects when ANY resolved IP is private (matches existing
//     resolveAndValidate semantics — tightest of all answers wins).
//   - Fragments rejected; query strings allowed; max URL length 2KB.

const MCP_URL_MAX_BYTES = 2048;

const ALLOWLIST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

function isMcpAllowlistHostname(hostname) {
  if (!hostname) return false;
  // hostname stripped of brackets — IPv6 literal already has them removed
  // by URL parser when read via .hostname.
  return ALLOWLIST_HOSTNAMES.has(hostname.toLowerCase());
}

function mcpUrlError(message, code) {
  const err = new Error(message);
  err.status = 400;
  err.code = code || 'mcp_url_invalid';
  return err;
}

/**
 * Assert that a URL is safe to use as a streaming HTTP MCP target.
 *
 * Async because hostname resolution is async (dns.promises.lookup).
 * Returns `{ ip, family, hostname, port, url }` on success; throws a
 * 400-coded Error on any policy violation.
 *
 * Localhost allowlist:
 *   - hostname ∈ {'localhost','127.0.0.1','::1'} bypasses the private-IP
 *     check ONLY when PALANTIR_MCP_ALLOW_LOCALHOST is unset or '1' (default
 *     allow). Set to '0' to lock down.
 *   - Suffix matches like `foo.localhost` are NOT allowed — exact match only.
 *
 * Caller MUST `await` — losing the await silently makes validation a no-op.
 */
async function assertSafeUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw mcpUrlError('URL required', 'mcp_url_required');
  }
  if (Buffer.byteLength(rawUrl, 'utf8') > MCP_URL_MAX_BYTES) {
    throw mcpUrlError(`URL exceeds ${MCP_URL_MAX_BYTES} byte limit`, 'mcp_url_too_long');
  }
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw mcpUrlError('Invalid URL format', 'mcp_url_invalid');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw mcpUrlError(`URL scheme must be http: or https: (got ${u.protocol})`, 'mcp_url_scheme');
  }
  if (u.username || u.password) {
    throw mcpUrlError('URL must not contain userinfo (username/password)', 'mcp_url_userinfo');
  }
  if (u.hash) {
    throw mcpUrlError('URL fragment (#…) is not allowed', 'mcp_url_fragment');
  }
  let hostname = u.hostname;
  if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
  hostname = hostname.toLowerCase();
  if (!hostname) {
    throw mcpUrlError('URL hostname required', 'mcp_url_invalid');
  }

  const allowLocalhost = process.env.PALANTIR_MCP_ALLOW_LOCALHOST !== '0';
  const isAllowlist = allowLocalhost && isMcpAllowlistHostname(hostname);

  // IP literal short-circuit — no DNS lookup needed.
  if (net.isIP(hostname)) {
    const family = net.isIPv6(hostname) ? 6 : 4;
    if (!isAllowlist && isBlockedIP(hostname, family)) {
      throw mcpUrlError(`IP blocked by SSRF policy: ${hostname}`, 'mcp_url_blocked');
    }
    return {
      ip: hostname,
      family,
      hostname,
      port: u.port || (u.protocol === 'https:' ? '443' : '80'),
      url: u.toString(),
    };
  }

  // Hostname path. Hard-deny known internal patterns first so a localhost
  // typo like `localhost-prod.example.com` doesn't slip through the
  // exact-match allowlist.
  if (!isAllowlist && isBlockedHostname(hostname)) {
    throw mcpUrlError(`Hostname blocked by SSRF policy: ${hostname}`, 'mcp_url_blocked');
  }

  let records;
  try {
    records = await dns.lookup(hostname, { all: true, family: 0 });
  } catch (err) {
    throw mcpUrlError(`DNS lookup failed for ${hostname}: ${err.code || err.message}`, 'mcp_url_dns_failed');
  }
  if (!records || records.length === 0) {
    throw mcpUrlError(`DNS returned no records for ${hostname}`, 'mcp_url_dns_failed');
  }
  // Multi-A defense: if any address is private/blocked, reject — matches
  // resolveAndValidate semantics. Localhost allowlist is a hostname-level
  // exemption, not an IP-level one — when allowlist is true the host
  // resolved to 127.0.0.1/::1 anyway, which the IP block would catch
  // without the exemption.
  for (const r of records) {
    if (!isAllowlist && isBlockedIP(r.address, r.family)) {
      throw mcpUrlError(`IP blocked by SSRF policy: ${r.address}`, 'mcp_url_blocked');
    }
  }
  // Pin to first record. The preflight uses this to override the fetch's
  // own DNS lookup and prevent a second resolve from returning a different
  // IP (DNS rebinding TOCTOU).
  const pinned = records[0];
  return {
    ip: pinned.address,
    family: pinned.family,
    hostname,
    port: u.port || (u.protocol === 'https:' ? '443' : '80'),
    url: u.toString(),
  };
}

module.exports = {
  canonicalizeUrl,
  resolveAndValidate,
  fetchUrlSafe,
  maskSensitiveParams,
  // M4-a: shared SSRF policy entry point for MCP URL validator + preflight.
  assertSafeUrl,
  // exposed for tests
  _isBlockedIP: isBlockedIP,
  _isBlockedHostname: isBlockedHostname,
  _inCidrV4: inCidrV4,
  MAX_RESPONSE_BYTES,
  MCP_URL_MAX_BYTES,
};
