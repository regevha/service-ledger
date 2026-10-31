import { test, expect } from './coverage';
import { API_BASE, seedReport } from './helpers/api';

// The CSV export lives on the Admin tab (§7/§9's export_reports, kept in filter-parity with
// search_reports): its link's href tracks the chosen filters, and a real click downloads a CSV
// containing exactly the filtered rows.

test('the Admin export link follows the chosen filters and downloads the filtered CSV', async ({ page, request }) => {
  const marker = `E2E-Export-${Date.now()}`;
  await seedReport(request, { model: 'FACSAria III', reportType: 'preventive_maintenance', technician: marker, finalize: true });

  await page.goto('/');
  await page.click('.view-tab:has-text("Admin")');
  await expect(page.getByTestId('admin-screen')).toBeVisible();

  const exportLink = page.getByTestId('admin-export-link');
  // Finalized reports are the default choice.
  await expect(exportLink).toHaveAttribute('href', `${API_BASE}/reports/export?status=finalized`);

  await page.getByLabel('Report type', { exact: true }).selectOption('preventive_maintenance');
  await page.getByLabel('Lab manager', { exact: true }).fill(marker);
  await expect(exportLink).toHaveAttribute('href', new RegExp(`report_type=preventive_maintenance.*technician=${marker}|technician=${marker}.*report_type=preventive_maintenance`));
  await expect(page.getByTestId('admin-match-count')).toContainText('1 report');

  const [download] = await Promise.all([page.waitForEvent('download'), exportLink.click()]);
  expect(download.suggestedFilename()).toBe('reports_export.csv');
  const downloadPath = await download.path();
  const fs = await import('node:fs/promises');
  const content = downloadPath ? await fs.readFile(downloadPath, 'utf8') : '';
  expect(content).toContain(marker);
  expect(content).toContain('preventive_maintenance');
});

test('Export CSV is no longer on the Reports list, and the top bar has Admin and a New report button', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 });
  await page.goto('/#/reports');
  await expect(page.locator('a.btn:has-text("Export CSV")')).toHaveCount(0);
  await expect(page.getByTestId('topbar-new-report')).toBeVisible();
  await page.click('.view-tab:has-text("Admin")');
  await expect(page).toHaveURL(/#\/admin$/);
  await page.click('.admin-nav-item:has-text("Field aliases")');
  await expect(page).toHaveURL(/#\/admin\/aliases$/);
  await page.click('.view-tab:has-text("New report")');
  await expect(page.getByTestId('topbar-new-report')).toHaveCount(0);
});
