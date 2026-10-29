import { test, expect } from './coverage';
import { openReportFromList } from './helpers/ui';
import { API_BASE, seedReport } from './helpers/api';

// "Delete report" on the report detail screen: a confirm step first, then the
// report disappears from the list. A finalized report gets a stronger warning.

test('deleting a draft report asks for confirmation, then removes it from the list', async ({ page, request }) => {
  const marker = `E2E-Delete-${Date.now()}`;
  const report = await (await request.post(`${API_BASE}/reports`, { data: { technician_name: marker } })).json();
  await openReportFromList(page, marker);

  await page.click('button:has-text("Delete report")');
  await expect(page.getByRole('alertdialog')).toContainText('cannot be undone');

  // Cancel keeps the report.
  await page.click('button:has-text("Cancel")');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect((await request.get(`${API_BASE}/reports/${report.id}`)).status()).toBe(200);

  await page.click('button:has-text("Delete report")');
  await page.click('button:has-text("Confirm delete")');

  await page.waitForSelector('.report-table, .empty-hint');
  await expect(page.locator(`.report-row-body:has-text("${marker}")`)).toHaveCount(0);
  expect((await request.get(`${API_BASE}/reports/${report.id}`)).status()).toBe(404);
});

test('a finalized report is deleted only after a stronger warning', async ({ page, request }) => {
  const marker = `E2E-Delete-Final-${Date.now()}`;
  const report = {
    id: (await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: marker, finalize: true })).reportId,
  };

  await openReportFromList(page, marker);
  await page.click('button:has-text("Delete report")');
  await expect(page.getByRole('alertdialog')).toContainText('is finalized');
  await page.click('button:has-text("Confirm delete")');

  await page.waitForSelector('.report-table, .empty-hint');
  await expect(page.locator(`.report-row-body:has-text("${marker}")`)).toHaveCount(0);
  expect((await request.get(`${API_BASE}/reports/${report.id}`)).status()).toBe(404);
});
