import { type APIRequestContext } from '@playwright/test';
import { test, expect } from './coverage';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uniqueFixture, uniquePdf } from './unique-upload';
import { createNumericTemplate } from './numeric-fixture';
import { BACKEND_PORT } from '../../playwright.config';

// Phone review 2 (2026-10-26): empty values read as a dash, the instrument is a link in a real
// heading, the instrument page has a real heading, and the new-report review opens like a saved one.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_BASE = `http://localhost:${BACKEND_PORT}`;
const PHONE = { width: 412, height: 915 };

async function seed(request: APIRequestContext): Promise<{ reportId: string; instrumentId: string; model: string }> {
  const model = `E2E-Polish-${Date.now()}`;
  const instrument = await (
    await request.post(`${API_BASE}/instruments`, {
      data: { name: model, model, manufacturer: 'E2E Maker', serial_number: `SN-${model}` },
    })
  ).json();
  await createNumericTemplate(request, model);
  const report = await (await request.post(`${API_BASE}/reports`, { data: {} })).json();
  const templates = await (
    await request.get(`${API_BASE}/report-templates`, { params: { report_type: 'installation_upgrade', model } })
  ).json();
  await request.patch(`${API_BASE}/reports/${report.id}/template`, {
    data: { instrument_id: instrument.id, template_id: templates[0].id },
  });
  const attachment = await (
    await request.post(`${API_BASE}/reports/${report.id}/attachments`, {
      multipart: { file: { name: 'seed.pdf', mimeType: 'application/pdf', buffer: uniquePdf('%PDF-1.4 polish') } },
    })
  ).json();
  const job = await (await request.post(`${API_BASE}/attachments/${attachment.id}/extract`)).json();
  for (let waited = 0; waited < 30_000; waited += 200) {
    const polled = await (await request.get(`${API_BASE}/extraction-jobs/${job.id}`)).json();
    if (polled.status === 'succeeded' || polled.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // cst_beads_lot (text) is left empty on purpose; no report date either.
  await request.patch(`${API_BASE}/reports/${report.id}/fields`, { data: { extracted_fields: { cst_beads_lot: '' }, report_date: null } });
  expect((await request.post(`${API_BASE}/reports/${report.id}/finalize`)).status()).toBe(200);
  return { reportId: report.id, instrumentId: instrument.id, model };
}

test.describe('on a phone', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test('an empty value in a finalized report shows a dash; editing brings the blank box back', async ({ page, request }) => {
    const { reportId } = await seed(request);
    await page.goto(`/#/reports/${reportId}`);
    const lot = page.locator('.field', { hasText: 'Cst beads lot' }).locator('input, textarea').first();
    await expect(lot).toHaveAttribute('placeholder', '—', { timeout: 15_000 });
    await page.click('.review-actions button:has-text("Edit")');
    await expect(lot).not.toHaveAttribute('placeholder', '—');
  });

  test('the instrument page has a real heading and says when a date is only the upload date', async ({ page, request }) => {
    const { instrumentId } = await seed(request);
    await page.goto(`/#/reports/instrument/${instrumentId}`);
    const heading = page.locator('.instrument-header .report-heading');
    await expect(heading).toBeVisible({ timeout: 15_000 });
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
