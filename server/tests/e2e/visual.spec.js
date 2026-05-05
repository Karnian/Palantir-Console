// Phase K-5 (2026-04-29): visual regression automation.
//
// Spec lock-in: docs/specs/k5-visual-regression-brief.md
//
// Matrix: 8 hash routes × 2 themes (dark/light) × 2 viewports (1280×800 desktop,
// 375×667 mobile) = 32 screenshot scenarios. Tagged @visual so
// `npm run test:visual` can grep.
//
// Stabilization (spec L8-L11):
//   - reducedMotion enforced via playwright.config.js
//   - CSS injection disables remaining animations + hides scrollbars
//   - document.fonts.ready awaited before screenshot
//   - dynamic surfaces (timestamps, claude-session-item, manager status badge)
//     are masked
//
// Threshold (L3): maxDiffPixels: 100, threshold: 0.2 — adjust after first
// real run if noise floor differs.

const { test, expect } = require('@playwright/test');

const ROUTES = [
  'dashboard',
  'manager',
  'board',
  'projects',
  'agents',
  'skills',
  'presets',
  'mcp-servers',
];
const THEMES = ['dark', 'light'];
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 375, height: 667 },
];

// L9 + L11: kill remaining motion + hide scrollbars so the screenshot is
// identical across runs. `prefers-reduced-motion` is set globally via
// playwright.config.js, but a few inline transitions still apply (e.g.
// dropdown / toast). The injected style sheet is the deterministic
// belt-and-suspenders.
const STABILIZE_CSS = `
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
    caret-color: transparent !important;
  }
  /* L9: hide every scrollbar so macOS overlay scrollbars never differ
     between runs depending on hover state. */
  ::-webkit-scrollbar { display: none !important; }
  * { scrollbar-width: none !important; -ms-overflow-style: none !important; }
`;

async function setTheme(page, theme) {
  await page.goto('/');
  await page.evaluate((t) => {
    try { window.localStorage.setItem('palantir.theme', t); } catch { /* ignore */ }
  }, theme);
  await page.reload();
}

async function stabilize(page) {
  await page.addStyleTag({ content: STABILIZE_CSS });
  // L8: wait until web fonts (self-hosted Inter) finish loading; otherwise
  // the first screenshot captures the fallback font and every subsequent
  // PR is a guaranteed regression.
  await page.evaluate(() => document.fonts && document.fonts.ready);
}

// L10 dynamic surface masks. Each entry is a CSS selector whose region
// will be painted black in both baseline and actual, so timestamp drift /
// SSE list reorder / status badge rotation never trips the diff.
//
// Leaf-text rule (K-5 NIT, 2026-05-05): mask selectors must target the
// *leaf* element that actually renders the volatile text — never the
// container that may also render an EmptyState fallback. Otherwise the
// fallback is masked and we lose its visual regression coverage entirely.
// Concretely:
//   - DO scope to children: `.triage-feed > .triage-item` (not the feed)
//   - DO put `data-visual-mask="true"` on the leaf div / span that prints
//     the timestamp, never on the surrounding card
//   - DON'T add a class-level mask to a section that conditionally swaps
//     between dynamic content and an EmptyState
function dynamicMasks(page) {
  return [
    page.locator('.claude-session-item'),
    page.locator('.timestamp'),
    page.locator('.relative-time'),
    page.locator('.manager-status-badge'),
    page.locator('.triage-feed > .triage-item'),
    // Explicit `data-visual-mask="true"` opt-in for leaf surfaces that
    // render server-time-ish values (e.g. `updated_at` in mcp-servers).
    // Components mark the leaf element with the attribute so this list
    // stays selector-stable as new dynamic surfaces appear.
    page.locator('[data-visual-mask="true"]'),
  ];
}

for (const route of ROUTES) {
  for (const theme of THEMES) {
    for (const vp of VIEWPORTS) {
      test(`@visual ${route} [${theme}/${vp.name}]`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await setTheme(page, theme);
        await page.goto(`/#${route}`);
        await page.waitForSelector(`[data-view="${route}"]`, { timeout: 10000 });
        await stabilize(page);

        await expect(page).toHaveScreenshot(
          `${route}-${theme}-${vp.name}.png`,
          {
            fullPage: true,
            maxDiffPixels: 100,
            threshold: 0.2,
            mask: dynamicMasks(page),
          },
        );
      });
    }
  }
}
