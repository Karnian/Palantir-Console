const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { NOW } = require('../../helpers/work-board-fixture.cjs');

const viewports = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 375, height: 667 },
];

async function openBoard(page, theme, viewport) {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ colorScheme: theme });
  await page.clock.setFixedTime(new Date(NOW));
  await page.goto('/#work');
  await expect(page.locator('.work-card')).toHaveCount(3);
  await expect(page.getByRole('status').filter({ hasText: '세션 3개' })).toBeVisible();
  await expect(page.locator('.nav-work-label')).toHaveText('작업');
  await expect(page.locator('.nav-work')).toHaveAccessibleName('작업');
  await expect(page.locator('.work-title')).toHaveText([
    '합성 세션 검토', '이미지 크기별 결과를 정리해 주세요.',
    '주간 보고 초안을 작성해 주세요.',
  ]);
  await expect(page.locator('.work-observation-note')).toHaveText('상태는 스냅샷 시점 관측');
  await expect(page.locator('.work-snapshot-times .work-pill')).toHaveCount(2);
  expect(await page.locator('.work-snapshot-times .work-pill').allTextContents()).toEqual([
    'Mac · 방금 스냅샷 · 10/10 12:00', 'codev2 · 5분 전 스냅샷 · 10/10 11:55',
  ]);
  await expect(page.locator('.work-orca')).toHaveText('Orca · 응답 대기');
  await expect(page.locator('.work-card').getByText('형식 미검증', { exact: true })).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
}

async function scan(page) {
  const report = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const blocked = report.violations.filter(violation => ['critical', 'serious', 'moderate'].includes(violation.impact));
  expect(blocked).toEqual([]);
}

for (const theme of ['light', 'dark']) {
  for (const viewport of viewports) {
    test(`${theme} ${viewport.name} board and common chrome @a11y @visual`, async ({ page }) => {
      await openBoard(page, theme, viewport);
      await scan(page);
      await expect(page).toHaveScreenshot(`work-${theme}-${viewport.name}.png`, {
        fullPage: true, animations: 'disabled', maxDiffPixels: 100, threshold: 0.2,
        mask: [page.locator('.nav-status')],
      });
      const cards = page.locator('.work-card');
      await cards.first().getByRole('button', { name: '타임라인', exact: true }).click();
      await expect(page.locator('.work-event')).toHaveCount(2);
      await scan(page);
      await expect(page).toHaveScreenshot(`timeline-${theme}-${viewport.name}.png`, {
        fullPage: true, animations: 'disabled', maxDiffPixels: 100, threshold: 0.2,
        mask: [page.locator('.nav-status')],
      });
      await cards.first().getByRole('button', { name: '타임라인 접기', exact: true }).click();
      await page.getByLabel('지시 검색', { exact: true }).fill('로그인리다');
      await expect(cards).toHaveCount(1);
      await expect(cards.locator('.work-title')).toHaveText('합성 세션 검토');
      await expect(page.locator('.work-match mark')).toHaveText('로그인 리다');
      await scan(page);
      await expect(page).toHaveScreenshot(`search-${theme}-${viewport.name}.png`, {
        fullPage: true, animations: 'disabled', maxDiffPixels: 100, threshold: 0.2,
        mask: [page.locator('.nav-status')],
      });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(overflow).toBe(false);
      for (const button of await page.locator('[data-view="work"] button').all()) {
        const box = await button.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
    });
  }
}

test('entry default, exact work route, nav and command palette preserve explicit paths', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/#work$/);
  await expect(page.locator('.work-card')).toHaveCount(3);
  await page.goto('/#dashboard');
  await expect(page.locator('[data-view="dashboard"]')).toBeVisible();
  await expect(page.locator('.nav-work')).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog').locator('.command-palette-label')
    .filter({ hasText: /^작업$/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto('/#work/child');
  await expect(page.locator('[data-view="dashboard"]')).toBeVisible();
  await expect(page).toHaveURL(/#work\/child$/);
  await expect(page.locator('[data-view="work"]')).toHaveCount(0);
});

test('partial detail failure keeps healthy cards and Korean coverage message', async ({ page }) => {
  await page.route('**/api/observe/snapshots/beta', route => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'internal_error' }),
  }));
  await page.goto('/#work');
  await expect(page.locator('.work-card')).toHaveCount(2);
  await expect(page.locator('.work-failure'))
    .toContainText('codev2 · 이 머신의 스냅샷을 읽지 못했습니다.');
  await expect(page.locator('[data-view="work"]')).not.toContainText('internal_error');
});

async function holdEntryProbe(page) {
  await page.clock.install({ time: new Date(NOW) });
  await page.clock.pauseAt(new Date(Date.parse(NOW) + 1000));
  let release, started, delivered;
  const gate = new Promise(resolve => { release = resolve; });
  const intercepted = new Promise(resolve => { started = resolve; });
  const responseSent = new Promise(resolve => { delivered = resolve; });
  let held = false;
  await page.route('**/api/observe/snapshots', async route => {
    if (held) return route.continue();
    held = true;
    started();
    await gate;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"snapshots":[]}' });
    delivered();
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.work-entry-loading')).toBeVisible();
  // Flush the first Preact effects while keeping the verdict pending.
  await page.clock.runFor(100);
  await intercepted;
  return async () => { release(); await responseSent; await page.clock.runFor(100); };
}

test('one-second verdict keeps the pending shell until work becomes the default', async ({ page }) => {
  const release = await holdEntryProbe(page);
  const shell = page.locator('.work-entry-loading');
  await expect(shell).toBeVisible();
  await expect(page.locator('[data-view="dashboard"]')).toHaveCount(0);
  await expect(page.locator('.nav-work')).toHaveCount(0);
  expect(await page.evaluate(() => location.hash)).toBe('');
  await page.clock.runFor(900);
  await expect(shell).toBeVisible();
  await expect(page.locator('[data-view="dashboard"]')).toHaveCount(0);
  await release();
  await expect(page).toHaveURL(/#work$/);
  await page.clock.runFor(100);
  await expect(page.locator('.work-card')).toHaveCount(3);
  await expect(page.locator('.nav-work')).toBeVisible();
  await expect(shell).toHaveCount(0);
});

test('two-second verdict falls back without a hash write and late on only adds nav', async ({ page }) => {
  const release = await holdEntryProbe(page);
  const shell = page.locator('.work-entry-loading');
  await expect(shell).toBeVisible();
  await expect(page.locator('[data-view="dashboard"]')).toHaveCount(0);
  await page.clock.runFor(1300);
  await expect(shell).toBeVisible();
  await expect(page.locator('[data-view="dashboard"]')).toHaveCount(0);
  await page.clock.runFor(200);
  const dashboard = page.locator('[data-view="dashboard"]');
  await expect(dashboard).toBeVisible();
  await expect(shell).toHaveCount(0);
  await expect(page.locator('.nav-work')).toHaveCount(0);
  expect(await page.evaluate(() => location.hash)).toBe('');
  const originalDashboard = await dashboard.elementHandle();
  await page.clock.runFor(400);
  await release();
  await expect(page.locator('.nav-work')).toBeVisible();
  await expect(dashboard).toBeVisible();
  expect(await originalDashboard.evaluate(element => element === document.querySelector('[data-view="dashboard"]')))
    .toBe(true);
  expect(await page.evaluate(() => location.hash)).toBe('');
  await expect(page.locator('[data-view="work"]')).toHaveCount(0);
  await expect(shell).toHaveCount(0);
});
