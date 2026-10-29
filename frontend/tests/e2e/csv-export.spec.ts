import { test, expect } from './coverage';
import { API_BASE, seedReport } from './helpers/api';

// The Export CSV link (§7/§9's export_reports, kept in filter-parity with
// search_reports) — its href tracks the active filters, and a real click
// downloads a CSV containing exactly the filtered rows.

test('export link reflects the active filter and downloads the filtered CSV', async ({ page, request }) => {
  const marker = `E2E-Export-${Date.now()}`;
  // Read to the end (the worker picks the job up) so no job is left dangling past this test.
  await seedReport(request, { model: 'FACSAria III', reportType: 'preventive_maintenance', technician: marker });

  await page.goto('/');
  await page.click('.view-tab:has-text("Reports")');
  await page.waitForSelector('.report-table');

  const exportLink = page.locator('a.btn:has-text("Export CSV")');
  await expect(exportLink).toHaveAttribute('href', `${API_BASE}/reports/export`);

  await page.getByLabel('Report type', { exact: true }).selectOption('preventive_maintenance');
  await expect(exportLink).toHaveAttribute('href', `${API_BASE}/reports/export?report_type=preventive_maintenance`);

  const [download] = await Promise.all([page.waitForEvent('download'), exportLink.click()]);
  expect(download.suggestedFilename()).toBe('reports_export.csv');
  const downloadPath = await download.path();
  const fs = await import('node:fs/promises');
  const content = downloadPath ? await fs.readFile(downloadPath, 'utf8') : '';
  expect(content).toContain(marker);
  expect(content).toContain('preventive_maintenance');
});
