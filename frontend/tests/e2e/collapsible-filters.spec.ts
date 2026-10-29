import { test, expect } from './coverage';
import { TIMEOUT } from './timeouts';

// The filters can be folded away (to save room on a phone or tablet) and leave a one-line summary.

for (const tab of ['reports', 'analytics']) {
  test(`${tab}: hide the filters, read the summary, show them again`, async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto(`/#/${tab}`);
    const inputs = page.getByLabel('Lab manager', { exact: true });
    await expect(inputs).toBeVisible({ timeout: TIMEOUT.ui });

    await inputs.fill('Dana');
    await page.getByLabel('Report type', { exact: true }).selectOption('repair');
    await page.click('button:has-text("Hide filters")');

    await expect(page.getByLabel('Lab manager', { exact: true })).toHaveCount(0);
    const summary = page.locator('.filters-summary-text');
    await expect(summary).toContainText('Lab manager: Dana');
    await expect(summary).toContainText('Malfunction / repair');

    await page.click('button:has-text("Show filters")');
    await expect(page.getByLabel('Lab manager', { exact: true })).toHaveValue('Dana');
    await page.click('button:has-text("Clear filters")');
    await page.click('button:has-text("Hide filters")');
    await expect(page.locator('.filters-summary-text')).toHaveText('No filters');
    await page.click('button:has-text("Show filters")');

    // Folded stays folded after a reload (the filters themselves start empty again).
    await page.click('button:has-text("Hide filters")');
    await page.reload();
    await expect(page.locator('.filters-summary-text')).toHaveText('No filters');
  });
}
