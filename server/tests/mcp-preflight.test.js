// M4-a: HTTP MCP preflight unit tests.
//
// preflightHttpMcpConfig orchestrates assertSafeUrl + bearer env lookup +
// HEAD request, then collects pass/fail per alias. Tests inject a fake
// `fetchHook` so the suite never makes real network calls — pass / 4xx /
// 5xx / timeout / connect-refused / redirect are all simulated.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  preflightHttpMcpConfig,
  preflightHttpAlias,
  collectHttpAliases,
  PASS_STATUSES,
} = require('../services/mcpPreflight');

function fakeStatus(status) {
  return async () => {
    if (PASS_STATUSES.has(status)) return { ok: true, status };
    if (status >= 500) return { ok: false, reason: 'preflight_5xx', status };
    if (status >= 400) return { ok: false, reason: 'preflight_4xx', status };
    return { ok: false, reason: 'preflight_unknown', status };
  };
}

function fakeRedirect() {
  return async () => ({ ok: false, reason: 'redirect_blocked', status: 302 });
}
function fakeTimeout() {
  return async () => ({ ok: false, reason: 'preflight_timeout' });
}
function fakeRefused() {
  return async () => ({ ok: false, reason: 'preflight_connect_refused' });
}

test('collectHttpAliases: filters stdio aliases out', () => {
  const cfg = {
    mcpServers: {
      ctx7: { command: 'npx' },
      bifrost: { url: 'http://localhost:3100/mcp' },
      another: { url: 'http://localhost:3100/mcp', bearer_token_env_var: 'TOK' },
    },
  };
  const out = collectHttpAliases(cfg);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(a => a.alias).sort(), ['another', 'bifrost']);
});

test('collectHttpAliases: returns [] for empty / null cfg', () => {
  assert.deepEqual(collectHttpAliases(null), []);
  assert.deepEqual(collectHttpAliases({}), []);
  assert.deepEqual(collectHttpAliases({ mcpServers: {} }), []);
});

test('preflight: 200 → pass', async () => {
  const r = await preflightHttpAlias({
    alias: 'a', cfg: { url: 'http://localhost:3100/mcp' },
    fetchHook: fakeStatus(200),
  });
  assert.equal(r.ok, true);
  assert.equal(r.alias, 'a');
});

test('preflight: 204 → pass', async () => {
  const r = await preflightHttpAlias({
    alias: 'a', cfg: { url: 'http://localhost:3100/mcp' },
    fetchHook: fakeStatus(204),
  });
  assert.equal(r.ok, true);
});

test('preflight: 405 → pass (method not allowed = endpoint exists)', async () => {
  const r = await preflightHttpAlias({
    alias: 'a', cfg: { url: 'http://localhost:3100/mcp' },
    fetchHook: fakeStatus(405),
  });
  assert.equal(r.ok, true);
});

test('preflight: 501 → pass (not implemented = endpoint exists)', async () => {
  const r = await preflightHttpAlias({
    alias: 'a', cfg: { url: 'http://localhost:3100/mcp' },
    fetchHook: fakeStatus(501),
  });
  assert.equal(r.ok, true);
});

test('preflight: 4xx (auth) → fail-closed reason=preflight_4xx', async () => {
  const r = await preflightHttpAlias({
    alias: 'a', cfg: { url: 'http://localhost:3100/mcp' },
    fetchHook: fakeStatus(401),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'preflight_4xx');
  assert.equal(r.status, 401);
});

test('preflight: 5xx → fail-closed reason=preflight_5xx', async () => {
  const r = await preflightHttpAlias({
    alias: 'a', cfg: { url: 'http://localhost:3100/mcp' },
    fetchHook: fakeStatus(503),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'preflight_5xx');
});

test('preflight: redirect → fail-closed reason=redirect_blocked', async () => {
  const r = await preflightHttpAlias({
    alias: 'a', cfg: { url: 'http://localhost:3100/mcp' },
    fetchHook: fakeRedirect(),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'redirect_blocked');
});

test('preflight: timeout → fail-closed reason=preflight_timeout', async () => {
  const r = await preflightHttpAlias({
    alias: 'a', cfg: { url: 'http://localhost:3100/mcp' },
    fetchHook: fakeTimeout(),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'preflight_timeout');
});

test('preflight: connect refused → fail-closed reason=preflight_connect_refused', async () => {
  const r = await preflightHttpAlias({
    alias: 'a', cfg: { url: 'http://localhost:3100/mcp' },
    fetchHook: fakeRefused(),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'preflight_connect_refused');
});

test('preflight: SSRF-blocked URL → fail-closed reason=ssrf_blocked', async () => {
  const r = await preflightHttpAlias({
    alias: 'a', cfg: { url: 'http://10.0.0.1/mcp' },
    fetchHook: fakeStatus(200),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ssrf_blocked');
});

test('preflight: bearer env missing → fail-closed reason=bearer_env_missing', async () => {
  const prev = process.env.PALANTIR_TEST_MCP_TOKEN;
  delete process.env.PALANTIR_TEST_MCP_TOKEN;
  try {
    const r = await preflightHttpAlias({
      alias: 'a',
      cfg: {
        url: 'http://localhost:3100/mcp',
        bearer_token_env_var: 'PALANTIR_TEST_MCP_TOKEN',
      },
      fetchHook: fakeStatus(200),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'bearer_env_missing');
    // Payload includes env *name* — never value.
    assert.equal(r.bearer_env, 'PALANTIR_TEST_MCP_TOKEN');
  } finally {
    if (prev !== undefined) process.env.PALANTIR_TEST_MCP_TOKEN = prev;
  }
});

test('preflight: bearer env present → token never exposed in result', async () => {
  process.env.PALANTIR_TEST_MCP_TOKEN = 'super-secret-token';
  try {
    let receivedAuth = null;
    const r = await preflightHttpAlias({
      alias: 'a',
      cfg: {
        url: 'http://localhost:3100/mcp',
        bearer_token_env_var: 'PALANTIR_TEST_MCP_TOKEN',
      },
      fetchHook: async ({ bearerValue }) => {
        receivedAuth = bearerValue;
        return { ok: true, status: 200 };
      },
    });
    assert.equal(r.ok, true);
    assert.equal(receivedAuth, 'super-secret-token', 'fetchHook receives the value');
    // Result envelope does NOT carry the token value.
    assert.equal(JSON.stringify(r).includes('super-secret-token'), false,
      'preflight result must never serialize the token value');
  } finally {
    delete process.env.PALANTIR_TEST_MCP_TOKEN;
  }
});

test('preflight: bearer env name with bad shape → bearer_env_invalid_name', async () => {
  const r = await preflightHttpAlias({
    alias: 'a',
    cfg: {
      url: 'http://localhost:3100/mcp',
      bearer_token_env_var: '1BAD_NAME', // starts with digit
    },
    fetchHook: fakeStatus(200),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bearer_env_invalid_name');
});

test('preflightHttpMcpConfig: aggregates per-alias results, surfaces failures', async () => {
  process.env.PALANTIR_TEST_MCP_TOKEN_OK = 'tok';
  try {
    let count = 0;
    const fetchHook = async () => {
      count += 1;
      return count === 1 ? { ok: true, status: 200 } : { ok: false, reason: 'preflight_5xx', status: 502 };
    };
    const out = await preflightHttpMcpConfig({
      mcpServers: {
        good: { url: 'http://localhost:3100/mcp' },
        bad:  { url: 'http://localhost:3100/mcp' },
        sk:   { command: 'npx' }, // stdio, ignored
      },
    }, { fetchHook });
    assert.equal(out.skipped, false);
    assert.equal(out.results.length, 2);
    assert.equal(out.failures.length, 1);
    assert.equal(out.failures[0].alias, 'bad');
    assert.equal(out.failures[0].reason, 'preflight_5xx');
  } finally {
    delete process.env.PALANTIR_TEST_MCP_TOKEN_OK;
  }
});

test('preflightHttpMcpConfig: skip toggle returns synthetic-pass results', async () => {
  const prev = process.env.PALANTIR_MCP_ALLOW_PREFLIGHT_SKIP;
  process.env.PALANTIR_MCP_ALLOW_PREFLIGHT_SKIP = '1';
  try {
    let called = false;
    const out = await preflightHttpMcpConfig({
      mcpServers: { a: { url: 'http://localhost:3100/mcp' } },
    }, { fetchHook: async () => { called = true; return { ok: true, status: 200 }; } });
    assert.equal(out.skipped, true);
    assert.equal(out.failures.length, 0);
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].skipped, true);
    assert.equal(called, false, 'fetchHook must not fire when skip is on');
  } finally {
    if (prev === undefined) delete process.env.PALANTIR_MCP_ALLOW_PREFLIGHT_SKIP;
    else process.env.PALANTIR_MCP_ALLOW_PREFLIGHT_SKIP = prev;
  }
});

test('preflightHttpMcpConfig: stdio-only config is a no-op', async () => {
  const out = await preflightHttpMcpConfig({
    mcpServers: { ctx7: { command: 'npx' } },
  });
  assert.deepEqual(out.results, []);
  assert.deepEqual(out.failures, []);
  assert.equal(out.skipped, false);
});

// DNS rebinding TOCTOU verification — the fetchHook receives the IP
// resolved by assertSafeUrl, so any subsequent connection attempt cannot
// re-resolve to a different (private) address. We can't trigger a real
// rebinding without DNS infrastructure, but we can prove the fetch sees
// the pinned IP from the first lookup.
test('preflight: fetchHook receives pinned IP from assertSafeUrl', async () => {
  let seenIp = null;
  const r = await preflightHttpAlias({
    alias: 'a', cfg: { url: 'http://127.0.0.1:3100/mcp' },
    fetchHook: async ({ ip, hostname }) => {
      seenIp = ip;
      assert.equal(hostname, '127.0.0.1');
      return { ok: true, status: 200 };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(seenIp, '127.0.0.1');
});

// Real-server integration: the fetchHook injection covers the
// preflightHttpAlias plumbing, but the underlying `issueHeadRequest`
// uses Node's http.Agent `lookup` hook to pin the IP. This test stands
// up a tiny http server, calls `_issueHeadRequest` directly with a
// hostname that DNS would NOT normally resolve to that server, and
// verifies the lookup hook successfully redirects the connection.
test('preflight: _issueHeadRequest pins connection via lookup hook (real http server)', async () => {
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const { _issueHeadRequest } = require('../services/mcpPreflight');
    // Call hostname `nonexistent.invalid` (which would NOT resolve via
    // real DNS) but pin to 127.0.0.1. If the lookup hook didn't apply,
    // Node would try to resolve `nonexistent.invalid` and fail with
    // ENOTFOUND. Hitting the local server proves the IP pin works.
    const r = await _issueHeadRequest({
      urlStr: `http://nonexistent.invalid:${port}/`,
      hostname: 'nonexistent.invalid',
      ip: '127.0.0.1',
      family: 4,
      port: String(port),
      bearerValue: null,
      timeoutMs: 3000,
    });
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// Authorization header forwarded to the wire when bearer is present —
// proves the resolveBearerForPreflight value reaches the actual
// request, not just the fetchHook.
test('preflight: _issueHeadRequest attaches Authorization Bearer header on real request', async () => {
  const http = require('node:http');
  let receivedAuth = null;
  const server = http.createServer((req, res) => {
    receivedAuth = req.headers.authorization || null;
    res.writeHead(204);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const { _issueHeadRequest } = require('../services/mcpPreflight');
    const r = await _issueHeadRequest({
      urlStr: `http://localhost:${port}/`,
      hostname: 'localhost',
      ip: '127.0.0.1',
      family: 4,
      port: String(port),
      bearerValue: 'wire-token',
      timeoutMs: 3000,
    });
    assert.equal(r.ok, true);
    assert.equal(receivedAuth, 'Bearer wire-token');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// Redirect → fail-closed reason=redirect_blocked on a real server.
test('preflight: _issueHeadRequest treats 302 as redirect_blocked (no follow)', async () => {
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    res.writeHead(302, { Location: 'http://10.0.0.1/private' });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const { _issueHeadRequest } = require('../services/mcpPreflight');
    const r = await _issueHeadRequest({
      urlStr: `http://localhost:${port}/`,
      hostname: 'localhost',
      ip: '127.0.0.1',
      family: 4,
      port: String(port),
      bearerValue: null,
      timeoutMs: 3000,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'redirect_blocked');
    assert.equal(r.status, 302);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
