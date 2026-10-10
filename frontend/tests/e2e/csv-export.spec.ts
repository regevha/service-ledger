import { test, expect } from './coverage';
import { uniquePdf } from './unique-upload';
import { BACKEND_PORT } from '../../playwright.config';

// The Export CSV link (§7/§9's export_reports, kept in filter-parity with
// search_reports) — its href tracks the active filters, and a real click
// downloads a CSV containing exactly the filtered rows.

const API_BASE = `http://localhost:${BACKEND_PORT}`;

test('export link reflects the active filter and downloads the filtered CSV', async ({ page, request }) => {
  const marker = `E2E-Export-${Date.now()}`;
  const report = await (
    await request.post(`${API_BASE}/reports`, { data: { technician_name: marker } })
  ).json();
  const instruments = await (await request.get(`${API_BASE}/instruments`)).json();
  const instrument = instruments.find((i: { model: string }) => i.model === 'FACSAria III');
  const templates = await (
    await request.get(`${API_BASE}/report-templates`, { params: { report_type: 'preventive_maintenance', model: 'FACSAria III' } })
  ).json();
  await request.patch(`${API_BASE}/reports/${report.id}/template`, {
    data: { instrument_id: instrument.id, template_id: templates[0].id },
  });
  const attachment = await (
    await request.post(`${API_BASE}/reports/${report.id}/attachments`, {
      multipart: { file: { name: 'seed.pdf', mimeType: 'application/pdf', buffer: uniquePdf('%PDF-1.4 seed') } },
    })
  ).json();
  // §3/§9: fire-and-forget is fine here — report_type (what this test's CSV
  // assertion actually checks) comes from the template join made by the
  // PATCH above, not from the async extraction result — but not waiting for
  // app.worker to pick this up would otherwise leave a job dangling past
  // this test's own lifetime for no reason.
  const job = await (await request.post(`${API_BASE}/attachments/${attachment.id}/extract`)).json();
  for (let waited = 0; waited < 30_000; waited += 200) {
    const polled = await (await request.get(`${API_BASE}/extraction-jobs/${job.id}`)).json();
    if (polled.status === 'succeeded' || polled.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  await page.goto('/');
  await page.click('.view-tab:has-text("Reports")');
  await page.waitForSelector('.report-table');

  const exportLink = page.locator('a.btn:has-text("Export CSV")');
  await expect(exportLink).toHaveAttribute('href', `${API_BASE}/reports/export`);

  await page.selectOption('.filter-row select >> nth=1', 'preventive_maintenance');
  await expect(exportLink).toHaveAttribute('href', `${API_BASE}/reports/export?report_type=preventive_maintenance`);

  const [download] = await Promise.all([page.waitForEvent('download'), exportLink.click()]);
  expect(download.suggestedFilename()).toBe('reports_export.csv');
  const downloadPath = await download.path();
  const fs = await import('node:fs/promises');
  const content = downloadPath ? await fs.readFile(downloadPath, 'utf8') : '';
  expect(content).toContain(marker);
  expect(content).toContain('preventive_maintenance');
});
