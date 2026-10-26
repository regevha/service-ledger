import { test, expect } from './coverage';

// Analytics on a phone is a short list of headings you open one at a time (the first starts open);
// on a wide screen every chart is simply shown.

test.describe('on a phone', () => {
  test.use({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true });

  test('the charts are folding sections: the first is open, the others open when tapped', async ({ page }) => {
    await page.goto('/#/analytics');
    const toggles = page.locator('.chart-toggle');
    await expect(toggles.first()).toBeVisible({ timeout: 15_000 });
    expect(await toggles.count()).toBeGreaterThanOrEqual(6);
    await expect(toggles.nth(0)).toHaveAttribute('aria-expanded', 'true');
    await expect(toggles.nth(1)).toHaveAttribute('aria-expanded', 'false');

    // A closed section shows only its heading.
    const second = page.locator('.chart-section-fold').nth(1);
    const closedHeight = (await second.boundingBox())!.height;
    expect(closedHeight).toBeLessThan(60);

    await toggles.nth(1).click();
    await expect(toggles.nth(1)).toHaveAttribute('aria-expanded', 'true');
    expect((await second.boundingBox())!.height).toBeGreaterThan(closedHeight + 40);

    await toggles.nth(1).click();
    await expect(toggles.nth(1)).toHaveAttribute('aria-expanded', 'false');
    expect((await second.boundingBox())!.height).toBeLessThan(60);

    // The whole page is much shorter than the one long scroll it replaces.
    const total = await page.evaluate(() => document.documentElement.scrollHeight);
    expect(total).toBeLessThan(2200);
  });

  test('every folding heading is a 44px-high button', async ({ page }) => {
    await page.goto('/#/analytics');
    const toggles = page.locator('.chart-toggle');
    await expect(toggles.first()).toBeVisible({ timeout: 15_000 });
    for (let i = 0; i < (await toggles.count()); i++) {
      expect((await toggles.nth(i).boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
    }
  });
});

test('on a wide screen every chart is open and there are no folding buttons', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/#/analytics');
  await expect(page.locator('.chart-title').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.chart-toggle')).toHaveCount(0);
  expect(await page.locator('.chart-section .chart-title').count()).toBeGreaterThanOrEqual(6);
});
