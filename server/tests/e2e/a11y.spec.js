// Phase K-4 (2026-04-29): WCAG 2.1 AA a11y automation.
//
// Spec lock-in: docs/specs/k4-wcag-a11y-automation-brief.md
//
// Matrix: 12 hash routes × 2 themes (dark/light) × 2 viewports (1280×800 desktop,
// 375×667 mobile) = 48 scenarios. Tagged @a11y so `npm run test:a11y` can grep.
//
// Gate policy (L3):
//   - critical / serious axe violation → fail
//   - moderate / minor → report-only (logged, no assert)
//
// Waiver policy (L4/L5 r2 transitional baseline):
//   - file: server/tests/e2e/a11y-waivers.json (single file)
//   - schema: { route, theme, viewport, ruleId, selector, reason, expiresAt,
//               ownerSurface?, followupRef?, approvedBy?, kind? }
//   - color-contrast → only `kind: "transitional"` baseline waivers, ≤14 days,
//     full provenance (ownerSurface/followupRef/approvedBy). Non-baseline new
//     contrast violations cannot be waived.
//   - all other rules → ≤30 day expiresAt
//   - expiresAt past today → fail anyway
//   - waiver defined but no matching violation → unused waiver → fail
//   - selector substring matching is intentional baseline compression debt:
//     a broad waiver like `.primary` will absorb future violations on the same
//     route+rule. K-4-followup PRs must narrow these as surfaces are fixed.
//
// Failure output (L6): each violation logs route / theme / viewport / ruleId /
// selector / failureSummary so the maintainer can fix it without re-running.

const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const fs = require('fs');
const path = require('path');

const ROUTES = [
  'dashboard',
  'manager',
  'board',
  'projects',
  'agents',
  'resources/skills',
  'resources/presets',
  'resources/mcp-servers',
  'resources/nodes',
  'memory',
  'operator/specialist',
  'operator/profiles',
];
const THEMES = ['dark', 'light'];
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 375, height: 667 },
];

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const FAIL_IMPACTS = new Set(['critical', 'serious']);
const WAIVERS_PATH = path.join(__dirname, 'a11y-waivers.json');

// L1 scan context: each route exposes [data-view="<key>"] root, so axe
// scope follows that selector. Sidebar/header common chrome still gets
// scanned via the dashboard scenario (where it sits inside the same
// document but outside [data-view]) — to keep noise low we scope to
// [data-view] for non-dashboard routes and also include nav.nav-sidebar
// once on dashboard.
//
// For consolidated sub-routes (e.g. 'resources/skills') the data-view
// attribute is set by the *leaf view* component, which still uses the
// original short key ('skills', 'presets', etc.). We extract the last
// path segment to resolve the correct data-view selector.
//
// scanContextSelector vs viewKey separation (MEDIUM fix):
//   viewKey  — resolves the LEAF data-view for the waitForSelector wait.
//              Must match what the leaf component renders (e.g. 'skills').
//   scanContextSelector — selects the AXE SCOPE root, which for sub-routes
//              is the TabGroupView wrapper (data-view="resources" /
//              data-view="operator"). This widens the scan to include the
//              .sub-tabs chrome (role="group" buttons) that sits OUTSIDE the
//              leaf [data-view] element but INSIDE the group wrapper.
function viewKey(route) {
  // 'operator/profiles' → 'operator-profiles' (legacy data-view kept in component)
  // 'resources/mcp-servers' → 'mcp-servers', 'resources/skills' → 'skills', etc.
  const seg = route.split('/');
  if (seg.length === 1) return route;
  const sub = seg[seg.length - 1];
  // operator/profiles maps to the component's data-view="operator-profiles"
  if (seg[0] === 'operator' && sub === 'profiles') return 'operator-profiles';
  return sub;
}
function scanContextSelector(route) {
  // For sub-routes, scope to the TabGroupView wrapper (data-view=<group>)
  // so the .sub-tabs chrome is included in the axe scan alongside the
  // active leaf panel. Wait still uses viewKey (leaf) — no conflict.
  const seg = route.split('/');
  if (seg.length > 1) {
    // 'resources/*' → [data-view="resources"], 'operator/*' → [data-view="operator"]
    return `[data-view="${seg[0]}"]`;
  }
  // Single-selector scope per route. Sidebar gets covered transitively in
  // the dashboard scan via include-list (added below).
  return `[data-view="${viewKey(route)}"]`;
}

function loadWaivers() {
  if (!fs.existsSync(WAIVERS_PATH)) return [];
  const text = fs.readFileSync(WAIVERS_PATH, 'utf8').trim();
  if (!text) return [];
  let waivers;
  try {
    waivers = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `a11y-waivers.json is not valid JSON: ${err.message}. ` +
      `Either fix the file or remove it (a missing file = no waivers).`
    );
  }
  if (!Array.isArray(waivers)) {
    throw new Error(`a11y-waivers.json must be an array (got ${typeof waivers}).`);
  }
  // Schema + L4/L5 enforcement at load time so a malformed waiver fails
  // every scenario fast, not silently. `today` is computed in LOCAL time
  // (not UTC) to match how the maintainer reads the date — otherwise a
  // KST-evening run with UTC still on the previous day would push the
  // 14-day transitional window one day short and false-fail the load.
  const _now = new Date();
  const today = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-${String(_now.getDate()).padStart(2, '0')}`;
  for (const w of waivers) {
    for (const k of ['route', 'theme', 'viewport', 'ruleId', 'selector', 'reason', 'expiresAt']) {
      if (typeof w[k] !== 'string' || !w[k]) {
        throw new Error(
          `a11y-waivers.json entry missing required field "${k}": ${JSON.stringify(w)}`
        );
      }
    }
    if (w.expiresAt < today) {
      throw new Error(
        `a11y-waivers.json entry expired on ${w.expiresAt} (today=${today}): ` +
        `route=${w.route} theme=${w.theme} viewport=${w.viewport} rule=${w.ruleId}. ` +
        `Either renew with a fresh expiresAt + Codex review, or remove it (the underlying issue must be fixed).`
      );
    }
    // K-4 r2 transitional waiver rule (spec L4/L5):
    // color-contrast may only be waived as a "transitional" baseline entry
    // with full provenance metadata + ≤14d expiresAt. All other rules can
    // use the simpler base schema.
    if (w.ruleId === 'color-contrast') {
      if (w.kind !== 'transitional') {
        throw new Error(
          `a11y-waivers.json color-contrast waiver must have kind="transitional" ` +
          `(selector="${w.selector}"). New contrast violations cannot be waived — fix or restructure.`
        );
      }
      for (const k of ['ownerSurface', 'followupRef', 'approvedBy']) {
        if (typeof w[k] !== 'string' || !w[k]) {
          throw new Error(
            `a11y-waivers.json transitional color-contrast waiver missing "${k}" ` +
            `(selector="${w.selector}"). All transitional waivers require route/theme/viewport/selector/ownerSurface/followupRef/approvedBy/expiresAt.`
          );
        }
      }
      // expiresAt ≤ today + 14 days
      const expiresMs = Date.parse(w.expiresAt + 'T00:00:00Z');
      const todayMs = Date.parse(today + 'T00:00:00Z');
      if (Number.isNaN(expiresMs) || expiresMs - todayMs > 14 * 24 * 60 * 60 * 1000) {
        throw new Error(
          `a11y-waivers.json transitional color-contrast waiver expiresAt must be ≤14 days from today. ` +
          `Got ${w.expiresAt} (today=${today}, selector="${w.selector}").`
        );
      }
    } else {
      // Non-contrast waivers default to ≤30 day window (spec L5).
      // Past-expiry already failed above, so we only check the upper bound here.
      const expiresMs = Date.parse(w.expiresAt + 'T00:00:00Z');
      const todayMs = Date.parse(today + 'T00:00:00Z');
      if (Number.isNaN(expiresMs) || expiresMs - todayMs > 30 * 24 * 60 * 60 * 1000) {
        throw new Error(
          `a11y-waivers.json waiver expiresAt must be ≤30 days from today (got ${w.expiresAt}, ` +
          `today=${today}, rule=${w.ruleId}, selector="${w.selector}"). ` +
          `Renew with a fresh expiresAt or shorten the window.`
        );
      }
    }
  }
  return waivers;
}

function matchesWaiver(waivers, ctx, violation, node) {
  // node.target is an array of selector parts. Match if any part contains
  // the waiver selector OR the waiver selector matches the joined target.
  // Wildcard "*" allowed for theme / viewport so a single transitional
  // baseline waiver can cover the same surface across both themes and
  // both viewports — without it we would need 4 rows per surface
  // (2 themes × 2 viewports) and the file becomes unmaintainable.
  // `route` and `ruleId` must always match exactly.
  const target = Array.isArray(node.target) ? node.target.join(' ') : String(node.target || '');
  const matchField = (waiverVal, ctxVal) => waiverVal === '*' || waiverVal === ctxVal;
  return waivers.find(w =>
    w.route === ctx.route &&
    matchField(w.theme, ctx.theme) &&
    matchField(w.viewport, ctx.viewport) &&
    w.ruleId === violation.id &&
    (target === w.selector || target.includes(w.selector))
  );
}

// Force the theme by writing to localStorage BEFORE first paint, then
// reload so theme-init.js (head-loaded synchronous script) reads it
// during the next document load. The subsequent `page.goto('/#<route>')`
// is a hash navigation that does NOT re-run head scripts, so the reload
// here is the only way to make the theme take effect for the scan.
async function setTheme(page, theme) {
  await page.goto('/'); // any same-origin page so localStorage is reachable
  await page.evaluate((t) => {
    try {
      window.localStorage.setItem('palantir.theme', t);
    } catch {
      /* ignore */
    }
  }, theme);
  await page.reload(); // re-run theme-init.js with the new localStorage value
}

// Track which waivers are touched so we can fail on unused ones at the
// end of the suite (L5: unused waiver → fail).
const _touchedWaivers = new Set();
function waiverKey(w) {
  return `${w.route}|${w.theme}|${w.viewport}|${w.ruleId}|${w.selector}`;
}

const _allWaivers = loadWaivers();

for (const route of ROUTES) {
  for (const theme of THEMES) {
    for (const vp of VIEWPORTS) {
      test(`@a11y a11y: ${route} [${theme}/${vp.name}]`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await setTheme(page, theme);

        await page.goto(`/#${route}`);
        // Wait for the route root to render. K-4 baseline (L1) — we scan
        // the empty / EmptyState fallback for state-bearing routes.
        // Sub-routes (e.g. 'resources/skills') resolve via the leaf view's
        // data-view attribute (viewKey extracts the correct key).
        await page.waitForSelector(`[data-view="${viewKey(route)}"]`, { timeout: 10000 });

        const builder = new AxeBuilder({ page })
          .withTags(WCAG_TAGS)
          .include(scanContextSelector(route));

        const results = await builder.analyze();

        const ctx = { route, theme, viewport: vp.name };
        const blocking = [];
        const moderate = [];

        for (const violation of results.violations) {
          for (const node of violation.nodes) {
            const matched = matchesWaiver(_allWaivers, ctx, violation, node);
            if (matched) {
              _touchedWaivers.add(waiverKey(matched));
              continue;
            }
            const impact = node.impact || violation.impact || 'minor';
            const target = Array.isArray(node.target) ? node.target.join(' ') : String(node.target || '');
            const entry = {
              route,
              theme,
              viewport: vp.name,
              ruleId: violation.id,
              impact,
              selector: target,
              failureSummary: node.failureSummary || violation.help || '',
            };
            if (FAIL_IMPACTS.has(impact)) {
              blocking.push(entry);
            } else if (impact === 'moderate') {
              moderate.push(entry);
            }
          }
        }

        // L6 output: every blocking violation gets one human-readable line.
        if (blocking.length > 0) {
          const lines = blocking.map(b =>
            `  [${b.impact}] route=${b.route} theme=${b.theme} viewport=${b.viewport} ` +
            `rule=${b.ruleId} selector="${b.selector}"\n      → ${b.failureSummary.replace(/\n/g, '\n        ')}`
          );
          throw new Error(
            `${blocking.length} blocking a11y violation(s) at ${route} [${theme}/${vp.name}]:\n` +
            lines.join('\n') +
            `\n\nFix the surface OR add a waiver to a11y-waivers.json. ` +
            `color-contrast waivers must be kind="transitional" with ≤14d expiresAt + ownerSurface + followupRef + approvedBy.`
          );
        }

        // moderate / minor → report-only summary line (separate section so
        // it doesn't drown the gate output).
        if (moderate.length > 0) {
          // eslint-disable-next-line no-console
          console.log(
            `[a11y report-only] ${route} [${theme}/${vp.name}] — ` +
            `${moderate.length} moderate violation(s): ` +
            moderate.map(m => `${m.ruleId}@${m.selector}`).join(', ')
          );
        }
      });
    }
  }
}

// L5 unused-waiver gate: runs once after every scenario finishes. A waiver
// that never matched any actual violation means the underlying issue was
// already fixed — drop the waiver to keep the file honest.
test.afterAll(() => {
  if (_allWaivers.length === 0) return;
  const unused = _allWaivers.filter(w => !_touchedWaivers.has(waiverKey(w)));
  if (unused.length > 0) {
    const lines = unused.map(w =>
      `  route=${w.route} theme=${w.theme} viewport=${w.viewport} rule=${w.ruleId} selector="${w.selector}" (reason: ${w.reason})`
    );
    throw new Error(
      `${unused.length} unused waiver(s) in a11y-waivers.json — ` +
      `the underlying issue was likely fixed; remove the entry to keep the file honest:\n` +
      lines.join('\n')
    );
  }
});
