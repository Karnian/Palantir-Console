/**
 * Boot smoke tests — frontend bootstrap regression net.
 *
 * `npm test` doesn't exercise the browser bootstrap path on its own. These
 * tests catch the easy-to-miss regressions:
 *   - a vendor or lib file 404'ing because of a path typo
 *   - the wrong MIME type breaking ES module loading
 *   - the upstream `vendor/hooks.module.js` being re-bundled, wiping our
 *     `import "preact"` → `import "./preact.module.js"` patch
 *   - someone re-adding the legacy `<script src="app.js">` tag instead of
 *     loading via `app/main.js`
 *
 * Strict file/MIME assertions only — no HTML rendering, no JS execution.
 * If a check here fails, the browser would have failed silently or with
 * a console error that nobody would see in CI.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');
const { createApp } = require('../app');

async function createTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createTestApp(t) {
  const storageRoot = await createTempDir('palantir-storage-');
  const fsRoot = await createTempDir('palantir-fs-');
  const dbPath = path.join(await createTempDir('palantir-db-'), 'test.db');
  // Phase Test-Stabilize (2026-04-27): pin `authToken: null` to keep
  // sibling-test PALANTIR_TOKEN leaks from biasing this app — even
  // though static assets sit before /api auth, keeping the option
  // explicit removes one variable from the flake hunt.
  const app = createApp({ storageRoot, fsRoot, opencodeBin: 'opencode', dbPath, authToken: null });

  // Phase Test-Stabilize round 2 (Codex BLOCK): the original flake was
  // `Cannot read properties of null (reading 'port')`, surfaced when
  // supertest fell into a race between its automatic `app.listen(0)`
  // and the very first asset request (the address listener has not
  // attached yet — `server.address()` returns null inside supertest's
  // own internals). Pre-listen explicitly on 127.0.0.1 + ephemeral
  // port and hand the bound `http.Server` to supertest so by the
  // time any test issues a request, `address().port` is populated.
  const http = require('node:http');
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    // Node's `server.listen(...)` callback does NOT receive an error
    // argument — wire up `listening` + `error` events explicitly so
    // bind failures (EADDRINUSE / EPERM in sandboxed CI) reject this
    // helper instead of silently moving forward with an unbound server.
    server.once('listening', resolve);
    server.once('error', reject);
    server.listen(0, '127.0.0.1');
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    if (app.shutdown) app.shutdown();
    else app.closeDb();
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
    await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  });
  // Hand the live server to supertest so callers do `request(server)`
  // (we keep the function name `createTestApp` for compatibility).
  return server;
}

// Every static asset the bootstrap chain depends on. If any of these 404 in
// production we get a blank page with no JS — exactly the case we're guarding.
const REQUIRED_ASSETS = [
  { path: '/', mime: /text\/html/ },
  { path: '/styles.css', mime: /text\/css/ },
  { path: '/styles/tokens.css', mime: /text\/css/ },
  { path: '/theme-init.js', mime: /text\/javascript|application\/javascript/ },
  { path: '/app/main.js', mime: /text\/javascript|application\/javascript/ },
  { path: '/app.js', mime: /text\/javascript|application\/javascript/ },
  { path: '/app/lib/format.js', mime: /text\/javascript|application\/javascript/ },
  { path: '/app/lib/markdown.js', mime: /text\/javascript|application\/javascript/ },
  { path: '/app/lib/api.js', mime: /text\/javascript|application\/javascript/ },
  { path: '/app/lib/toast.js', mime: /text\/javascript|application\/javascript/ },
  { path: '/app/lib/hooks.js', mime: /text\/javascript|application\/javascript/ },
  { path: '/app/components/RunInspector.js', mime: /text\/javascript|application\/javascript/ },
  { path: '/vendor/preact.module.js', mime: /text\/javascript|application\/javascript/ },
  { path: '/vendor/hooks.module.js', mime: /text\/javascript|application\/javascript/ },
  { path: '/vendor/htm.module.js', mime: /text\/javascript|application\/javascript/ },
];

for (const asset of REQUIRED_ASSETS) {
  test(`boot: ${asset.path} responds 200 with correct MIME`, async (t) => {
    const app = await createTestApp(t);
    const res = await request(app).get(asset.path);
    assert.equal(res.status, 200, `${asset.path} should be 200`);
    assert.match(res.headers['content-type'] || '', asset.mime, `${asset.path} content-type`);
  });
}

test('boot: health exposes package and boot diagnostics without auth', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.version, '2.0.0');
  assert.equal(res.body.packageVersion, '1.0.0');
  assert.match(res.body.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(!Number.isNaN(Date.parse(res.body.startedAt)));
  assert.match(res.body.bootId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.ok(res.body.gitSha === null || /^[0-9a-f]{4,}$/i.test(res.body.gitSha));
});

test('boot: index listen errors fail fast with diagnostic log', async () => {
  const src = await fs.readFile(path.join(__dirname, '../index.js'), 'utf8');
  assert.match(src, /server\.on\(['"]error['"]/);
  assert.match(src, /\[boot\] listen failed on \$\{host\}:\$\{port\}: \$\{code\}/);
  assert.match(src, /process\.exit\(1\)/);
});

// ---- index.html structure ----

test('boot: index.html loads app/main.js as a module entry', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/');
  assert.equal(res.status, 200);
  assert.match(res.text, /<script\s+type="module"\s+src="app\/main\.js"/, 'module entry tag present');
});

test('boot: index.html loads theme-init.js before any stylesheet', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/');
  // Phase K-2c (2026-04-28): theme-init.js sets `<html data-theme>` from
  // localStorage BEFORE the cascade applies, preventing a flash of
  // dark default for users whose stored preference is light. If a
  // future edit moves the script after `<link rel="stylesheet">`,
  // FOUC returns silently. Lock the order.
  // Codex K-2c r1 finding: match the actual `<script src="...">` tag,
  // not the comment that documents it (a free-text comment containing
  // 'theme-init.js' would falsely satisfy a plain `indexOf`).
  const scriptMatch = /<script\s+src="theme-init\.js"\s*>/.exec(res.text);
  assert.ok(scriptMatch, 'theme-init.js <script> tag present');
  const initIdx = scriptMatch.index;
  const fontsIdx = res.text.indexOf('styles/fonts.css');
  const tokensIdx = res.text.indexOf('styles/tokens.css');
  const stylesIdx = res.text.indexOf('"styles.css"');
  assert.ok(initIdx < fontsIdx, 'theme-init.js must precede fonts.css');
  assert.ok(initIdx < tokensIdx, 'theme-init.js must precede tokens.css');
  assert.ok(initIdx < stylesIdx, 'theme-init.js must precede styles.css');
});

test('boot: login.html also loads theme-init.js before any stylesheet', async (t) => {
  // Same FOUC-prevention guard for the script-light login page.
  const app = await createTestApp(t);
  const res = await request(app).get('/login.html');
  const scriptMatch = /<script\s+src="theme-init\.js"\s*>/.exec(res.text);
  assert.ok(scriptMatch, 'theme-init.js <script> tag present in login.html');
  const initIdx = scriptMatch.index;
  const fontsIdx = res.text.indexOf('styles/fonts.css');
  const tokensIdx = res.text.indexOf('styles/tokens.css');
  assert.ok(initIdx < fontsIdx, 'theme-init.js must precede fonts.css in login.html');
  assert.ok(initIdx < tokensIdx, 'theme-init.js must precede tokens.css in login.html');
});

test('boot: index.html loads styles/tokens.css before styles.css', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/');
  // styles.css consumes the CSS variables defined in tokens.css. The cascade
  // depends on tokens loading first; if someone reorders the links, the
  // variables resolve to the fallbacks (or `unset`) and the page degrades.
  const tokensIdx = res.text.indexOf('styles/tokens.css');
  const stylesIdx = res.text.indexOf('"styles.css"');
  assert.notEqual(tokensIdx, -1, 'tokens link present');
  assert.notEqual(stylesIdx, -1, 'styles link present');
  assert.ok(tokensIdx < stylesIdx, 'tokens.css must precede styles.css in source order');
});

test('boot: styles/tokens.css defines the core design tokens', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/styles/tokens.css');
  // Smoke: every variable that the rest of styles.css unconditionally uses
  // must still be defined here. Catches a token rename or accidental drop.
  for (const v of ['--bg-base', '--text-primary', '--accent', '--border', '--font-sans', '--radius-md']) {
    assert.match(res.text, new RegExp(`${v}\\s*:`), `${v} defined`);
  }
});

test('boot: styles/tokens.css defines the K-2d cascade contract', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/styles/tokens.css');
  // Phase K-2d (2026-04-28): full theme cascade — three selectors in
  // addition to the dark default.
  //
  // Codex K-2d r1 P2: strip /* ... */ comments before regex match so
  // a documentation comment containing the same selectors can't
  // false-positive the gate. Keep the rest of the source for line
  // counting / content asserts.
  const cssOnly = res.text.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(cssOnly, /color-scheme:\s*light\s+dark/,
    'color-scheme: light dark advertised (real declaration, not a comment)');
  assert.match(
    cssOnly,
    /@media\s*\(prefers-color-scheme:\s*light\)\s*\{\s*:root:not\(\[data-theme\]\)/,
    'prefers-color-scheme: light media with :root:not([data-theme])',
  );
  assert.match(cssOnly, /:root\[data-theme="dark"\]\s*\{/,
    ':root[data-theme="dark"] override block (real declaration)');
});

test('boot: styles/tokens.css defines a [data-theme="light"] override block', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/styles/tokens.css');
  // Phase K-2a (2026-04-28): light palette is opt-in via
  // `<html data-theme="light">`. The selector + at least one
  // surface token (`--bg-base`) inside the override block prove the
  // light branch was emitted; activation (system prefers-color +
  // toggle UI) lands in K-2c/K-2d.
  assert.match(res.text, /:root\[data-theme="light"\]\s*\{/,
    '[data-theme="light"] block emitted');
  // Inside the override block the bg-base should swap to a light value
  // (we don't pin the exact hex; we only check that some near-white
  // value follows the selector).
  assert.match(
    res.text,
    /:root\[data-theme="light"\][\s\S]*--bg-base:\s*#fafafa/,
    '--bg-base flipped to light hex inside the override block',
  );
});

test('boot: tokens.css light blocks lock-step (explicit override === system @media)', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/styles/tokens.css');
  // K-3β (2026-04-29): tokens.css emits TWO light-mode token blocks
  // (CSS can't share a selector across an @media boundary):
  //   1. `:root[data-theme="light"]`        — explicit user toggle
  //   2. `@media (prefers-color-scheme: light) { :root:not([data-theme]) }`
  //                                          — system OS auto-detect
  //
  // K-2 lock-step rule (CLAUDE.md Things to Watch Out For):
  // both blocks MUST define the same token keys with the same values
  // or the explicit-toggle and system-default themes silently diverge.
  // This test enforces the contract automatically — adding a new
  // semantic color token without updating BOTH blocks fails the build.
  //
  // Alias-only tokens (e.g. `--field-bg: var(--bg-base)`) intentionally
  // live in `:root` only — they propagate via their underlying base
  // when the base swaps, so they're outside this contract. The check
  // only compares keys actually emitted inside the two light blocks.
  const css = res.text.replace(/\/\*[\s\S]*?\*\//g, '');

  function extractBlock(source, anchorRegex) {
    const m = anchorRegex.exec(source);
    if (!m) return null;
    let i = m.index + m[0].length;
    while (i < source.length && source[i] !== '{') i++;
    if (i >= source.length) return null;
    const start = i + 1;
    let depth = 1;
    i++;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') depth--;
      i++;
    }
    return depth === 0 ? source.slice(start, i - 1) : null;
  }

  const explicitBody = extractBlock(css, /:root\[data-theme="light"\]/);
  assert.ok(explicitBody, ':root[data-theme="light"] block must exist');

  const mediaBody = extractBlock(css, /@media\s*\(prefers-color-scheme:\s*light\)/);
  assert.ok(mediaBody, '@media (prefers-color-scheme: light) block must exist');
  const mediaInnerBody = extractBlock(mediaBody, /:root:not\(\[data-theme\]\)/);
  assert.ok(mediaInnerBody, ':root:not([data-theme]) inside @media block must exist');

  function parseTokens(body) {
    const tokens = new Map();
    const pattern = /(--[a-z][a-z0-9-]*)\s*:\s*([^;]+);/g;
    let m;
    while ((m = pattern.exec(body)) !== null) {
      tokens.set(m[1], m[2].trim().replace(/\s+/g, ' '));
    }
    return tokens;
  }

  const explicit = parseTokens(explicitBody);
  const media = parseTokens(mediaInnerBody);
  const explicitKeys = [...explicit.keys()].sort();
  const mediaKeys = [...media.keys()].sort();

  const onlyInExplicit = explicitKeys.filter(k => !media.has(k));
  const onlyInMedia = mediaKeys.filter(k => !explicit.has(k));
  assert.deepStrictEqual(
    mediaKeys,
    explicitKeys,
    `Light-mode token key sets diverge.\n` +
    `  Only in [data-theme="light"]: ${onlyInExplicit.join(', ') || '(none)'}\n` +
    `  Only in @media prefers-color-scheme:light: ${onlyInMedia.join(', ') || '(none)'}\n` +
    `Add the missing tokens to BOTH blocks (K-2 lock-step contract).`
  );
  for (const key of explicitKeys) {
    assert.strictEqual(
      media.get(key),
      explicit.get(key),
      `Token ${key} value diverges between light blocks.\n` +
      `  [data-theme="light"]: "${explicit.get(key)}"\n` +
      `  @media prefers-color-scheme:light: "${media.get(key)}"\n` +
      `Both blocks must hold the same value (K-2 lock-step contract).`
    );
  }
});

test('boot: styles/tokens.css defines the Theme Contract α semantic tokens', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/styles/tokens.css');
  // Phase Theme Contract α (2026-04-28): semantic surface tokens —
  // recurring "translucent status surface" patterns get a single
  // source of truth before Phase Theme Contract β starts adopting
  // them across styles.css. A rename or drop here would break every
  // adopted call site silently (var() with no fallback resolves to
  // empty), so this gate stays alongside the existing core-token
  // smoke check.
  //
  // K-3α (2026-04-29): `--surface-hover` removed — it was never
  // adopted (~6 hover sites had subtly different "hover" semantics
  // so a single alias would have broadened token meaning). Re-add
  // here only when a concrete consumer with single-meaning hover
  // (not selection / not row-highlight) lands.
  for (const v of [
    '--warning-bg-subtle',
    '--warning-border-subtle',
    '--status-failed-bg-subtle',
    '--status-failed-border-subtle',
    '--success-bg-subtle',
    '--info-bg-subtle',
    '--accent-bg-subtle',
    '--focus-ring',
    '--field-bg',
    '--scrollbar-thumb',
    '--scrollbar-thumb-hover',
  ]) {
    assert.match(res.text, new RegExp(`${v}\\s*:`), `${v} defined`);
  }
});

test('boot: K-4 skill-pack chip tokens satisfy WCAG AA contrast (closes axe coverage gap)', async (t) => {
  // K-4-followup-contrast PR-3 r3 (Codex BLOCK fix r3): the a11y.spec.js
  // axe sweep only renders skill packs that exist in the seed DB —
  // typically a single `bundled` pack — so it can't catch a regression
  // in the `.skill-pack-origin.{url,import,manual}` /
  // `.skill-pack-scope.{global,project}` / `.skill-pack-{mcp,check,tokens}`
  // chips because those variants never reach the DOM under fresh-DB
  // baseline. This test computes WCAG AA contrast for each chip directly
  // from token values + the actual chip background composite (chip tint
  // over `--bg-elevated`, NOT `--bg-base` — the chip lives inside
  // `.skill-pack-card { background: var(--bg-elevated) }`). Token edits
  // that would break either theme fail the build regardless of axe
  // fixture coverage.
  const app = await createTestApp(t);
  const res = await request(app).get('/styles/tokens.css');
  const css = res.text.replace(/\/\*[\s\S]*?\*\//g, '');

  function extractTokenInBlock(source, anchorRegex, name) {
    const m = anchorRegex.exec(source);
    if (!m) throw new Error(`block anchor not found: ${anchorRegex}`);
    // Find the first `{` at or after the anchor start. If the anchor
    // pattern itself includes `{`, this lands on that brace; otherwise
    // we walk to the next one. Without the `at or after`, an anchor
    // ending with `{` would skip its own brace and grab a nested one
    // (giving us the wrong block body).
    let i = m.index;
    while (i < source.length && source[i] !== '{') i++;
    if (i >= source.length) throw new Error('opening brace missing');
    let depth = 1; const start = i + 1; i++;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') depth--;
      i++;
    }
    const body = source.slice(start, i - 1);
    const re = new RegExp(`${name}\\s*:\\s*([^;]+);`);
    const tokenMatch = re.exec(body);
    if (!tokenMatch) throw new Error(`token ${name} not found in matched block`);
    return tokenMatch[1].trim();
  }

  function rgbFromHex(hex) {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function srgb(c) {
    c = c / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function lum([r, g, b]) {
    return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
  }
  function ratio(a, b) {
    const la = lum(a), lb = lum(b);
    return ((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05));
  }
  function composite(fg, alpha, bg) {
    return fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha)));
  }
  function resolve(token, vars) {
    // Resolve simple `var(--name)` aliases against a vars map.
    const m = /^var\(\s*(--[a-z0-9-]+)\s*\)$/.exec(token);
    if (m) {
      if (!vars[m[1]]) throw new Error(`alias ${token} → undefined`);
      return resolve(vars[m[1]], vars);
    }
    return token;
  }

  // Pull every token referenced by chip rules from both dark and light blocks.
  const tokenNames = [
    '--bg-elevated', '--accent', '--accent-light',
    '--text-muted', '--text-secondary',
    '--info', '--info-light', '--success',
    '--origin-url-fg',
  ];
  const darkVars = {};
  const lightVars = {};
  for (const n of tokenNames) {
    darkVars[n]  = extractTokenInBlock(css, /:root\s*\{/, n);
    lightVars[n] = extractTokenInBlock(css, /:root\[data-theme="light"\]\s*\{/, n);
  }

  // Each chip lives inside `.skill-pack-card { background: var(--bg-elevated) }`.
  // The chip's own background is `color-mix(in srgb, <hue> <alpha>, transparent)`
  // (or `rgba(255,255,255,0.06)` for the default chip tint), so the rendered
  // chip bg = composite(<hue>, <alpha>, --bg-elevated). We model that exactly,
  // NOT `--bg-base`, so axe-equivalent contrast is computed (Codex r3 BLOCK
  // fix on the previous draft that used --bg-base). `--accent-muted` uses
  // alpha 0.15 in dark / 0.12 in light per tokens.css; cases below pass the
  // theme-correct alpha via a `[darkAlpha, lightAlpha]` pair for chips that
  // share the same hue token but differ per theme.
  const WHITE = [255, 255, 255];
  function chipBg(vars, hueToken, alpha) {
    const elevated = rgbFromHex(resolve(vars['--bg-elevated'], vars));
    if (hueToken === 'WHITE_OVERLAY_06') {
      // Default chip tint used by `.skill-pack-scope` / `.tokens` / `.mcp` / `.check`:
      // `background: rgba(255,255,255,0.06)` over --bg-elevated.
      return composite(WHITE, 0.06, elevated);
    }
    const hue = rgbFromHex(resolve(vars[hueToken], vars));
    return composite(hue, alpha, elevated);
  }
  function chipRatio(vars, fgToken, hueToken, alpha) {
    const fg = rgbFromHex(resolve(vars[fgToken], vars));
    const bg = chipBg(vars, hueToken, alpha);
    return ratio(fg, bg);
  }

  // Coverage matrix — every chip surface a fresh DB might miss, plus
  // explicit dark/light pairs. Alpha is either a single number or
  // `[darkAlpha, lightAlpha]` when the theme uses different tint
  // strength (e.g. `--accent-muted` is 0.15 dark / 0.12 light).
  const cases = [
    ['.skill-pack-scope (base)',  '--text-muted',     'WHITE_OVERLAY_06', 0.06],
    ['.skill-pack-scope.global',  '--accent-light',   '--accent',         [0.15, 0.12]],
    ['.skill-pack-scope.project', '--info-light',     '--info',           0.15],
    ['.skill-pack-tokens',        '--text-muted',     'WHITE_OVERLAY_06', 0.06],
    ['.skill-pack-mcp',           '--accent-light',   'WHITE_OVERLAY_06', 0.06],
    ['.skill-pack-check',         '--success',        'WHITE_OVERLAY_06', 0.06],
    ['.skill-pack-priority',      '--text-muted',     'WHITE_OVERLAY_06', 0.06],
    ['.skill-pack-origin.bundled','--accent-light',   '--accent',         0.12],
    ['.skill-pack-origin.url',    '--origin-url-fg',  '--origin-url-fg',  0.15],
    ['.skill-pack-origin.manual', '--text-secondary', '--text-muted',     0.15],
    ['.skill-pack-origin.import', '--accent-light',   '--accent-light',   0.15],
  ];

  const failures = [];
  for (const [name, fgToken, hueToken, alpha] of cases) {
    for (const [theme, vars] of [['dark', darkVars], ['light', lightVars]]) {
      const a = Array.isArray(alpha) ? (theme === 'dark' ? alpha[0] : alpha[1]) : alpha;
      const r = chipRatio(vars, fgToken, hueToken, a);
      if (r < 4.5) {
        const fg = resolve(vars[fgToken], vars);
        failures.push(`${name} (${theme}): ${r.toFixed(2)}:1 (expected ≥4.5:1, fg=${fg}, fgToken=${fgToken}, hue=${hueToken}@${a})`);
      }
    }
  }
  assert.deepStrictEqual(
    failures,
    [],
    `WCAG AA contrast violation in skill-pack chip tokens (axe coverage gap closer):\n  ${failures.join('\n  ')}`,
  );
});

test('boot: every fallback-less var() in styles.css is defined in tokens.css', async (t) => {
  // Token parity check. Codex spotted that styles.css references
  // `--bg-tertiary` and `--status-error` via var() with no fallback, but
  // tokens.css used to leave them undefined — they silently rendered as
  // empty strings. This test fails the build the moment a new fallback-less
  // var() is added without a matching definition.
  const app = await createTestApp(t);
  const stylesRes = await request(app).get('/styles.css');
  const tokensRes = await request(app).get('/styles/tokens.css');

  // Match var(--name) where there's no comma fallback before the closing )
  const varPattern = /var\(\s*(--[a-z][a-z0-9-]*)\s*\)/g;
  const used = new Set();
  let m;
  while ((m = varPattern.exec(stylesRes.text)) !== null) {
    used.add(m[1]);
  }

  const definedPattern = /^\s*(--[a-z][a-z0-9-]*)\s*:/gm;
  const defined = new Set();
  while ((m = definedPattern.exec(tokensRes.text)) !== null) {
    defined.add(m[1]);
  }

  const missing = [...used].filter((name) => !defined.has(name));
  assert.deepEqual(missing, [], `tokens.css missing definitions for fallback-less var() usages in styles.css: ${missing.join(', ')}`);
});

test('boot: index.html does NOT include the legacy classic script tag', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/');
  // Legacy bootstrap was `<script src="app.js" defer>`. main.js loads app.js
  // dynamically, so a static `<script src="app.js">` tag would mean someone
  // accidentally restored the old loader and we'd get double-init.
  assert.doesNotMatch(res.text, /<script\s+src="app\.js"/, 'no static <script src="app.js">');
});

test('boot: index.html includes self-hosted marked + DOMPurify scripts', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/');
  // marked + DOMPurify are self-hosted in vendor/. The test verifies the
  // script tags are still present (markdown.js falls back to plain HTML
  // escape when these globals are missing).
  assert.match(res.text, /marked.*\.js/, 'marked script tag present');
  assert.match(res.text, /purify.*\.js/i, 'DOMPurify script tag present');
});

// ---- main.js bootstrapper contract (P9-3: bridges removed) ----

test('boot: app/main.js is a minimal bootstrapper that loads app.js', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/app/main.js');
  assert.equal(res.status, 200);
  // Must call configureMarked and load app.js — that's its entire job.
  assert.match(res.text, /configureMarked\(\)/, 'configureMarked() call present');
  assert.match(res.text, /import\(\s*['"]\.\.\/app\.js['"]\s*\)/, 'ESM dynamic import of app.js present');
  // No window.* bridge assignments should remain (P9-3).
  assert.doesNotMatch(res.text, /window\.\w+\s*=/, 'no window.* bridge assignments');
});

// ---- vendor patch must survive upstream re-bundles ----

test('boot: vendor/hooks.module.js patch (relative preact import) is preserved', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/vendor/hooks.module.js');
  assert.equal(res.status, 200);
  // Without this patch, the bare specifier `"preact"` would need an import
  // map in the page, which the current CSP `script-src 'self'` rejects.
  assert.match(res.text, /from\s*["']\.\/preact\.module\.js["']/, 'hooks.module.js imports preact via relative path');
  assert.doesNotMatch(res.text.split('\n').slice(0, 10).join('\n'), /from\s*["']preact["']/, 'no bare "preact" specifier in the first 10 lines');
});

// ---- lib module contracts ----

test('boot: app/lib/markdown.js exports renderMarkdown', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/app/lib/markdown.js');
  assert.match(res.text, /export\s+function\s+renderMarkdown/, 'renderMarkdown export present');
});

test('boot: app/lib/format.js exports the date helpers', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/app/lib/format.js');
  for (const sym of ['formatDuration', 'formatTime', 'timeAgo']) {
    assert.match(res.text, new RegExp(`export\\s+function\\s+${sym}`), `${sym} export present`);
  }
});

test('boot: app/lib/api.js exports apiFetch', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/app/lib/api.js');
  assert.match(res.text, /export\s+(async\s+)?function\s+apiFetch/, 'apiFetch export present');
});

test('boot: app/lib/toast.js exports the toast system', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/app/lib/toast.js');
  for (const sym of ['addToast', 'useToasts', 'ToastContainer', 'apiFetchWithToast']) {
    assert.match(res.text, new RegExp(`export\\s+(async\\s+)?function\\s+${sym}`), `${sym} export present`);
  }
});

test('boot: app/lib/hooks.js exports every hook the app needs', async (t) => {
  const app = await createTestApp(t);
  // P8-4: hooks.js is now a thin re-exporter (`export * from './hooks/index.js'`).
  // The barrel index.js re-exports every symbol from focused sub-modules.
  // Verify the barrel lists every required name.
  const res = await request(app).get('/app/lib/hooks/index.js');
  for (const sym of ['useRoute', 'navigate', 'useEscape', 'useSSE', 'useTasks', 'useRuns', 'useProjects', 'useClaudeSessions', 'useAgents', 'useManagerLifecycle']) {
    assert.match(res.text, new RegExp(sym), `${sym} re-export present in barrel`);
  }
});

test('boot: app/components/RunInspector.js exports the component', async (t) => {
  const app = await createTestApp(t);
  const componentRes = await request(app).get('/app/components/RunInspector.js');
  assert.match(componentRes.text, /export\s+function\s+RunInspector/, 'RunInspector export present');
});
