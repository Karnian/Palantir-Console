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
