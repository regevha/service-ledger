import { test, expect } from './coverage';
import { BACKEND_PORT } from '../../playwright.config';

// "Delete report" on the report detail screen: a confirm step first, then the
// report disappears from the list. A finalized report gets a stronger warning.

const API_BASE = `http://localhost:${BACKEND_PORT}`;

async function openReport(page: import('@playwright/test').Page, marker: string) {
  await page.goto('/');
  await page.click('.view-tab:has-text("Reports")');
  await page.waitForSelector('.report-table, .empty-hint');
  await page.click(`.report-row-body:has-text("${marker}")`);
}

test('deleting a draft report asks for confirmation, then removes it from the list', async ({ page, request }) => {
  const marker = `E2E-Delete-${Date.now()}`;
  const report = await (await request.post(`${API_BASE}/reports`, { data: { technician_name: marker } })).json();
  await openReport(page, marker);

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
  expect((await request.post(`${API_BASE}/reports/${report.id}/finalize`)).status()).toBe(200);

  await openReport(page, marker);
  await page.click('button:has-text("Delete report")');
  await expect(page.getByRole('alertdialog')).toContainText('is finalized');
  await page.click('button:has-text("Confirm delete")');

  await page.waitForSelector('.report-table, .empty-hint');
  await expect(page.locator(`.report-row-body:has-text("${marker}")`)).toHaveCount(0);
  expect((await request.get(`${API_BASE}/reports/${report.id}`)).status()).toBe(404);
});
