import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './coverage';
import { uniqueFixture } from './unique-upload';
import { TIMEOUT } from './timeouts';

// Classify says why it stopped and does not pre-accept an unclear report type; Review names the unit
// and how it was found, with a way back to change it.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(__dirname, 'fixtures', 'sample-work-order.pdf');

test('an unclear report type is explained, outlined and has to be chosen; Review names the unit', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles(uniqueFixture(SAMPLE));
  await page.click('button:has-text("Upload & classify")');
  await page.waitForSelector('.class-row', { timeout: TIMEOUT.flow });

  await expect(page.getByTestId('classify-reason')).toContainText('The report type was not clear on the document.');
  const typeRow = page.locator('.class-row').nth(1);
  await expect(typeRow).toHaveClass(/uncertain/);
  await expect(typeRow.locator('select')).toHaveValue('');
  const confirm = page.getByRole('button', { name: /Confirm & continue/ });
  await expect(confirm).toBeDisabled();

  await typeRow.locator('select').selectOption('repair');
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.locator('.field-list')).toBeVisible({ timeout: TIMEOUT.flow });

  const line = page.getByTestId('review-instrument-line');
  await expect(line).toContainText('you chose it');
  // Back to Classify sits in the heading row, next to the title.
  await expect(page.locator('.section-title-row').filter({ has: page.getByTestId('back-to-classify') })).toContainText('Malfunction / repair');
  await line.getByRole('button', { name: 'Change' }).click();
  await expect(page.locator('.class-row').first()).toBeVisible({ timeout: TIMEOUT.ui });
});
