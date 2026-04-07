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
  const app = createApp({ storageRoot, fsRoot, opencodeBin: 'opencode', dbPath });

  t.after(async () => {
    if (app.shutdown) app.shutdown();
    else app.closeDb();
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
    await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  });
  return app;
}

// Every static asset the bootstrap chain depends on. If any of these 404 in
// production we get a blank page with no JS — exactly the case we're guarding.
const REQUIRED_ASSETS = [
  { path: '/', mime: /text\/html/ },
  { path: '/styles.css', mime: /text\/css/ },
  { path: '/styles/tokens.css', mime: /text\/css/ },
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

// ---- index.html structure ----

test('boot: index.html loads app/main.js as a module entry', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/');
  assert.equal(res.status, 200);
  assert.match(res.text, /<script\s+type="module"\s+src="app\/main\.js"/, 'module entry tag present');
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

test('boot: index.html does NOT include the legacy classic script tag', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/');
  // Legacy bootstrap was `<script src="app.js" defer>`. main.js loads app.js
  // dynamically, so a static `<script src="app.js">` tag would mean someone
  // accidentally restored the old loader and we'd get double-init.
  assert.doesNotMatch(res.text, /<script\s+src="app\.js"/, 'no static <script src="app.js">');
});

test('boot: index.html still pulls marked + DOMPurify from CDN', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/');
  // markdown.js falls back to plain HTML escape when these globals are
  // missing, so the test only verifies the script tags are still present.
  assert.match(res.text, /marked.*\.js/, 'marked CDN script tag present');
  assert.match(res.text, /purify.*\.js/i, 'DOMPurify CDN script tag present');
});

// ---- main.js bridge contract ----

test('boot: app/main.js bridges Preact onto window globals', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/app/main.js');
  assert.equal(res.status, 200);
  assert.match(res.text, /window\.preact\s*=/, 'window.preact assignment');
  assert.match(res.text, /window\.preactHooks\s*=/, 'window.preactHooks assignment');
  assert.match(res.text, /window\.htm\s*=/, 'window.htm assignment');
});

test('boot: app/main.js loads legacy app.js dynamically', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/app/main.js');
  assert.match(res.text, /legacy\.src\s*=\s*['"]\.\/app\.js['"]/, 'dynamic legacy loader present');
});

test('boot: app/main.js bridges helper modules onto window', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/app/main.js');
  // Each pure helper extracted in B2 must be on window so legacy app.js can
  // see it. If any of these go missing, app.js calls become ReferenceError.
  for (const sym of ['formatDuration', 'formatTime', 'timeAgo', 'renderMarkdown', 'apiFetch']) {
    assert.match(res.text, new RegExp(`window\\.${sym}\\s*=`), `${sym} bridge present`);
  }
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
  const res = await request(app).get('/app/lib/hooks.js');
  // Locks the public surface of hooks.js. If a hook gets renamed or dropped
  // here, the bridge in main.js would silently fail to assign it on window
  // and app.js would fall back to a ReferenceError on first use.
  for (const sym of ['useRoute', 'navigate', 'useEscape', 'useSSE', 'useTasks', 'useRuns', 'useProjects', 'useClaudeSessions', 'useAgents', 'useManager']) {
    assert.match(res.text, new RegExp(`export\\s+(async\\s+)?function\\s+${sym}`), `${sym} export present`);
  }
});

test('boot: main.js bridges the toast and hook modules onto window', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/app/main.js');
  for (const sym of ['addToast', 'useToasts', 'ToastContainer', 'apiFetchWithToast']) {
    assert.match(res.text, new RegExp(`window\\.${sym}\\s*=`), `${sym} window bridge present`);
  }
  for (const sym of ['useRoute', 'navigate', 'useEscape', 'useSSE', 'useTasks', 'useRuns', 'useProjects', 'useClaudeSessions', 'useAgents', 'useManager']) {
    assert.match(res.text, new RegExp(`window\\.${sym}\\s*=`), `${sym} window bridge present`);
  }
});

test('boot: app/components/RunInspector.js exports the component and main.js bridges it', async (t) => {
  const app = await createTestApp(t);
  const componentRes = await request(app).get('/app/components/RunInspector.js');
  assert.match(componentRes.text, /export\s+function\s+RunInspector/, 'RunInspector export present');

  const mainRes = await request(app).get('/app/main.js');
  // main.js loads the component via dynamic import AFTER the preact globals
  // are assigned (so module top-level destructuring of window.preactHooks
  // resolves), then bridges it onto window.RunInspector for the legacy app.js
  // htm template lookup. Both halves of the contract get checked here.
  assert.match(mainRes.text, /import\(['"]\.\/components\/RunInspector\.js['"]\)/, 'dynamic import of RunInspector');
  assert.match(mainRes.text, /window\.RunInspector\s*=/, 'window.RunInspector bridge');
});
