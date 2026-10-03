import { test, expect } from './coverage';
import { BACKEND_PORT } from '../../playwright.config';

// The "Download PDF" link on the report detail/review screen (§7/§11's
// single-report PDF export) — present once a template's resolved, and a
// real click downloads a PDF for that exact report.

const API_BASE = `http://localhost:${BACKEND_PORT}`;

test('report detail screen offers a PDF download for a resolved report', async ({ page, request }) => {
  const marker = `E2E-PDF-${Date.now()}`;
  const report = await (await request.post(`${API_BASE}/reports`, { data: { technician_name: marker } })).json();

  const instruments = await (await request.get(`${API_BASE}/instruments`)).json();
  const instrument = instruments.find((i: { model: string }) => i.model === 'LSRFortessa');
  const templates = await (
    await request.get(`${API_BASE}/report-templates`, { params: { report_type: 'repair', model: 'LSRFortessa' } })
  ).json();
  await request.patch(`${API_BASE}/reports/${report.id}/template`, {
    data: { instrument_id: instrument.id, template_id: templates[0].id },
  });

  const attachment = await (
    await request.post(`${API_BASE}/reports/${report.id}/attachments`, {
      multipart: { file: { name: 'seed.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 seed') } },
    })
  ).json();
  const job = await (await request.post(`${API_BASE}/attachments/${attachment.id}/extract`)).json();
  for (let waited = 0; waited < 30_000; waited += 200) {
    const polled = await (await request.get(`${API_BASE}/extraction-jobs/${job.id}`)).json();
    if (polled.status === 'succeeded' || polled.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  await page.goto('/');
  await page.click('.view-tab:has-text("Reports")');
  await page.waitForSelector('.report-table');
  await page.click(`.report-row-body:has-text("${marker}")`);

  await expect(page.locator('.field-list')).toBeVisible({ timeout: 15_000 });

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
