import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './coverage';
import { uniqueFixture } from './unique-upload';
import { TIMEOUT } from './timeouts';

// The sample repair order leaves its cause blank, and the reading says so with low confidence.
// Root cause is marked optional, so that empty answer is fine and not flagged; the blank parts list
// (not optional) is still flagged. Fault category is a list of choices.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(__dirname, 'fixtures', 'sample-work-order.pdf');

test('an empty optional root cause is not flagged, a blank parts list still is', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles(uniqueFixture(SAMPLE));
  await page.click('button:has-text("Upload & classify")');
  await page.waitForSelector('.class-row', { timeout: TIMEOUT.flow });
  await page.click('button:has-text("Confirm & continue")');
  await expect(page.locator('.field-list')).toBeVisible({ timeout: TIMEOUT.flow });

  await expect(page.locator('[data-field="components_replaced"]')).toHaveClass(/pending/);
  await expect(page.locator('[data-field="root_cause"]')).not.toHaveClass(/pending/);
  await expect(page.locator('[data-field="fault_category"]')).toContainText('fluidics');
});
