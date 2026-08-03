// PR1 / NEW-S1 + P0-1: auth middleware + /api/auth/login cookie flow.
//
// The regression that motivated this suite: browser EventSource cannot send
// custom headers, so enabling PALANTIR_TOKEN used to break /api/events SSE
// structurally. After this PR the middleware accepts either a Bearer header
// (CLI / tests) or a `palantir_token` cookie set via POST /api/auth/login.
// CSP is also asserted here because it migrated off cdn.jsdelivr.net in the
// same patch (P0-1).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');
const { createApp } = require('../app');
const {
  parseCookies,
  createAuthMiddleware,
  managerCapabilityRequestAllowed,
} = require('../middleware/auth');
const {
  createWorkerProposalTokenService,
  createManagerCapabilityTokenService,
  resolveActorTokenPolicy,
} = require('../services/actorTokenPolicy');

async function createTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createTestApp(t, { token, pmToken, agentProcessIsolation = false } = {}) {
  // IMPORTANT: never mutate process.env.PALANTIR_TOKEN here. node --test
  // runs test files in parallel workers by default, so any env mutation
  // leaks into sibling files (e.g. v2-api.test.js suddenly starts seeing
  // auth enabled mid-flight and every request returns 403, which hangs
  // the whole run). createApp accepts an `authToken` option for exactly
  // this reason — threading the value as an option keeps the test
  // hermetic.
  const storageRoot = await createTempDir('palantir-storage-');
  const fsRoot = await createTempDir('palantir-fs-');
  const dbPath = path.join(await createTempDir('palantir-db-'), 'test.db');
  const app = createApp({
    storageRoot,
    fsRoot,
    dbPath,
    authToken: token || null, // explicit null → disabled, non-empty string → enabled
    pmToken: pmToken || null,
    agentProcessIsolation,
    authResolverOpts: { hasKeychain: () => false },
  });

  t.after(async () => {
    if (app.shutdown) app.shutdown();
    else app.closeDb();
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
    await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  });

  return app;
}

// ---- CSP header (P0-1) ----

test('CSP header no longer references cdn.jsdelivr.net', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
  const csp = res.headers['content-security-policy'];
  assert.ok(csp, 'CSP header should be present');
  assert.ok(!csp.includes('cdn.jsdelivr.net'), `CSP still references jsdelivr: ${csp}`);
  assert.match(csp, /script-src 'self'(;|$| )/);
  assert.match(csp, /connect-src 'self'(;|$| )/);
});

// ---- Token disabled: open mode ----

test('no PALANTIR_TOKEN → /api/tasks is reachable without auth', async (t) => {
  const app = await createTestApp(t); // no token
  const res = await request(app).get('/api/tasks');
  assert.equal(res.status, 200);
});

test('createApp snapshots accessor-backed actor tokens for auth and capabilities', async (t) => {
  const storageRoot = await createTempDir('palantir-storage-');
  const fsRoot = await createTempDir('palantir-fs-');
  const dbPath = path.join(await createTempDir('palantir-db-'), 'test.db');
  let authReads = 0;
  let pmReads = 0;
  const options = {
    storageRoot,
    fsRoot,
    dbPath,
    agentProcessIsolation: true,
    authResolverOpts: { hasKeychain: () => false },
  };
  Object.defineProperties(options, {
    authToken: {
      enumerable: true,
      get() {
        authReads += 1;
        return authReads === 1 ? undefined : 'late-token';
      },
    },
    pmToken: {
      enumerable: true,
      get() {
        pmReads += 1;
        return pmReads === 1 ? undefined : 'late-pm-token';
      },
    },
  });
  const previousAuthToken = process.env.PALANTIR_TOKEN;
  const previousPmToken = process.env.PALANTIR_PM_TOKEN;
  delete process.env.PALANTIR_TOKEN;
  delete process.env.PALANTIR_PM_TOKEN;
  let app;
  try {
    app = createApp(options);
  } finally {
    if (previousAuthToken === undefined) delete process.env.PALANTIR_TOKEN;
    else process.env.PALANTIR_TOKEN = previousAuthToken;
    if (previousPmToken === undefined) delete process.env.PALANTIR_PM_TOKEN;
    else process.env.PALANTIR_PM_TOKEN = previousPmToken;
  }
  t.after(async () => {
    await app.shutdown();
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
    await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  });

  const status = await request(app).get('/api/memory/status').expect(200);
  const workerGrant = app.services.workerProposalTokenService.mint(
    'run_worker',
    { projectId: 'project_one' },
  );

  assert.deepEqual({
    authReads,
    pmReads,
    middlewareAuthMethod: status.body.approval.actor,
    policyBoundary: status.body.approval.actor_boundary,
    capabilitiesEnabled: workerGrant !== null,
    workerGrantMinted: workerGrant !== null,
  }, {
    authReads: 1,
    pmReads: 1,
    middlewareAuthMethod: 'none',
    policyBoundary: 'auth_disabled',
    capabilitiesEnabled: false,
    workerGrantMinted: false,
  });
});

test('createApp snapshots env fallback tokens across unrelated option getters', async (t) => {
  const storageRoot = await createTempDir('palantir-storage-');
  const fsRoot = await createTempDir('palantir-fs-');
  const dbPath = path.join(await createTempDir('palantir-db-'), 'test.db');
  const options = {
    storageRoot,
    fsRoot,
    dbPath,
    authResolverOpts: { hasKeychain: () => false },
  };
  Object.defineProperties(options, {
    agentProcessIsolation: {
      enumerable: true,
      get() {
        process.env.PALANTIR_TOKEN = 'late-token';
        return true;
      },
    },
    workerProposalBaseUrl: {
      enumerable: true,
      get() {
        delete process.env.PALANTIR_TOKEN;
        return undefined;
      },
    },
  });
  const previousAuthToken = process.env.PALANTIR_TOKEN;
  const previousPmToken = process.env.PALANTIR_PM_TOKEN;
  delete process.env.PALANTIR_TOKEN;
  delete process.env.PALANTIR_PM_TOKEN;
  let app;
  try {
    app = createApp(options);
  } finally {
    if (previousAuthToken === undefined) delete process.env.PALANTIR_TOKEN;
    else process.env.PALANTIR_TOKEN = previousAuthToken;
    if (previousPmToken === undefined) delete process.env.PALANTIR_PM_TOKEN;
    else process.env.PALANTIR_PM_TOKEN = previousPmToken;
  }
  t.after(async () => {
    await app.shutdown();
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
    await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  });

  const status = await request(app).get('/api/memory/status');
  const workerGrant = app.services.workerProposalTokenService.mint(
    'run_worker',
    { projectId: 'project_one' },
  );

  assert.deepEqual({
    status: status.status,
    middlewareAuthMethod: status.body.approval.actor,
    policyBoundary: status.body.approval.actor_boundary,
    capabilitiesEnabled: workerGrant !== null,
    workerGrantMinted: workerGrant !== null,
  }, {
    status: 200,
    middlewareAuthMethod: 'none',
    policyBoundary: 'auth_disabled',
    capabilitiesEnabled: false,
    workerGrantMinted: false,
  });
});

// ---- Bearer header path (existing CLI behavior) ----

test('PALANTIR_TOKEN set → Bearer header allows /api/tasks', async (t) => {
  const app = await createTestApp(t, { token: 'secret-A' });
  const res = await request(app).get('/api/tasks').set('Authorization', 'Bearer secret-A');
  assert.equal(res.status, 200);
});

test('PALANTIR_TOKEN set → wrong Bearer rejected', async (t) => {
  const app = await createTestApp(t, { token: 'secret-B' });
  const res = await request(app).get('/api/tasks').set('Authorization', 'Bearer wrong');
  assert.equal(res.status, 403);
});

test('PALANTIR_TOKEN set → no credentials rejected', async (t) => {
  const app = await createTestApp(t, { token: 'secret-C' });
  const res = await request(app).get('/api/tasks');
  assert.equal(res.status, 403);
});

// ---- Cookie path (NEW-S1 fix — browser SSE) ----

test('POST /api/auth/login sets palantir_token cookie and subsequent calls work', async (t) => {
  const app = await createTestApp(t, { token: 'secret-D' });

  // Login (no auth header — login endpoint is exempt from the global auth).
  const login = await request(app)
    .post('/api/auth/login')
    .send({ token: 'secret-D' });
  assert.equal(login.status, 204);
  const setCookie = login.headers['set-cookie'];
  assert.ok(setCookie && setCookie[0], 'Set-Cookie missing');
  assert.match(setCookie[0], /palantir_token=/);
  assert.match(setCookie[0], /HttpOnly/);
  assert.match(setCookie[0], /SameSite=Lax/);
  assert.match(setCookie[0], /Path=\//);

  // Extract just the cookie k=v pair for the next request.
  const cookiePair = setCookie[0].split(';')[0];
  const res = await request(app).get('/api/tasks').set('Cookie', cookiePair);
  assert.equal(res.status, 200);
});

test('POST /api/auth/login wrong token → 403', async (t) => {
  const app = await createTestApp(t, { token: 'secret-E' });
  const res = await request(app).post('/api/auth/login').send({ token: 'nope' });
  assert.equal(res.status, 403);
});

test('POST /api/auth/login 404s when no PALANTIR_TOKEN configured', async (t) => {
  const app = await createTestApp(t); // no token
  const res = await request(app).post('/api/auth/login').send({ token: 'anything' });
  assert.equal(res.status, 404);
});

test('Fake cookie value rejected (timing-safe compare still holds)', async (t) => {
  const app = await createTestApp(t, { token: 'secret-F' });
  const res = await request(app)
    .get('/api/tasks')
    .set('Cookie', 'palantir_token=not-the-right-one');
  assert.equal(res.status, 403);
});

test('Logout clears cookie', async (t) => {
  const app = await createTestApp(t, { token: 'secret-G' });
  const res = await request(app).post('/api/auth/logout');
  assert.equal(res.status, 204);
  assert.match(res.headers['set-cookie'][0], /Max-Age=0/);
});

// ---- SSE connection (the actual regression NEW-S1 was about) ----
// Using raw request lifecycle because supertest's streaming is awkward.

test('SSE /api/events opens with cookie auth', async (t) => {
  const app = await createTestApp(t, { token: 'secret-H' });

  const login = await request(app).post('/api/auth/login').send({ token: 'secret-H' });
  const cookiePair = login.headers['set-cookie'][0].split(';')[0];

  // Open a real HTTP connection to the app — supertest's .parse is not
  // friendly to event-stream bodies. We just assert status + content-type
  // and hang up immediately.
  const http = require('node:http');
  await new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const req = http.get({
        host: '127.0.0.1',
        port,
        path: '/api/events',
        headers: { Cookie: cookiePair, Accept: 'text/event-stream' },
      }, (res) => {
        try {
          assert.equal(res.statusCode, 200);
          assert.match(res.headers['content-type'], /text\/event-stream/);
          req.destroy();
          res.destroy();
          server.close(() => resolve());
        } catch (err) {
          req.destroy();
          res.destroy();
          server.close(() => reject(err));
        }
      });
      req.on('error', (err) => {
        // 'socket hang up' after destroy is expected.
        if (String(err.message).match(/hang up|aborted|ECONNRESET/i)) return;
        server.close(() => reject(err));
      });
    });
    setTimeout(() => {
      reject(new Error('SSE open timed out'));
    }, 5000).unref();
  });
});

test('SSE /api/events without cookie → 403', async (t) => {
  const app = await createTestApp(t, { token: 'secret-I' });
  const res = await request(app).get('/api/events');
  assert.equal(res.status, 403);
});

// ---- parseCookies edge cases (Codex PR1 suggestion #2) ----

test('parseCookies: single cookie', () => {
  // parseCookies uses Object.create(null) for prototype safety — normalize
  // to a plain object for the comparison so deepEqual's strict prototype
  // check doesn't flag the (intentional) null-proto shape.
  assert.deepEqual({ ...parseCookies('palantir_token=abc') }, { palantir_token: 'abc' });
});

test('parseCookies: multiple cookies with whitespace', () => {
  const out = parseCookies('a=1; b=2;c=3');
  assert.equal(out.a, '1');
  assert.equal(out.b, '2');
  assert.equal(out.c, '3');
});

test('parseCookies: duplicate name → last wins', () => {
  // Standard browser behavior: when the header has two cookies with the
  // same name, the request may carry either; our parser currently picks
  // the last which matches "Object.assign"-style expectations. Lock it in.
  assert.equal(parseCookies('palantir_token=old; palantir_token=new').palantir_token, 'new');
});

test('parseCookies: percent-encoded value round-trips', () => {
  assert.equal(parseCookies('palantir_token=a%20b%3Dc').palantir_token, 'a b=c');
});

test('parseCookies: malformed percent-encoding falls back to raw', () => {
  // decodeURIComponent throws on bare `%`; the parser must not crash.
  assert.equal(parseCookies('palantir_token=%E0%A4%A').palantir_token, '%E0%A4%A');
});

test('parseCookies: empty / missing header', () => {
  assert.deepEqual({ ...parseCookies('') }, {});
  assert.deepEqual({ ...parseCookies(undefined) }, {});
  assert.deepEqual({ ...parseCookies(null) }, {});
});

test('parseCookies: cookie pair without "=" is skipped', () => {
  const out = parseCookies('a=1; orphan; b=2');
  assert.equal(out.a, '1');
  assert.equal(out.b, '2');
  assert.ok(!('orphan' in out));
});

// ---- Bearer precedence (Codex PR1 suggestion #1) ----

test('Invalid Bearer header does NOT fall through to a valid cookie', async (t) => {
  const app = await createTestApp(t, { token: 'secret-J' });
  const login = await request(app).post('/api/auth/login').send({ token: 'secret-J' });
  const cookiePair = login.headers['set-cookie'][0].split(';')[0];
  const res = await request(app)
    .get('/api/tasks')
    .set('Authorization', 'Bearer wrong')
    .set('Cookie', cookiePair);
  assert.equal(res.status, 403);
});

// ---- Referrer-Policy (Codex PR1 blocker #1 mitigation) ----

test('Referrer-Policy: no-referrer header is set', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/api/health');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
});

// ---- Login page exists and does NOT read ?token= ----

test('/login.html + /login.js are served statically, self-contained, CSP-safe', async (t) => {
  const app = await createTestApp(t);
  const html = await request(app).get('/login.html');
  assert.equal(html.status, 200);
  // CSP is `script-src 'self'` (no 'unsafe-inline'/nonce), so the login logic
  // MUST live in an external same-origin file — an inline <script> is blocked
  // by the browser, which silently broke the form (native GET, no auth).
  assert.match(html.text, /<script\s+src=["']login\.js["']/);
  assert.ok(!/document\.getElementById\(['"]login['"]\)/.test(html.text),
    'login.html must not inline the form logic (CSP script-src self)');

  const js = await request(app).get('/login.js');
  assert.equal(js.status, 200);
  assert.match(js.text, /POST.*\/api\/auth\/login/s);
  // Must NOT resurrect the ?token= URL bootstrap (token only ever POSTed).
  assert.ok(!/searchParams\.get\(['"]token['"]\)/.test(js.text), 'login must not read token from URL');
  // Must contain the hardened sanitizeNext function — Codex PR1 R2 blocker fix.
  assert.match(js.text, /function sanitizeNext/);
});

// ---- sanitizeNext (Codex PR1 R2 blocker #1) ----
//
// login.js contains its own sanitizeNext function (it's client-side). We
// can't import it directly, but we CAN extract it from the served JS and
// eval it inside a sandbox — that's what these tests do. Hostile `next`
// values must always fall back to "/".

test('login.js sanitizeNext rejects hostile redirects', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/login.js');
  // Extract the function source via regex. Fragile, but acceptable for a
  // single well-known file under our own control. (0-indent closing brace in
  // the external file, vs the old inline 4-space indent.)
  const m = res.text.match(/function sanitizeNext\(raw\)\s*\{[\s\S]*?\n\}\n/);
  assert.ok(m, 'sanitizeNext source not found in login.js');

  // Evaluate in a minimal vm with a fake `location` object. Use a throwing
  // `URL` constructor for protocol-relative on our origin; Node's URL is
  // spec-compliant so we can reuse it directly.
  const { Script, createContext } = require('node:vm');
  const ctx = createContext({
    location: {
      origin: 'http://localhost:4177',
      protocol: 'http:',
    },
    URL,
  });
  new Script(m[0] + '; globalThis.sanitizeNext = sanitizeNext;').runInContext(ctx);
  const sanitizeNext = ctx.sanitizeNext;

  const hostile = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    '//evil.example/path',
    'https://evil.example/steal',
    'http://evil.example:4177/',
    '\\evil.example',
    '/\\evil.example',
    '',
    null,
    undefined,
    123,
  ];
  for (const h of hostile) {
    assert.equal(sanitizeNext(h), '/', `hostile value should fall back to "/": ${h}`);
  }

  // Encoded-path regression cases (Codex PR1 R3 suggestion #1). None of
  // these are a practical bypass today — WHATWG URL parsing normalizes
  // them into same-origin paths — but we pin the contract so a future
  // URL() change can't silently widen the allowlist.
  const encodedSafe = [
    // %2f decodes to / — still same-origin; we keep these as valid paths.
    ['/%2fdashboard', true],
    ['/%2F%2Fdashboard', true],
    ['/%5cdashboard', true], // %5c = backslash in the PATH is fine
    ['/..//dashboard', true], // normalized to /dashboard by URL()
  ];
  for (const [input] of encodedSafe) {
    const out = sanitizeNext(input);
    // All must resolve to some same-origin path (starts with /, not //).
    assert.ok(out.startsWith('/'), `encoded input produced non-path: ${input} -> ${out}`);
    assert.ok(!out.startsWith('//'), `encoded input produced protocol-relative: ${input} -> ${out}`);
  }

  const safe = [
    ['/', '/'],
    ['/dashboard', '/dashboard'],
    ['/#dashboard', '/#dashboard'],
    ['/path?x=1', '/path?x=1'],
    ['/path?x=1#h', '/path?x=1#h'],
    ['/deep/nested/route', '/deep/nested/route'],
  ];
  for (const [input, expected] of safe) {
    assert.equal(sanitizeNext(input), expected, `safe value should pass through: ${input}`);
  }
});

// ---- Static index.html no longer loads from jsdelivr ----

test('index.html serves marked/purify from /vendor (not jsdelivr)', async (t) => {
  const app = await createTestApp(t); // open mode — static files are public
  const res = await request(app).get('/index.html');
  assert.equal(res.status, 200);
  // Look at actual <script src=...> attributes, not prose / comments.
  const scriptSrcs = Array.from(res.text.matchAll(/<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/g)).map(m => m[1]);
  const cdnSrcs = scriptSrcs.filter(s => s.includes('cdn.jsdelivr.net'));
  assert.deepEqual(cdnSrcs, [], `<script> still loads from jsdelivr: ${cdnSrcs.join(', ')}`);
  assert.ok(scriptSrcs.some(s => s.includes('vendor/marked.min.js')), `marked self-host missing. scripts=${scriptSrcs.join(', ')}`);
  assert.ok(scriptSrcs.some(s => s.includes('vendor/purify.min.js')), `purify self-host missing. scripts=${scriptSrcs.join(', ')}`);
});

// ML R4: req.auth.method records HOW the caller authenticated so routes can
// make actor decisions. Set ONLY after successful validation (Codex: never set
// it merely because a bearer header is present).
test('createAuthMiddleware: req.auth.method = bearer on valid Bearer', () => {
  const mw = createAuthMiddleware({ token: 'tok' });
  const req = { headers: { authorization: 'Bearer tok' } };
  let nexted = false;
  mw(req, {}, () => { nexted = true; });
  assert.equal(nexted, true);
  assert.equal(req.auth.method, 'bearer');
});

test('createAuthMiddleware: req.auth.method = cookie on valid cookie', () => {
  const mw = createAuthMiddleware({ token: 'tok' });
  const req = { headers: { cookie: 'palantir_token=tok' } };
  let nexted = false;
  mw(req, {}, () => { nexted = true; });
  assert.equal(nexted, true);
  assert.equal(req.auth.method, 'cookie');
});

test('createAuthMiddleware: invalid Bearer throws, does NOT fall through or set a success method', () => {
  const mw = createAuthMiddleware({ token: 'tok' });
  const req = { headers: { authorization: 'Bearer WRONG', cookie: 'palantir_token=tok' } };
  let nexted = false;
  assert.throws(() => mw(req, {}, () => { nexted = true; }));
  assert.equal(nexted, false, 'invalid bearer must fail closed, not fall through to cookie');
});

test('createAuthMiddleware: no token configured -> method = none', () => {
  const mw = createAuthMiddleware({ token: null });
  const req = { headers: {} };
  let nexted = false;
  mw(req, {}, () => { nexted = true; });
  assert.equal(nexted, true);
  assert.equal(req.auth.method, 'none');
});

// ML R4 (Codex BLOCKER fix): a separate PM token authenticates as bearer and
// CANNOT spoof the human cookie path (which only matches PALANTIR_TOKEN), so a
// PM holding only PALANTIR_PM_TOKEN cannot make an active human write.
test('createAuthMiddleware: separate PM token = bearer, cannot spoof human cookie', () => {
  const mw = createAuthMiddleware({ token: 'human-tok', pmToken: 'pm-tok' });
  const run = (headers) => { const req = { headers }; let ok = false; let threw = false; try { mw(req, {}, () => { ok = true; }); } catch { threw = true; } return { req, ok, threw }; };

  let r = run({ authorization: 'Bearer pm-tok' });
  assert.equal(r.ok, true); assert.equal(r.req.auth.method, 'bearer');

  r = run({ cookie: 'palantir_token=human-tok' });
  assert.equal(r.ok, true); assert.equal(r.req.auth.method, 'cookie');

  // PM token presented as the human cookie must NOT authenticate.
  r = run({ cookie: 'palantir_token=pm-tok' });
  assert.equal(r.threw, true, 'PM token cannot spoof the human cookie');

  // human token as bearer still works (CLI human) -> bearer.
  r = run({ authorization: 'Bearer human-tok' });
  assert.equal(r.ok, true); assert.equal(r.req.auth.method, 'bearer');
});

test('createAuthMiddleware: worker grant is limited to its run memory proposal route', () => {
  const workerProposalTokenService = createWorkerProposalTokenService({
    actorTokens: resolveActorTokenPolicy({
      PALANTIR_TOKEN: 'human-tok',
      PALANTIR_PM_TOKEN: 'pm-tok',
      PALANTIR_AGENT_PROCESS_ISOLATION: 'verified',
    }),
  });
  const workerToken = workerProposalTokenService.mint('run_one', { projectId: 'proj_one' });
  const mw = createAuthMiddleware({
    token: 'human-tok',
    pmToken: 'pm-tok',
    workerProposalTokenService,
  });
  const run = ({ method = 'POST', originalUrl }) => {
    const req = {
      method,
      originalUrl,
      headers: { authorization: `Bearer ${workerToken}` },
    };
    let ok = false;
    let threw = false;
    try { mw(req, {}, () => { ok = true; }); } catch { threw = true; }
    return { req, ok, threw };
  };

  const allowed = run({ originalUrl: '/api/runs/run_one/memory/propose' });
  assert.equal(allowed.ok, true);
  assert.deepEqual(allowed.req.auth, {
    method: 'worker',
    runId: 'run_one',
    projectId: 'proj_one',
  });
  assert.equal(run({ originalUrl: '/api/runs/run_two/memory/propose' }).threw, true);
  assert.equal(run({ method: 'GET', originalUrl: '/api/runs/run_one/memory/propose' }).threw, true);
  assert.equal(run({ originalUrl: '/api/tasks' }).threw, true);
});

test('createAuthMiddleware: active manager capability is run-bound and endpoint-limited', () => {
  const actorTokens = resolveActorTokenPolicy({
    PALANTIR_TOKEN: 'human-tok',
    PALANTIR_PM_TOKEN: 'pm-tok',
    PALANTIR_AGENT_PROCESS_ISOLATION: 'verified',
  });
  const managerCapabilityTokenService = createManagerCapabilityTokenService({
    actorTokens,
    signingKey: Buffer.alloc(32, 5),
  });
  const managerToken = managerCapabilityTokenService.mint('run_top', {
    conversationId: 'top',
    layer: 'top',
  });
  let active = true;
  const mw = createAuthMiddleware({
    token: 'human-tok',
    pmToken: 'pm-tok',
    managerCapabilityTokenService,
    isManagerCapabilityActive: (grant) => active && grant.runId === 'run_top',
  });
  const run = ({ method = 'GET', originalUrl }) => {
    const req = {
      method,
      originalUrl,
      headers: { authorization: `Bearer ${managerToken}` },
    };
    let ok = false;
    let threw = false;
    try { mw(req, {}, () => { ok = true; }); } catch { threw = true; }
    return { req, ok, threw };
  };

  const allowed = run({ method: 'POST', originalUrl: '/api/tasks/task_one/execute' });
  assert.equal(allowed.ok, true);
  assert.deepEqual(allowed.req.auth, {
    method: 'bearer',
    actor: 'manager',
    managerRunId: 'run_top',
    conversationId: 'top',
    layer: 'top',
  });
  assert.equal(run({ method: 'POST', originalUrl: '/api/master-memory/candidates/c1/approve' }).threw, true);
  assert.equal(run({ method: 'POST', originalUrl: '/api/dispatch-audit' }).threw, true);
  assert.equal(run({ method: 'POST', originalUrl: '/api/runs/run_worker/input' }).threw, true);
  assert.equal(run({ method: 'POST', originalUrl: '/api/conversations/worker:run_worker/message' }).threw, true);
  assert.equal(run({ method: 'POST', originalUrl: '/api/conversations/worker%3Arun_worker/message' }).threw, true);
  active = false;
  assert.equal(run({ originalUrl: '/api/runs' }).threw, true);
});

test('createAuthMiddleware: Operator capability reaches artifact verify-check CRUD only', () => {
  const actorTokens = resolveActorTokenPolicy({
    PALANTIR_TOKEN: 'human-tok',
    PALANTIR_PM_TOKEN: 'pm-tok',
    PALANTIR_AGENT_PROCESS_ISOLATION: 'verified',
  });
  const managerCapabilityTokenService = createManagerCapabilityTokenService({
    actorTokens,
    signingKey: Buffer.alloc(32, 6),
  });
  const operatorToken = managerCapabilityTokenService.mint('run_operator', {
    conversationId: 'operator:project_one',
    layer: 'operator',
  });
  const mw = createAuthMiddleware({
    token: 'human-tok',
    pmToken: 'pm-tok',
    managerCapabilityTokenService,
    isManagerCapabilityActive: (grant) => grant.runId === 'run_operator',
  });
  const allowed = (method, originalUrl) => {
    const req = {
      method,
      originalUrl,
      headers: { authorization: `Bearer ${operatorToken}` },
    };
    try {
      let passed = false;
      mw(req, {}, () => { passed = true; });
      return passed;
    } catch {
      return false;
    }
  };

  assert.equal(allowed('GET', '/api/verify-checks?project_id=project_one'), true);
  assert.equal(allowed('POST', '/api/verify-checks'), true);
  assert.equal(allowed('POST', '/api/verify-checks/assign'), true);
  assert.equal(allowed('PATCH', '/api/verify-checks/42'), true);
  assert.equal(allowed('DELETE', '/api/verify-checks/42'), true);
  assert.equal(allowed('POST', '/api/master-memory/remember'), false);
});

// This is not a raw-path set equivalence proof; it is a regression sample of
// known branches. Its purpose is to make allowlist drift visible during the
// operation-manifest refactor.
test('manager capability allowlist has witnesses for every known positive branch', () => {
  const allowed = (layer, method, originalUrl) => managerCapabilityRequestAllowed(
    { method, originalUrl },
    { layer },
  );

  const getWitnesses = [
    '/api/runs',
    '/api/runs/run_one',
    '/api/runs/run_one/events',
    '/api/runs/run_one/output',
    '/api/tasks',
    '/api/tasks/task_one',
    '/api/projects',
    '/api/projects/project_one/tasks',
    '/api/projects/project_one/memory',
    '/api/projects/project_one/skill-packs',
    '/api/agents',
    '/api/skill-packs',
    '/api/operator/profiles',
    '/api/conversations/operator%3Aproject_one/events',
  ];
  for (const originalUrl of getWitnesses) {
    assert.equal(allowed('top', 'GET', originalUrl), true, `Top GET witness: ${originalUrl}`);
    assert.equal(allowed('operator', 'GET', originalUrl), true, `Operator GET witness: ${originalUrl}`);
  }

  const commonMutationWitnesses = [
    ['POST', '/api/tasks'],
    ['POST', '/api/tasks/task_one/execute'],
    ['POST', '/api/conversations/operator%3Aproject_one/message'],
    ['POST', '/api/conversations/operator%3Aproject_one/memory/propose'],
    ['POST', '/api/operator/specialist'],
    ['PATCH', '/api/tasks/task_one'],
    ['PATCH', '/api/tasks/task_one/status'],
    ['DELETE', '/api/tasks/task_one'],
  ];
  for (const [method, originalUrl] of commonMutationWitnesses) {
    assert.equal(allowed('top', method, originalUrl), true, `Top ${method} witness: ${originalUrl}`);
    assert.equal(allowed('operator', method, originalUrl), true, `Operator ${method} witness: ${originalUrl}`);
  }
});

test('Top denies worker intervention variants that Operator allows', () => {
  const allowed = (layer, method, originalUrl) => managerCapabilityRequestAllowed(
    { method, originalUrl },
    { layer },
  );
  const variants = (rawPath) => [
    rawPath,
    `${rawPath}/`,
    `${rawPath}?trace=witness`,
    `${rawPath}/?trace=witness`,
  ];
  const interventionPaths = [
    '/api/runs/run_worker/input',
    '/api/runs/run_worker/cancel',
    '/api/conversations/worker:run_worker/message',
    '/api/conversations/worker%3Arun_worker/message',
    '/api/conversations/worker%3arun_worker/message',
  ];

  for (const rawPath of interventionPaths) {
    for (const originalUrl of variants(rawPath)) {
      assert.equal(allowed('top', 'POST', originalUrl), false, `Top denial: ${originalUrl}`);
      assert.equal(allowed('operator', 'POST', originalUrl), true, `Operator allowance: ${originalUrl}`);
    }
  }

  for (const originalUrl of variants('/api/dispatch-audit')) {
    assert.equal(allowed('top', 'POST', originalUrl), false, `Top audit denial: ${originalUrl}`);
  }
  assert.equal(allowed('operator', 'POST', '/api/dispatch-audit'), true);
  assert.equal(allowed('operator', 'POST', '/api/dispatch-audit?trace=witness'), true);
});

test('verify-check operations and assignment are Operator-only', () => {
  const allowed = (layer, method, originalUrl) => managerCapabilityRequestAllowed(
    { method, originalUrl },
    { layer },
  );
  const operatorOnlyWitnesses = [
    ['GET', '/api/verify-checks?project_id=project_one'],
    ['POST', '/api/verify-checks'],
    ['POST', '/api/verify-checks/assign'],
    ['PATCH', '/api/verify-checks/check_one'],
    ['DELETE', '/api/verify-checks/check_one'],
  ];

  for (const [method, originalUrl] of operatorOnlyWitnesses) {
    assert.equal(allowed('operator', method, originalUrl), true, `Operator allowance: ${method} ${originalUrl}`);
    assert.equal(allowed('top', method, originalUrl), false, `Top denial: ${method} ${originalUrl}`);
  }
});

test('manager capability denies task reorder without blocking task patches', () => {
  // Express matches literal routes case-insensitively by default, so the CASED
  // forms below reach the reorder handler and a raw-string compare against
  // '/api/tasks/reorder' would let them through — that is the live bypass this
  // guards. The percent-encoded forms do NOT reach that handler (Express does
  // not decode before matching a literal route; they resolve to `/:id`), so
  // they are conservative extras rather than proven bypasses. Asserting them
  // keeps the guard from regressing to a raw-string compare.
  const reorderVariants = [
    '/api/tasks/reorder',
    '/api/tasks/reorder/',
    '/api/tasks/reorder?project_id=project_one',
    '/api/tasks/reorder/?project_id=project_one',
    '/api/tasks/%72eorder',
    '/api/tasks/%72eorder/',
    '/api/tasks/REORDER',
    '/api/tasks/ReOrDeR',
    '/api/tasks/%52EORDER',
  ];

  for (const layer of ['top', 'operator']) {
    for (const originalUrl of reorderVariants) {
      assert.equal(
        managerCapabilityRequestAllowed({ method: 'PATCH', originalUrl }, { layer }),
        false,
        `${layer} denial: ${originalUrl}`,
      );
    }
    assert.equal(
      managerCapabilityRequestAllowed(
        { method: 'PATCH', originalUrl: '/api/tasks/task_one' },
        { layer },
      ),
      true,
    );
    assert.equal(
      managerCapabilityRequestAllowed(
        { method: 'PATCH', originalUrl: '/api/tasks/task_one/status' },
        { layer },
      ),
      true,
    );
  }
});

test('app manager capability expires with the active registry slot', async (t) => {
  const app = await createTestApp(t, {
    token: 'human-global',
    pmToken: 'automation-global',
    agentProcessIsolation: true,
  });
  let managerAlive = true;
  const adapter = {
    isSessionAlive: () => managerAlive,
    detectExitCode: () => null,
    disposeSession: () => true,
  };
  const managerRun = app.services.runService.createRun({
    is_manager: true,
    manager_layer: 'top',
    conversation_id: 'top',
    manager_adapter: 'codex',
    prompt: 'capability integration',
  });
  app.services.runService.updateRunStatus(managerRun.id, 'running', { force: true });
  app.managerRegistry.setActive('top', managerRun.id, adapter);
  const managerToken = app.services.managerCapabilityTokenService.mint(managerRun.id, {
    conversationId: 'top',
    layer: 'top',
  });

  await request(app)
    .get('/api/runs')
    .set('Authorization', `Bearer ${managerToken}`)
    .expect(200);
  await request(app)
    .post('/api/master-memory/candidates/not-allowed/promote')
    .set('Authorization', `Bearer ${managerToken}`)
    .send({})
    .expect(403);
  await request(app)
    .post('/api/tasks/task-not-allowed/execute')
    .set('Authorization', `Bearer ${managerToken}`)
    .send({ pm_run_id: 'another-manager', agent_profile_id: 'agent' })
    .expect(403);

  managerAlive = false;
  await request(app)
    .get('/api/runs')
    .set('Authorization', `Bearer ${managerToken}`)
    .expect(403);
  assert.equal(app.managerRegistry.getActiveRunId('top'), null);
});

test('app honors an explicit agent process isolation opt-out over ambient verification', async (t) => {
  const previousIsolation = process.env.PALANTIR_AGENT_PROCESS_ISOLATION;
  process.env.PALANTIR_AGENT_PROCESS_ISOLATION = 'verified';
  t.after(() => {
    if (previousIsolation === undefined) delete process.env.PALANTIR_AGENT_PROCESS_ISOLATION;
    else process.env.PALANTIR_AGENT_PROCESS_ISOLATION = previousIsolation;
  });

  const app = await createTestApp(t, {
    token: 'human-global',
    pmToken: 'automation-global',
    agentProcessIsolation: false,
  });
  assert.equal(app.services.managerCapabilityTokenService.mint('run_top', {
    conversationId: 'top',
    layer: 'top',
  }), null);
  assert.equal(app.services.workerProposalTokenService.mint('run_worker', {
    projectId: 'project_one',
  }), null);
});
