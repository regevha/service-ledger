import type { Page } from '@playwright/test';
import { test, expect } from './coverage';
import { deleteReports, listReportIds } from './helpers/api';
import { TIMEOUT } from './timeouts';

// An HTML report is accepted, read as text and shown as text (never as a web page); an HTML page that is
// not a service report is rejected before any model call, like any other file that is not a report.
// Synthetic content only. In stub mode a file name with "othermaker-<serial>" is read as another maker's report.

const unique = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`;

const reportHtml = (token: string) =>
  `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Service Report</title><script>window.__ran = 1</script></head><body>
<h1>Service report</h1><p>Work order: WO-${token.slice(-8)}</p>
<table><tr><td>Serial number</td><td>QQ${token.slice(-4)}</td></tr><tr><td>Labour hours</td><td>2.5</td></tr></table>
<p>Work performed: replaced the pump. Parts replaced: seal kit. Visit date 2026-11-20. Technician A. Example.</p>
<p>Instrument model: Test Cytometer. Fault: no flow. Repair completed.</p><!-- ${token} --></body></html>`;

const errorHtml = (token: string) =>
  `<!DOCTYPE html><html><head><title>404</title></head><body><h1>Page not found</h1><p>The page you asked for could not be found on this server, please check the address and try again later.</p><!-- ${token} --></body></html>`;

test('an HTML page that is not a service report is rejected, with no draft left', async ({ page, request }) => {
  const before = new Set(await listReportIds(request));
  await page.goto('/#/new');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'error-page.html',
    mimeType: 'text/html',
    buffer: Buffer.from(errorHtml(unique())),
  });
  await page.click('button:has-text("Upload & classify")');

  await expect(page.getByText("This doesn't look like a service report.")).toBeVisible({ timeout: TIMEOUT.flow });
  await expect(page.getByRole('button', { name: /Confirm & continue/ })).toHaveCount(0);
  const after = await listReportIds(request);
  expect(after.filter((id) => !before.has(id))).toEqual([]);
});

test('an HTML service report is accepted and shown as text, not as a web page', async ({ page, request }) => {
  const before = new Set(await listReportIds(request));
  try {
    await acceptedReportFlow(page);
  } finally {
    await deleteReports(request, (await listReportIds(request)).filter((id) => !before.has(id)));
  }
});

async function acceptedReportFlow(page: Page) {
  const token = unique();
  await page.goto('/#/new');
  await page.locator('input[type="file"]').setInputFiles({
    name: `othermaker-QQ${token.slice(-4)}-report.html`,
    mimeType: 'text/html',
    buffer: Buffer.from(reportHtml(token)),
  });
  await page.click('button:has-text("Upload & classify")');

  // Past the gate: the report is recognised, so the confirm screen (not the rejection) appears.
  await expect(page.getByText('Detected from the document')).toBeVisible({ timeout: TIMEOUT.flow });
  await expect(page.getByText("This doesn't look like a service report.")).toHaveCount(0);

  // The original pane shows the readable text (not the markup); no script of the file ran in the page.
  await page.getByRole('button', { name: 'Show scan' }).click();
  const pane = page.frameLocator('iframe[title="Original scan"]').locator('body');
  await expect(pane).toContainText('Serial number', { timeout: TIMEOUT.ui });
  await expect(pane).not.toContainText('<table');
  // The file's own script never ran: its marker would be on the window of a page that rendered it.
  expect(await page.evaluate(() => (window as unknown as { __ran?: number }).__ran)).toBeUndefined();
}
