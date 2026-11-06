import { test, expect } from './coverage';
import { uniqueFixture } from './unique-upload';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIMEOUT } from './timeouts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'confident-scan.pdf');

// The extraction duration is measured in the browser during intake and shown
// on Review & finalize only; it is not stored.
test('review screen shows how long the extraction took', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-new').click();
  await page.getByTestId('intake-file-input').setInputFiles(uniqueFixture(FIXTURE));
  await page.click('button:has-text("Upload & classify")');
  await page.waitForSelector('[data-testid="field-list"]', { timeout: TIMEOUT.flow });

  await expect(page.getByTestId('extraction-time')).toHaveText(/^Extracted in (under 0\.1|\d+\.\d) s$/);
});

test('review screen can go back to Classify', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tab-new').click();
  await page.getByTestId('intake-file-input').setInputFiles(uniqueFixture(FIXTURE));
  await page.click('button:has-text("Upload & classify")');
  await page.waitForSelector('[data-testid="field-list"]', { timeout: TIMEOUT.flow });

  await page.getByTestId('back-to-classify').click();
  await expect(page.getByTestId('class-row').first()).toBeVisible();
  await expect(page.getByTestId('field-list')).toHaveCount(0);
});
