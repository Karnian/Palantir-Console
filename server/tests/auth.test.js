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
const { parseCookies } = require('../middleware/auth');

async function createTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createTestApp(t, { token } = {}) {
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

test('/login.html is served statically and self-contained', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/login.html');
  assert.equal(res.status, 200);
  assert.match(res.text, /POST.*\/api\/auth\/login/s);
  // Must NOT resurrect ?token= URL bootstrap.
  assert.ok(!/searchParams\.get\(['"]token['"]\)/.test(res.text), 'login.html should not read token from URL');
  // Must contain the hardened sanitizeNext function — Codex PR1 R2 blocker fix.
  assert.match(res.text, /function sanitizeNext/);
});

// ---- sanitizeNext (Codex PR1 R2 blocker #1) ----
//
// login.html contains its own sanitizeNext function (it's client-side). We
// can't import it directly, but we CAN extract it from the served HTML and
// eval it inside a sandbox — that's what these tests do. Hostile `next`
// values must always fall back to "/".

test('login.html sanitizeNext rejects hostile redirects', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/login.html');
  // Extract the function source via regex. Fragile, but acceptable for a
  // single well-known file under our own control.
  const m = res.text.match(/function sanitizeNext\(raw\)\s*\{[\s\S]*?\n    \}\n/);
  assert.ok(m, 'sanitizeNext source not found in login.html');

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
