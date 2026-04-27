const { test, expect } = require('@playwright/test');

// ─────────────────────────────────────────────────────────────────────────────
// Manager View E2E — static structure & navigation
//
// PostK-e2e-migrate (2026-04-27): selectors switched from text-based
// (`'매니저 시작'` / `'활성'` / etc.) to attribute selectors
// (`[data-action="start-manager"]`, `[data-state="running"]`,
// `[data-view="manager"]`). The K-low phases will keep flipping copy
// to Korean across remaining views; locking these tests to attributes
// means each future copy revision is one find-and-replace in
// `app/lib/copy.js` instead of e2e regression cleanup.
//
// Tests verify the Manager view renders correctly WITHOUT needing a
// real Claude/Codex CLI. They cover layout structure, navigation,
// element visibility, and ARIA attributes. The server is started via
// playwright.config webServer (port 4177, reuses existing in dev).
//
// The tests are written to be resilient to pre-existing server state:
// the server may or may not have an active manager session, tasks, and
// agents. Tests branch on /api/manager/status where needed.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = 'http://localhost:4177';

test.describe('Manager View Structure', () => {

  test('navigating to #manager renders the manager-view layout', async ({ page }) => {
    await page.goto('/#manager');
    // Route wrapper carries data-view="manager" — copy-agnostic.
    const view = page.locator('[data-view="manager"]');
    await expect(view).toBeVisible();
    // Two-panel layout: chat side + grid side
    await expect(view.locator('.manager-chat-side')).toBeVisible();
    await expect(view.locator('.manager-grid-side')).toBeVisible();
  });

  test('manager view has chat header with status badge', async ({ page, request }) => {
    const statusRes = await request.get(`${BASE}/api/manager/status`);
    const status = await statusRes.json();

    await page.goto('/#manager');
    const header = page.locator('.manager-chat-header');
    await expect(header).toBeVisible();
    // Panel title region exists (copy may evolve — visibility is the contract)
    await expect(header.locator('.manager-panel-title')).toBeVisible();
    // Status badge reflects current state via data-state ('running'|'idle')
    const badge = header.locator('.manager-status-badge');
    await expect(badge).toBeVisible();
    if (status.active) {
      await expect(badge).toHaveAttribute('data-state', 'running');
    } else {
      await expect(badge).toHaveAttribute('data-state', 'idle');
    }
  });

  test('manager chat-side renders messages area or empty state', async ({ page, request }) => {
    const statusRes = await request.get(`${BASE}/api/manager/status`);
    const status = await statusRes.json();

    await page.goto('/#manager');
    const chatSide = page.locator('.manager-chat-side');
    await expect(chatSide).toBeVisible();

    // Messages container always exists
    const messages = chatSide.locator('.manager-messages');
    await expect(messages).toBeVisible();

    if (!status.active) {
      // When idle, empty state shows the start prompt
      const empty = messages.locator('.manager-empty');
      await expect(empty).toBeVisible();
      await expect(empty.locator('.manager-empty-icon')).toBeVisible();
      // We assert the empty-text region is present, not its exact wording.
      await expect(empty.locator('.manager-empty-text')).toBeVisible();
    }
    // When active, messages area is still present (may contain chat bubbles)
  });

  test('session grid panel renders', async ({ page }) => {
    await page.goto('/#manager');
    const gridSide = page.locator('.manager-grid-side');
    await expect(gridSide).toBeVisible();
    // Header inside the grid side. Heading text is copy.js-driven, so we
    // only check that the heading renders.
    const gridHeader = gridSide.locator('.manager-grid-header');
    await expect(gridHeader).toBeVisible();
    await expect(gridHeader.locator('h3')).toBeVisible();
  });

  test('session grid body renders (tasks or empty state)', async ({ page }) => {
    await page.goto('/#manager');
    const gridBody = page.locator('.manager-grid-side .manager-grid-body');
    await expect(gridBody).toBeVisible();
    // Grid body always renders — content depends on existing tasks.
    // If tasks exist, project groups render. If not, EmptyState shows.
    // We just verify the container is present and non-empty.
    const text = await gridBody.textContent();
    expect(text.length).toBeGreaterThan(0);
  });

  test('session grid stats bar shows run counters by data-stat', async ({ page }) => {
    await page.goto('/#manager');
    const stats = page.locator('.manager-grid-stats');
    await expect(stats).toBeVisible();
    // Each counter exposes data-stat="running|waiting|failed". Numeric
    // value depends on live server state, so we only assert each
    // counter pill is present.
    await expect(stats.locator('[data-stat="running"]')).toBeVisible();
    await expect(stats.locator('[data-stat="waiting"]')).toBeVisible();
    await expect(stats.locator('[data-stat="failed"]')).toBeVisible();
  });
});

test.describe('Manager Agent Picker (idle state)', () => {
  // The agent picker and Start Manager button only render when no session
  // is active (!status.active). These tests skip when a session is live.

  test('shows agent picker or empty message when idle', async ({ page, request }) => {
    const statusRes = await request.get(`${BASE}/api/manager/status`);
    const status = await statusRes.json();
    test.skip(status.active, 'Manager session is active — picker not rendered');

    const agentsRes = await request.get(`${BASE}/api/agents`);
    const { agents } = await agentsRes.json();
    const managerTypes = ['claude-code', 'codex'];
    const hasManagerAgents = agents.some(a => managerTypes.includes(a.type));

    await page.goto('/#manager');

    if (hasManagerAgents) {
      // Picker group renders with the agent select. We only check
      // structural shape (role="group" + the select id) — the
      // aria-label phrasing is owned by app/lib/copy.js and may
      // evolve in K-low without regressing this test (Codex PostK NIT).
      const picker = page.locator('.manager-picker[role="group"]');
      await expect(picker).toBeVisible({ timeout: 5000 });
      await expect(picker.locator('#manager-profile-select')).toBeVisible();
    } else {
      // No manager-capable agents — empty prompt is rendered. Don't
      // assert exact phrasing (K-low-1 will localise it); just check
      // structure: the empty container + the "go to agents" link.
      const emptyMsg = page.locator('.manager-picker-empty');
      await expect(emptyMsg).toBeVisible({ timeout: 5000 });
      await expect(emptyMsg.locator('a[href="#agents"]')).toBeVisible();
    }
  });

  test('Start Manager button is present when idle with agents', async ({ page, request }) => {
    const statusRes = await request.get(`${BASE}/api/manager/status`);
    const status = await statusRes.json();
    test.skip(status.active, 'Manager session is active — Start button not rendered');

    const agentsRes = await request.get(`${BASE}/api/agents`);
    const { agents } = await agentsRes.json();
    const managerTypes = ['claude-code', 'codex'];
    const hasManagerAgents = agents.some(a => managerTypes.includes(a.type));
    test.skip(!hasManagerAgents, 'No manager-capable agents — Start button not rendered');

    await page.goto('/#manager');
    // Wait for picker to load
    await page.locator('.manager-picker[role="group"]').waitFor({ state: 'visible', timeout: 5000 });
    // Selector is data-action, copy-agnostic.
    const startBtn = page.locator('[data-action="start-manager"]');
    await expect(startBtn).toBeVisible();
    await expect(startBtn).toHaveClass(/btn-primary/);
  });
});

test.describe('Manager Active State', () => {
  // These tests verify UI elements that appear only when a session IS active.

  test('conversation target dropdown renders when active', async ({ page, request }) => {
    const statusRes = await request.get(`${BASE}/api/manager/status`);
    const status = await statusRes.json();
    test.skip(!status.active, 'No active manager session — dropdown not rendered');

    await page.goto('/#manager');
    // The conversation picker dropdown (Top/PM selector) should be visible
    const picker = page.locator('.manager-picker-select');
    await expect(picker).toBeVisible({ timeout: 5000 });
  });

  test('input area renders when active', async ({ page, request }) => {
    const statusRes = await request.get(`${BASE}/api/manager/status`);
    const status = await statusRes.json();
    test.skip(!status.active, 'No active manager session — input area not rendered');

    await page.goto('/#manager');
    // Chat input area should be present
    const inputArea = page.locator('.manager-input-area');
    await expect(inputArea).toBeVisible({ timeout: 5000 });
  });

  test('stop top manager button is present when active', async ({ page, request }) => {
    const statusRes = await request.get(`${BASE}/api/manager/status`);
    const status = await statusRes.json();
    test.skip(!status.active, 'No active manager session — stop button not rendered');

    await page.goto('/#manager');
    // data-action selector — copy-agnostic.
    const stopBtn = page.locator('[data-action="stop-top"]');
    await expect(stopBtn).toBeVisible({ timeout: 5000 });
  });
});
