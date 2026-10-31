import { test, expect } from './coverage';

// On a wide screen the Reports filters are a column on the left of the list; below that width
// they stay a row above it.

test('filters sit left of the list on a wide screen and above it on a narrower one', async ({ page }) => {
  await page.setViewportSize({ width: 1700, height: 1000 });
  await page.goto('/#/reports');
  const filters = page.locator('.reports-filters');
  const results = page.locator('.reports-results');
  await expect(filters).toBeVisible();
  let f = (await filters.boundingBox())!;
  let r = (await results.boundingBox())!;
  expect(f.x + f.width).toBeLessThanOrEqual(r.x + 1);
  expect(f.width).toBeLessThan(400);

  await page.setViewportSize({ width: 1300, height: 900 });
  f = (await filters.boundingBox())!;
  r = (await results.boundingBox())!;
  expect(f.y + f.height).toBeLessThanOrEqual(r.y + 1);
});
