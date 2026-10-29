import { test, expect } from './coverage';
import { TIMEOUT } from './timeouts';
import { API_BASE } from './helpers/api';

// Analytics on a phone is a short list of headings you open one at a time (the first starts open);
// on a wide screen every chart is simply shown.

test.describe('on a phone', { tag: '@phone' }, () => {

  test('the charts are folding sections: the first is open, the others open when tapped', async ({ page }) => {
    await page.goto('/#/analytics');
    const toggles = page.locator('.chart-toggle');
    await expect(toggles.first()).toBeVisible({ timeout: TIMEOUT.ui });
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

    // The page is much shorter than the one long scroll it replaces: opening every section makes it clearly longer.
    // (Compared with itself, not a fixed height, since the filters above vary with the data in the database.)
    const folded = await page.evaluate(() => document.documentElement.scrollHeight);
    const count = await toggles.count();
    for (let i = 1; i < count; i++) await toggles.nth(i).click();
    const open = await page.evaluate(() => document.documentElement.scrollHeight);
    expect(open).toBeGreaterThan(folded + 400);
  });

  test('every folding heading is a 44px-high button', async ({ page }) => {
    await page.goto('/#/analytics');
    const toggles = page.locator('.chart-toggle');
    await expect(toggles.first()).toBeVisible({ timeout: TIMEOUT.ui });
    for (let i = 0; i < (await toggles.count()); i++) {
      expect((await toggles.nth(i).boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
    }
  });

  test('the intro is one line you can open, and "Compare units of the same model" folds like the charts', async ({ page, request }) => {
    // A model with two units, so the comparison section exists.
    const model = `E2E-Fold-${Date.now()}`;
    for (const n of [1, 2]) {
      await request.post(`${API_BASE}/instruments`, {
        data: { name: `${model}-${n}`, model, manufacturer: 'E2E Maker', serial_number: `SN-${model}-${n}` },
      });
    }
    await page.goto('/#/analytics');
    const intro = page.locator('details.hint-details');
    await expect(intro).toBeVisible({ timeout: TIMEOUT.ui });
    await expect(intro.locator('summary')).toHaveText('Computed from finalized reports');
    const closed = (await intro.boundingBox())!.height;
    expect(closed).toBeLessThan(60); // one line, not five
    await intro.locator('summary').click();
    expect((await intro.boundingBox())!.height).toBeGreaterThan(closed + 30);

    const compare = page.locator('#model-comparison .chart-toggle');
    await expect(compare).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#model-comparison .compare-table')).toHaveCount(0);
    await compare.click();
    await expect(page.locator('#model-comparison .compare-table')).toBeVisible();
  });
});

test('on a wide screen every chart is open and there are no folding buttons', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/#/analytics');
  await expect(page.locator('.chart-title').first()).toBeVisible({ timeout: TIMEOUT.ui });
  await expect(page.locator('.chart-toggle')).toHaveCount(0);
  expect(await page.locator('.chart-section .chart-title').count()).toBeGreaterThanOrEqual(6);
});
