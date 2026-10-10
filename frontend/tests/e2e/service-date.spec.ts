import { test, expect } from './coverage';
import { uniqueFixture } from './unique-upload';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'confident-scan.pdf');

// The service-visit date (Report.report_date) is read off the document by
// extraction, shown on the review screen for the technician to check, and
// saved with any correction. Before this, nothing in the UI ever set it, so
// every report created in the app was invisible to the Reports date filters.
test('the extracted service date is shown on review, can be corrected, and is saved', async ({ page }) => {
  const technician = `E2E Service Date ${Date.now()}`;

  await page.goto('/');
  await page.click('.view-tab:has-text("New report")');
  await page.fill('input[placeholder="Your name (optional)"]', technician);
  await page.locator('input[type="file"]').setInputFiles(uniqueFixture(FIXTURE));
  await page.click('button:has-text("Upload & classify")');

  // The stub classifier picks from the whole fleet, which other specs add
  // to (instrument-management.spec.ts adds two instruments sharing a model),
  // so depending on run order this may stop at the manual pick. Either path
  // ends on the same review screen, which is what this test is about.
  await page.waitForSelector('.field-list, .class-row', { timeout: 30_000 });
  if (await page.locator('.class-row').count()) {
    const instrumentSelect = page.locator('.class-row select').first();
    const firstInstrument = await instrumentSelect.locator('option:not([disabled])').first().getAttribute('value');
    await instrumentSelect.selectOption(firstInstrument!);
    await page.click('button:has-text("Confirm & continue to extraction")');
  }

  const dateInput = page.locator('#review-report-date');
  await expect(dateInput).toBeVisible({ timeout: 30_000 });
  // Stub extraction always reads some date within the past year.
  await expect(dateInput).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  // The suite runs without an API key, so the badge says "placeholder" rather
  // than showing a percentage that nothing measured, and a notice says why.
  await expect(page.locator('.field', { has: dateInput }).locator('.badge')).toContainText('placeholder');
  await expect(page.locator('#placeholder-notice')).toBeVisible();

  await dateInput.fill('2025-03-14');
  await page.click('button:has-text("Save & finalize report")');
  await expect(page.locator('.success-panel')).toBeVisible({ timeout: 15_000 });

  // The corrected date is what's stored — and the date filter finds it.
  await page.click('.view-tab:has-text("Reports")');
  await page.locator('input[aria-label="From date"]').fill('2025-03-14');
  await page.locator('input[aria-label="To date"]').fill('2025-03-14');
  const row = page.locator('.report-row-body', { hasText: technician });
  await expect(row).toBeVisible();
  await expect(row).toContainText('2025-03-14');
});
