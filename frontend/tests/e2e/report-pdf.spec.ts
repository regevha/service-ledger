import { test, expect } from './coverage';
import { TIMEOUT } from './timeouts';
import { API_BASE, seedReport } from './helpers/api';

// The "Download PDF" link on the report detail/review screen (§7/§11's
// single-report PDF export) — present once a template's resolved, and a
// real click downloads a PDF for that exact report.

test('report detail screen offers a PDF download for a resolved report', async ({ page, request }) => {
  const marker = `E2E-PDF-${Date.now()}`;
  const report = { id: (await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: marker })).reportId };

  await page.goto('/');
  await page.click('.view-tab:has-text("Reports")');
  await page.waitForSelector('.report-table');
  await page.click(`.report-row-body:has-text("${marker}")`);

  await expect(page.locator('.field-list')).toBeVisible({ timeout: TIMEOUT.ui });

  const pdfLink = page.locator('a.btn:has-text("Download PDF")');
  await expect(pdfLink).toHaveAttribute('href', `${API_BASE}/reports/${report.id}/pdf`);

  const [download] = await Promise.all([page.waitForEvent('download'), pdfLink.click()]);
  expect(download.suggestedFilename()).toBe(`report_${report.id}.pdf`);
  const downloadPath = await download.path();
  const fs = await import('node:fs/promises');
  const content = downloadPath ? await fs.readFile(downloadPath) : Buffer.alloc(0);
  expect(content.subarray(0, 5).toString('latin1')).toBe('%PDF-');
});

test('a report with no resolved template has no Download PDF link', async ({ page, request }) => {
  const marker = `E2E-PDF-Unresolved-${Date.now()}`;
  await request.post(`${API_BASE}/reports`, { data: { technician_name: marker } });

  await page.goto('/');
  await page.click('.view-tab:has-text("Reports")');
  await page.waitForSelector('.report-table, .empty-hint');
  await page.click(`.report-row-body:has-text("${marker}")`);

  await expect(page.locator('.empty-hint')).toBeVisible();
  await expect(page.locator('a.btn:has-text("Download PDF")')).toHaveCount(0);
});
