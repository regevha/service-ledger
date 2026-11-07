import { test, expect } from './coverage';

// From small laptops (1000px) up the Reports filters are a column on the left of the list, so the list
// starts on the first screen; below that width they stay a row above it.

test('filters sit left of the list from a small laptop up and above it on a narrower one', async ({ page }) => {
  await page.setViewportSize({ width: 1700, height: 1000 });
  await page.goto('/#/reports');
  const filters = page.locator('.reports-filters');
  const results = page.locator('.reports-results');
  await expect(filters).toBeVisible();
  let f = (await filters.boundingBox())!;
  let r = (await results.boundingBox())!;
  expect(f.x + f.width).toBeLessThanOrEqual(r.x + 1);
  expect(f.width).toBeLessThan(400);

  // A 1280x720 laptop gets the column too, and the list starts beside it.
  await page.setViewportSize({ width: 1280, height: 720 });
  f = (await filters.boundingBox())!;
  r = (await results.boundingBox())!;
  expect(f.x + f.width).toBeLessThanOrEqual(r.x + 1);
  expect(r.y).toBeLessThan(400);

  await page.setViewportSize({ width: 900, height: 900 });
  f = (await filters.boundingBox())!;
  r = (await results.boundingBox())!;
  expect(f.y + f.height).toBeLessThanOrEqual(r.y + 1);
});
