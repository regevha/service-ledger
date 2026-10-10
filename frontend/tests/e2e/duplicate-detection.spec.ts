import { test, expect } from './coverage';
import { BACKEND_PORT } from '../../playwright.config';

const API_BASE = `http://localhost:${BACKEND_PORT}`;

// A document that is already on file is flagged (backend/app/services/duplicates.py),
// and the exact same file as a report that was already read is refused and
// redirected to that report. Two warning signals, both exercised here with
// the stub reader: the same file bytes (SHA-256, found at upload) and the same
// work-order number (the stub "reads" one when the file's own name contains it,
// classification.py::_stub_work_order — a re-scan has different bytes).
//
// Each test uses its own unique marker, so neither depends on run order or on
// what other specs left in the shared database.

async function uploadAndClassify(page: import('@playwright/test').Page, name: string, contents: string) {
  await page.goto('/');
  await page.click('.view-tab:has-text("New report")');
  await page.fill('input[placeholder="Your name (optional)"]', 'E2E Duplicate');
  await page.locator('input[type="file"]').setInputFiles({
    name,
    mimeType: 'application/pdf',
    buffer: Buffer.from(contents),
  });
  await page.click('button:has-text("Upload & classify")');
  // Either end of classification: straight through to review, or the manual
  // confirm step (which other specs' extra instruments can cause).
  await expect(page.locator('#review-report-date, .class-row').first()).toBeVisible({ timeout: 30_000 });
}

test('the same file as a report that was never read is flagged, not refused', async ({ page, request }) => {
  const marker = Date.now();
  const bytes = `%PDF-1.4 duplicate bytes ${marker}`;

  // A first report that only has the file attached (never classified or read).
  const first = await (await request.post(`${API_BASE}/reports`, { data: { technician_name: 'E2E Duplicate' } })).json();
  await request.post(`${API_BASE}/reports/${first.id}/attachments`, {
    multipart: { file: { name: `first_${marker}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from(bytes) } },
  });

  await uploadAndClassify(page, `second_${marker}.pdf`, bytes);
  await expect(page.locator('#duplicate-notice')).toContainText('already on file');
  await expect(page.locator('#duplicate-notice')).toContainText('E2E Duplicate');
});

test('the same file as a report that was already read is refused and opens the existing report', async ({ page, request }) => {
  const marker = Date.now();
  const bytes = `%PDF-1.4 read bytes ${marker}`;
  const technician = `E2E-Redirect-${marker}`;

  // A first report taken through classify-confirm and extract, so it counts as read.
  const first = await (await request.post(`${API_BASE}/reports`, { data: { technician_name: technician } })).json();
  const instruments = await (await request.get(`${API_BASE}/instruments`)).json();
  const instrument = instruments.find((i: { model: string }) => i.model === 'LSRFortessa');
  const templates = await (
    await request.get(`${API_BASE}/report-templates`, { params: { report_type: 'repair', model: 'LSRFortessa' } })
  ).json();
  await request.patch(`${API_BASE}/reports/${first.id}/template`, {
    data: { instrument_id: instrument.id, template_id: templates[0].id },
  });
  const attachment = await (
    await request.post(`${API_BASE}/reports/${first.id}/attachments`, {
      multipart: { file: { name: `read_${marker}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from(bytes) } },
    })
  ).json();
  const job = await (await request.post(`${API_BASE}/attachments/${attachment.id}/extract`)).json();
  for (let waited = 0; waited < 30_000; waited += 200) {
    const polled = await (await request.get(`${API_BASE}/extraction-jobs/${job.id}`)).json();
    if (polled.status === 'succeeded' || polled.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  expect((await (await request.get(`${API_BASE}/reports/${first.id}`)).json()).status).toBe('extracted');

  // Loading the same bytes again through the UI is turned away…
  await page.goto('/');
  await page.click('.view-tab:has-text("New report")');
  await page.fill('input[placeholder="Your name (optional)"]', 'E2E Second Try');
  await page.locator('input[type="file"]').setInputFiles({
    name: `again_${marker}.pdf`,
    mimeType: 'application/pdf',
    buffer: Buffer.from(bytes),
  });
  await page.click('button:has-text("Upload & classify")');
  await expect(page.locator('#already-on-file-notice')).toBeVisible({ timeout: 30_000 });

  // …and leaves no empty draft behind from the refused attempt.
  const mine = await (await request.get(`${API_BASE}/reports`, { params: { technician: 'E2E Second Try' } })).json();
  expect(mine.filter((r: { status: string }) => r.status === 'draft')).toHaveLength(0);

  // The button opens the report that already holds the file.
  await page.click('button:has-text("Open existing report")');
  await expect(page.locator('.field-list')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.view-tab.active')).toHaveText('Reports');
});

test('a re-scan with a different file but the same work order is flagged', async ({ page }) => {
  const workOrder = `WO-${Date.now()}`;

  await uploadAndClassify(page, `visit_${workOrder}.pdf`, `%PDF-1.4 first scan ${workOrder}`);
  await expect(page.locator('#duplicate-notice')).toHaveCount(0);

  await uploadAndClassify(page, `rescan ${workOrder}.pdf`, `%PDF-1.4 a different scan of ${workOrder}`);
  await expect(page.locator('#duplicate-notice')).toContainText('already on file');
});

test('a document that is not on file gets no warning', async ({ page }) => {
  const marker = Date.now() + 1;
  await uploadAndClassify(page, `unique_${marker}.pdf`, `%PDF-1.4 nothing like it ${marker}`);
  await expect(page.locator('#duplicate-notice')).toHaveCount(0);
});
