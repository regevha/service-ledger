import { type APIRequestContext } from '@playwright/test';
import { test, expect } from './coverage';
import { uniquePdf } from './unique-upload';
import { createNumericTemplate } from './numeric-fixture';
import { BACKEND_PORT } from '../../playwright.config';

// Tablet widths (621-899px) have no room for the scan beside the form either, so they get the same
// Fields | Scan switch as a phone; at 900px the scan sits beside the form.

const API_BASE = `http://localhost:${BACKEND_PORT}`;
// The shared fixture PDFs are fake bytes; page rendering needs a real (here: two blank pages) document.
// PDFium rebuilds a missing cross-reference table, so none is written.
const TWO_PAGE_PDF =
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n' +
  '4 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n' +
  'trailer<</Root 1 0 R/Size 5>>\n%%EOF';

async function seedReport(request: APIRequestContext): Promise<{ reportId: string; attachmentId: string }> {
  const model = `E2E-Scan-${Date.now()}`;
  const inst = await (
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
    data: { instrument_id: inst.id, template_id: templates[0].id },
  });
  const attachment = await (
    await request.post(`${API_BASE}/reports/${report.id}/attachments`, { multipart: { file: { name: 'two-pages.pdf', mimeType: 'application/pdf', buffer: uniquePdf(TWO_PAGE_PDF) } } })
  ).json();
  return { reportId: report.id, attachmentId: attachment.id };
}


for (const width of [700, 899]) {
  test(`at ${width}px the scan is behind a Fields | Scan switch`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 1000 });
    const { reportId } = await seedReport(request);
    await page.goto(`/#/reports/${reportId}`);
    await expect(page.locator('.field-list')).toBeVisible();
    await expect(page.getByRole('button', { name: /Hide scan|Show scan/ })).toHaveCount(0);

    await page.getByRole('tab', { name: 'Scan' }).click();
    await expect(page.locator('.field-list')).toBeHidden();
    await expect(page.locator('.scan-page')).toHaveCount(2);
    // Tablets keep the plain links; only a phone folds them into the menu.
    await expect(page.getByRole('link', { name: 'Download PDF' })).toBeVisible();

    await page.getByRole('tab', { name: 'Fields' }).click();
    await expect(page.locator('.field-list')).toBeVisible();
  });
}

test('at 900px the scan sits beside the form, with no switch', async ({ page, request }) => {
  await page.setViewportSize({ width: 900, height: 1000 });
  const { reportId } = await seedReport(request);
  await page.goto(`/#/reports/${reportId}`);
  await expect(page.locator('.field-list')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Scan' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Hide scan|Show scan/ })).toBeVisible();
});
