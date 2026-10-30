import { test, expect } from './coverage';
import { seedReport } from './helpers/api';
import { TIMEOUT } from './timeouts';

// The fleet list beside the Analytics charts: choosing a row narrows every chart to it, the list keeps
// showing every row, and "Back to whole fleet" undoes it. A narrow screen shows the list and one item's
// charts in turn. Like fleet-analytics.spec.ts this suite shares its database with other specs, so the
// assertions are about what changes when a row is chosen, not about fleet-wide totals.

async function seedTwoModels(request: Parameters<typeof seedReport>[0]) {
  await seedReport(request, {
    finalize: true,
    model: 'FACSAria III',
    reportType: 'repair',
    fields: { labor_hours: 4 },
  });
  await seedReport(request, {
    finalize: true,
    model: 'LSRFortessa',
    reportType: 'repair',
    fields: { labor_hours: 2 },
  });
}

test('on a wide screen the list sits beside the charts and a row narrows them', async ({ page, request }) => {
  await seedTwoModels(request);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/#/analytics');

  const list = page.getByTestId('fleet-list');
  await expect(list).toBeVisible({ timeout: TIMEOUT.ui });
  await expect(list.getByRole('tab', { name: 'Model' })).toHaveAttribute('aria-selected', 'true');
  const aria = list.getByTestId('fleet-row').filter({ hasText: 'FACSAria III' });
  const fortessa = list.getByTestId('fleet-row').filter({ hasText: 'LSRFortessa' });
  await expect(aria).toBeVisible();
  await expect(fortessa).toBeVisible();
  await expect(list.getByTestId('fleet-row-all')).toHaveAttribute('aria-pressed', 'true');

  // The labor chart lists every instrument until a row is chosen.
  await expect(page.locator('.labor-bar', { hasText: 'LSRFortessa' }).first()).toBeVisible();

  await aria.click();
  await expect(aria).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('analytics-basis')).toContainText('for FACSAria III', { timeout: TIMEOUT.ui });
  await expect(page.locator('.analytics-detail-title')).toHaveText('FACSAria III');
  // The charts are narrowed to the model...
  await expect(page.locator('.labor-bar', { hasText: 'LSRFortessa' })).toHaveCount(0);
  await expect(page.locator('.labor-bar', { hasText: 'FACSAria III' }).first()).toBeVisible();
  // ...but the list still offers every row.
  await expect(fortessa).toBeVisible();

  // The list is a column on the left, not above the charts.
  const listBox = (await list.boundingBox())!;
  const detailBox = (await page.locator('.analytics-detail').boundingBox())!;
  expect(listBox.x + listBox.width).toBeLessThanOrEqual(detailBox.x + 1);

  await page.getByRole('button', { name: 'Back to whole fleet' }).click();
  await expect(page.getByTestId('analytics-basis')).not.toContainText('for FACSAria III');
  await expect(page.locator('.labor-bar', { hasText: 'LSRFortessa' }).first()).toBeVisible();
  await expect(list.getByTestId('fleet-row-all')).toHaveAttribute('aria-pressed', 'true');
});

test('grouping by instrument lists units and choosing one narrows to it', async ({ page, request }) => {
  await seedTwoModels(request);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/#/analytics');
  const list = page.getByTestId('fleet-list');
  await expect(list).toBeVisible({ timeout: TIMEOUT.ui });

  await list.getByRole('tab', { name: 'Instrument' }).click();
  await expect(list.getByRole('tab', { name: 'Instrument' })).toHaveAttribute('aria-selected', 'true');
  const rows = list.getByTestId('fleet-row');
  await expect(rows.first()).toBeVisible();
  const name = (await rows.first().locator('.fleet-row-title').textContent())!;
  await rows.first().click();
  await expect(page.getByTestId('analytics-basis')).toContainText(`for ${name}`, { timeout: TIMEOUT.ui });

  // Changing the grouping clears the choice.
  await list.getByRole('tab', { name: 'Model' }).click();
  await expect(page.getByTestId('analytics-basis')).not.toContainText(`for ${name}`);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true });

  test('the list shows first; a row opens its charts with a way back', async ({ page, request }) => {
    await seedTwoModels(request);
    await page.goto('/#/analytics');
    const list = page.getByTestId('fleet-list');
    await expect(list).toBeVisible({ timeout: TIMEOUT.ui });
    // The whole fleet's charts are still there below the list.
    await expect(page.locator('.chart-toggle').first()).toBeVisible();

    await list.getByTestId('fleet-row').first().click();
    const back = page.getByRole('button', { name: /^← All models/ });
    await expect(back).toBeVisible({ timeout: TIMEOUT.ui });
    await expect(list).toHaveCount(0);
    expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);

    await back.click();
    await expect(page.getByTestId('fleet-list')).toBeVisible();
    await expect(back).toHaveCount(0);
  });
});
