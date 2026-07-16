// Phase K-5 (2026-04-29): visual regression automation.
//
// Spec lock-in: docs/specs/k5-visual-regression-brief.md
//
// Matrix: 14 hash routes × 2 themes (dark/light) × 2 viewports (1280×800 desktop,
// 375×667 mobile) = 56 screenshot scenarios. Tagged @visual so
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
  // Manager is intentionally absent from top-level nav but remains routable
  // from the Master card and operator conversation deep links.
  'manager',
  'board',
  'operator/codebases',
  'agents',
  'resources/skills',
  'resources/presets',
  'resources/mcp-servers',
  'resources/models',
  'resources/nodes',
  // U-2: node detail not-found state — deterministic (no probe, no data)
  'resources/nodes/ghost-e2e',
  'memory',
  'operator/roster',
  'operator/specialist',
  'operator/profiles',
];
const THEMES = ['dark', 'light'];

// For consolidated sub-routes the data-view attribute is set by the leaf
// view component (still using the original short key). Extract the correct
// data-view key from the route string.
function viewKey(route) {
  const seg = route.split('/');
  if (seg.length === 1) return route;
  const sub = seg[seg.length - 1];
  if (seg[0] === 'operator' && sub === 'roster') return 'operator-roster';
  if (seg[0] === 'operator' && seg[1] === 'codebases') return 'projects';
  if (seg[0] === 'operator' && sub === 'profiles') return 'operator-profiles';
  if (seg[0] === 'resources' && seg[1] === 'nodes' && seg.length === 3) return 'nodes';
  if (seg[0] === 'resources' && sub === 'models') return 'model-policies';
  return sub;
}
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
        await page.waitForSelector(`[data-view="${viewKey(route)}"]`, { timeout: 10000 });
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

// K-5-followup: interactive-state (hover + keyboard-focus) visual regression for
// the NavSidebar's keyboard/pointer affordances. Both affordances render OUTSIDE
// the triggering element's own box — the nav-item fly-out tooltip at
// `left: calc(100% + 8px)`, and the "skip to content" link that only paints on
// keyboard focus — so an element-bbox screenshot would clip exactly what we want
// to guard. Instead we screenshot a FIXED top-of-sidebar CLIP region spanning
// the rail + the fly-out zone. It is app-shell chrome, so it renders the same on
// the fresh-DB visual server regardless of data. Route `#board` keeps the first
// nav item (dashboard) NON-active so the hover styling isn't masked by the
// active treatment. Desktop only — these are pointer/keyboard states, and the
// sidebar collapses to a bottom bar on mobile.
const SIDEBAR_CLIP = { x: 0, y: 0, width: 200, height: 220 };
async function gotoShell(page, theme) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await setTheme(page, theme);
  await page.goto('/#board');
  await page.waitForSelector('.nav-sidebar', { timeout: 10000 });
  await stabilize(page);
}
for (const theme of THEMES) {
  // Hovering a non-active nav item reveals its fly-out tooltip — the pointer
  // affordance. Guards the tooltip position/styling + the hover background.
  test(`@visual interactive: navitem hover [${theme}]`, async ({ page }) => {
    await gotoShell(page, theme);
    await page.locator('.nav-sidebar .nav-item').first().hover();
    await expect(page).toHaveScreenshot(`interactive-navitem-hover-${theme}.png`, {
      clip: SIDEBAR_CLIP,
      maxDiffPixels: 100,
      threshold: 0.2,
    });
  });

  // The first keyboard Tab from a fresh load surfaces the "skip to content"
  // link (`:focus-visible`; a programmatic `.focus()` would NOT match it in
  // Chromium). Guards that keyboard-only affordance — invisible until focused,
  // so trivially easy to regress unnoticed.
  test(`@visual interactive: skiplink focus [${theme}]`, async ({ page }) => {
    await gotoShell(page, theme);
    // Park the pointer well OUTSIDE SIDEBAR_CLIP (width 200) so no stray :hover
    // bleeds into the focus capture.
    await page.mouse.move(900, 400);
    await page.keyboard.press('Tab');
    // Make the first-Tab contract explicit: the skip link must be the first
    // focusable. Fails loudly (not just as a pixel diff) if the tab order shifts.
    await expect(page.locator('.skip-link')).toBeFocused();
    await expect(page).toHaveScreenshot(`interactive-skiplink-focus-${theme}.png`, {
      clip: SIDEBAR_CLIP,
      maxDiffPixels: 100,
      threshold: 0.2,
    });
  });
}

// K-5-followup: scope captures to the open dialog so backdrop/page changes do
// not couple these baselines to the underlying route; visibility fails loudly
// if the opening interaction ever regresses.
const MODALS = [
  {
    slug: 'commandpalette',
    dialog: '.command-palette',
    async open(page) {
      await page.goto('/#board');
      await page.waitForSelector('.nav-sidebar', { timeout: 10000 });
      await stabilize(page);
      await page.keyboard.press('Control+k');
    },
  },
  {
    slug: 'newagent',
    dialog: '[role="dialog"][aria-modal="true"]',
    async open(page) {
      await page.goto('/#agents');
      await page.waitForSelector('[data-view="agents"]', { timeout: 10000 });
      await stabilize(page);
      await page.getByRole('button', { name: /새 에이전트/ }).click();
    },
  },
];

for (const modal of MODALS) {
  for (const theme of THEMES) {
    test(`@visual modal: ${modal.slug} [${theme}]`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await setTheme(page, theme);
      await modal.open(page);

      const dialog = page.locator(modal.dialog);
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveScreenshot(`modal-${modal.slug}-${theme}.png`, {
        maxDiffPixels: 100,
        threshold: 0.2,
      });
    });
  }
}

// K-5-followup: the drawer is data-gated, so open it via a mocked drift API;
// `.drift-row-time` is the only dynamic surface and is masked.
const DRIFT_FIXTURE = { audit: [{
  id: 'drift-fixture-1',
  incoherence_kind: 'pm_hallucination',
  project_id: 'proj-fixture',
  created_at: '2026-01-01T00:00:00.000Z',
  pm_claim: JSON.stringify({ status: 'completed' }),
  db_truth: JSON.stringify({ status: 'running' }),
  pm_run_id: 'run-fixture-1',
  rationale: 'Operator claimed the task was done but the run is still active.',
}] };

for (const theme of THEMES) {
  test(`@visual drawer: drift [${theme}]`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.route('**/api/dispatch-audit*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DRIFT_FIXTURE) }));
    await setTheme(page, theme);
    await page.goto('/#dashboard');
    await page.waitForSelector('[data-view="dashboard"]', { timeout: 10000 });
    await stabilize(page);
    await page.getByRole('button', { name: /드리프트 경고/ }).click();

    const drawer = page.locator('.drift-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveScreenshot(`drawer-drift-${theme}.png`, {
      maxDiffPixels: 100,
      threshold: 0.2,
      mask: [drawer.locator('.drift-row-time')],
    });
  });
}

// K-5-followup: the panel is data-gated, so open it via mocked run APIs + the
// `#run/:id` route; dynamic surfaces (relative times) are masked.
const RUN_FIXTURE = {
  run: {
    id: 'run-fixture-1',
    task_title: 'Deterministic completed fixture run',
    status: 'completed',
    agent_name: 'Fixture Agent',
    created_at: '2026-01-01T00:00:00.000Z',
    node_id: null,
    result_summary: 'Completed successfully with deterministic output.',
    worktree_path: null,
    project_id: 'project-fixture-1',
    parent_run_id: null,
    preset_id: null,
    is_manager: 0,
    cost_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
  },
  output: 'Fixture command started.\nAll deterministic checks passed.\nRun completed successfully.',
};

for (const theme of THEMES) {
  test(`@visual inspector: run [${theme}]`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.route('**/api/runs**', (route) => {
      const url = route.request().url();
      if (/\/api\/runs\/[^/?]+\/output/.test(url)) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ output: RUN_FIXTURE.output }) });
      }
      if (/\/api\/runs\/[^/?]+\/events/.test(url)) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ events: [] }) });
      }
      if (/\/api\/runs\/[^/?]+(\?|$)/.test(url)) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ run: RUN_FIXTURE.run }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runs: [RUN_FIXTURE.run] }) });
    });
    await page.route('**/api/nodes/summary', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ nodes: [], queued: [] }) }));
    await page.route('**/api/projects/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ project: { id: RUN_FIXTURE.run.project_id, test_command: null } }) }));
    await setTheme(page, theme);
    await page.goto('/#run/run-fixture-1');
    await page.waitForSelector('.run-inspector-slideover', { timeout: 10000 });
    await stabilize(page);

    const panel = page.locator('.run-inspector-slideover');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(RUN_FIXTURE.run.task_title);
    await expect(panel).toHaveScreenshot(`inspector-run-${theme}.png`, {
      maxDiffPixels: 100,
      threshold: 0.2,
      mask: [panel.locator('.run-status-started')],
    });
  });
}

// K-5-followup: the remaining deterministic form modals are opened by their
// header "+ New" button; element-scoped dialog screenshots need no mocks/masks.
const FORM_MODALS = [
  { slug: 'newcodebase', route: 'operator/codebases', view: 'projects', trigger: /새 코드베이스/, dialog: '[aria-labelledby="new-project-title"]' },
  { slug: 'newmcp', route: 'resources/mcp-servers', view: 'mcp-servers', trigger: /새 MCP 서버/, dialog: '[aria-labelledby="mcp-template-title"]' },
  { slug: 'newtask', route: 'board', view: 'board', trigger: /새 작업/, dialog: '[aria-labelledby="new-task-title"]' },
];

for (const modal of FORM_MODALS) {
  for (const theme of THEMES) {
    test(`@visual formmodal: ${modal.slug} [${theme}]`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await setTheme(page, theme);
      await page.goto(`/#${modal.route}`);
      await page.waitForSelector(`[data-view="${modal.view}"]`, { timeout: 10000 });
      await stabilize(page);
      await page.getByRole('button', { name: modal.trigger }).click();
      const dialog = page.locator(modal.dialog);
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveScreenshot(`modal-${modal.slug}-${theme}.png`, {
        maxDiffPixels: 100,
        threshold: 0.2,
      });
    });
  }
}
