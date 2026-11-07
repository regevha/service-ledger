import { test, expect } from '@playwright/test';

test('upload screen has a heading and the name field below the drop box', async ({ page }) => {
  await page.goto('/#/new');
  await expect(page.getByRole('heading', { name: 'Add a service report' })).toBeVisible();
  const drop = await page.locator('.dropzone').first().boundingBox();
  const name = await page.getByLabel(/Your name/).boundingBox();
  expect(name!.y).toBeGreaterThan(drop!.y);
});
