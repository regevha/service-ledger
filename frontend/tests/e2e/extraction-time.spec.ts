import { test, expect } from './coverage';
import { uniqueFixture } from './unique-upload';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'confident-scan.pdf');

// The extraction duration is measured in the browser during intake and shown
// on Review & finalize only; it is not stored.
test('review screen shows how long the extraction took', async ({ page }) => {
  await page.goto('/');
  await page.click('.view-tab:has-text("New report")');
  await page.locator('input[type="file"]').setInputFiles(uniqueFixture(FIXTURE));
  await page.click('button:has-text("Upload & classify")');
  await page.waitForSelector('.field-list', { timeout: 30_000 });

  await expect(page.getByTestId('extraction-time')).toHaveText(/^Extracted in (under 0\.1|\d+\.\d) s$/);
});
