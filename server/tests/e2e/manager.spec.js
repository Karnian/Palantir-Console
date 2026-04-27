const { test, expect } = require('@playwright/test');

// ─────────────────────────────────────────────────────────────────────────────
// P8-7: Manager View E2E — static structure & navigation
//
// These tests verify the Manager view renders correctly WITHOUT needing a
// real Claude/Codex CLI. They cover layout structure, navigation, element
// visibility, and ARIA attributes. The server is started via playwright.config
// webServer (port 4177, reuses existing in dev).
//
// The tests are written to be resilient to pre-existing server state: the
// server may or may not have an active manager session, tasks, and agents.
// Tests branch on /api/manager/status where needed.
// ─────────────────────────────────────────────────────────────────────────────

const BASE = 'http://localhost:4177';

test.describe('Manager View Structure', () => {

  test('navigating to #manager renders the manager-view layout', async ({ page }) => {
    await page.goto('/#manager');
    // The top-level container must be present
    const view = page.locator('.manager-view');
    await expect(view).toBeVisible();
    // Two-panel layout: chat side + grid side
    await expect(view.locator('.manager-chat-side')).toBeVisible();
    await expect(view.locator('.manager-grid-side')).toBeVisible();
  });

  test('manager view has chat header with title and status badge', async ({ page, request }) => {
    const statusRes = await request.get(`${BASE}/api/manager/status`);
    const status = await statusRes.json();

    await page.goto('/#manager');
    const header = page.locator('.manager-chat-header');
    await expect(header).toBeVisible();
    // Phase K-1a: panel title flipped to Korean — "매니저 세션".
    await expect(header.locator('.manager-panel-title')).toContainText('매니저 세션');
    // Status badge reflects current state
    const badge = header.locator('.manager-status-badge');
    await expect(badge).toBeVisible();
    if (status.active) {
      await expect(badge).toHaveText('활성');
    } else {
      await expect(badge).toHaveText('대기 중');
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
      await expect(empty.locator('.manager-empty-text')).toContainText(
        '매니저 세션을 시작해 에이전트를 조율하세요'
      );
    }
    // When active, messages area is still present (may contain chat bubbles)
  });

  test('session grid panel renders with "작업 세션" header', async ({ page }) => {
    await page.goto('/#manager');
    const gridSide = page.locator('.manager-grid-side');
    await expect(gridSide).toBeVisible();
    // Header inside the grid side. Phase K-1a flipped to Korean.
    const gridHeader = gridSide.locator('.manager-grid-header');
    await expect(gridHeader).toBeVisible();
    await expect(gridHeader.locator('h3')).toHaveText('작업 세션');
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

  test('session grid stats bar shows run counters', async ({ page }) => {
    await page.goto('/#manager');
    const stats = page.locator('.manager-grid-stats');
    await expect(stats).toBeVisible();
    // Stats bar always shows running/waiting/failed counters.
    // Phase K-1a: copy flipped to Korean.
    await expect(stats).toContainText('실행 중');
    await expect(stats).toContainText('대기');
    await expect(stats).toContainText('실패');
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
      // Picker group renders with the agent select
      const picker = page.locator('.manager-picker[role="group"]');
      await expect(picker).toBeVisible({ timeout: 5000 });
      // Phase K-1a: aria-label is now Korean. The empty-state copy still
      // ships the original English string — `K-1a` brief scopes manager
      // chat picker only; that downstream message moves with K-1b.
      await expect(picker).toHaveAttribute('aria-label', 'Manager agent picker');
      await expect(picker.locator('#manager-profile-select')).toBeVisible();
    } else {
      // No manager-capable agents — empty prompt with link to Agents page
      const emptyMsg = page.locator('.manager-picker-empty');
      await expect(emptyMsg).toBeVisible({ timeout: 5000 });
      await expect(emptyMsg).toContainText('No Claude Code or Codex agents registered');
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
    // Phase K-1a: Start Manager button now reads "매니저 시작" in Korean.
    const startBtn = page.locator('button', { hasText: '매니저 시작' });
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
});
