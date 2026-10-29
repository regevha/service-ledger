import { type APIRequestContext } from '@playwright/test';
import { test, expect } from './coverage';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uniqueFixture } from './unique-upload';
import { createNumericModel } from './numeric-fixture';
import { TIMEOUT } from './timeouts';
import { seedReport } from './helpers/api';

// Phone review 2 (2026-10-26): empty values read as a dash, the instrument is a link in a real
// heading, the instrument page has a real heading, and the new-report review opens like a saved one.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PHONE = { width: 412, height: 915 };

async function seed(request: APIRequestContext): Promise<{ reportId: string; instrumentId: string; model: string }> {
  const model = await createNumericModel(request, 'E2E-Polish');
  // cst_beads_lot (text) is left empty on purpose; no report date either.
  const { reportId, instrumentId } = await seedReport(request, {
    model,
    reportType: 'installation_upgrade',
    fields: { cst_beads_lot: '' },
    reportDate: null,
    finalize: true,
  });
  return { reportId, instrumentId, model };
}

test.describe('on a phone', { tag: '@phone' }, () => {

  test('an empty value in a finalized report shows a dash; editing brings the blank box back', async ({ page, request }) => {
    const { reportId } = await seed(request);
    await page.goto(`/#/reports/${reportId}`);
    const lot = page.locator('.field', { hasText: 'Cst beads lot' }).locator('input, textarea').first();
    await expect(lot).toHaveAttribute('placeholder', '—', { timeout: TIMEOUT.ui });
    await page.click('.review-actions button:has-text("Edit")');
    await expect(lot).not.toHaveAttribute('placeholder', '—');
  });

  test('the instrument page has a real heading and says when a date is only the upload date', async ({ page, request }) => {
    const { instrumentId } = await seed(request);
    await page.goto(`/#/reports/instrument/${instrumentId}`);
    const heading = page.locator('.instrument-header .report-heading');
    await expect(heading).toBeVisible({ timeout: TIMEOUT.ui });
    expect(await heading.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    expect(await heading.evaluate((el) => getComputedStyle(el).textTransform)).toBe('none');
    await expect(page.locator('.stat-tile', { hasText: 'Most recent activity' })).toContainText('(uploaded)');
  });

  test('a new report opens with the report-screen heading, not a small-caps sentence with two buttons', async ({ page }) => {
    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles(uniqueFixture(path.join(__dirname, 'fixtures', 'confident-scan.pdf')));
    await page.click('button:has-text("Upload & classify")');
    await page.waitForSelector('.field-list', { timeout: 60_000 });
    const heading = page.locator('.report-heading').first();
    expect(await heading.evaluate((el) => getComputedStyle(el).textTransform)).toBe('none');
    await expect(page.locator('.report-heading-meta')).toHaveText(/attention|Check the values/);
    await expect(page.getByRole('link', { name: 'Download PDF' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'View original scan' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Scan' })).toBeVisible();
  });
});
