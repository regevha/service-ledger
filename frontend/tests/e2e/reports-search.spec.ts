import { test, expect, type APIRequestContext } from '@playwright/test';
import { BACKEND_PORT } from '../../playwright.config';

// The reports search/list screen (§7/§9) — filters, the empty state, and the
// click-through into the review screen for an already-created report.
//
// Report rows are seeded directly against the API rather than through the
// upload UI (already covered by happy-path/manual-confirm.spec.ts): this
// suite has no per-test truncation, so every spec's technician_name is a
// unique marker string, and assertions look for that marker among the
// visible rows rather than asserting an absolute row count — which stays
// correct regardless of what other specs in the same run created.

const API_BASE = `http://localhost:${BACKEND_PORT}`;

async function seedReport(
  request: APIRequestContext,
  opts: { model: string; reportType: string; technician: string; finalize: boolean }
) {
  const report = await (await request.post(`${API_BASE}/reports`, { data: { technician_name: opts.technician } })).json();

  const instruments = await (await request.get(`${API_BASE}/instruments`)).json();
  const instrument = instruments.find((i: { model: string }) => i.model === opts.model);
  const templates = await (
    await request.get(`${API_BASE}/report-templates`, { params: { report_type: opts.reportType, model: opts.model } })
  ).json();
  const template = templates[0];

  await request.patch(`${API_BASE}/reports/${report.id}/template`, {
    data: { instrument_id: instrument.id, template_id: template.id },
  });

  const attachment = await (
    await request.post(`${API_BASE}/reports/${report.id}/attachments`, {
      multipart: { file: { name: 'seed.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 seed') } },
    })
  ).json();
  // §3/§9: extract only enqueues a job now — app.worker (booted alongside
  // this suite's dedicated backend, see playwright.config.ts) runs it in
  // the background, so seeding has to wait for that job to finish before
  // the report is actually in "extracted" status.
  const job = await (await request.post(`${API_BASE}/attachments/${attachment.id}/extract`)).json();
  await waitForJob(request, job.id);

  if (opts.finalize) {
    await request.post(`${API_BASE}/reports/${report.id}/finalize`);
  }

  return report.id as string;
}

async function waitForJob(request: APIRequestContext, jobId: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await (await request.get(`${API_BASE}/extraction-jobs/${jobId}`)).json();
    if (job.status === 'succeeded' || job.status === 'failed') return;
    if (Date.now() >= deadline) throw new Error(`extraction job ${jobId} did not finish within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test.describe('reports search screen', () => {
  test('filters by report type and status, and shows an empty state', async ({ page, request }) => {
    const marker = `E2E-Search-${Date.now()}`;
    await seedReport(request, { model: 'FACSDiscover S8', reportType: 'calibration', technician: marker, finalize: true });

    await page.goto('/');
    await page.click('.view-tab:has-text("Reports")');
    await page.waitForSelector('.report-table, .empty-hint');

    // No filters: the seeded row is visible somewhere in the table.
    await expect(page.locator('.report-row-body', { hasText: marker })).toBeVisible();

    // Matching filters keep it.
    await page.selectOption('.filter-row select >> nth=1', 'calibration');
    await page.selectOption('.filter-row select >> nth=2', 'finalized');
    await expect(page.locator('.report-row-body', { hasText: marker })).toBeVisible();

    // "classified" is a status no seed anywhere in this suite ever leaves a
    // report in (every seed either extracts, or extracts+finalizes) — a
    // reliably-empty result regardless of what other specs in this same run
    // created, unlike picking "some other report_type" which could
    // coincidentally match a report another spec's stub-hashed fixture
    // landed on. Proves the empty state renders and the export link (tied
    // 1:1 to a non-empty result set) disappears with it.
    await page.selectOption('.filter-row select >> nth=1', '');
    await page.selectOption('.filter-row select >> nth=2', 'classified');
    await expect(page.locator('.report-row-body')).toHaveCount(0);
    await expect(page.locator('.empty-hint')).toBeVisible();
    await expect(page.locator('a.btn:has-text("Export CSV")')).toHaveCount(0);

    await page.click('button:has-text("Clear filters")');
    await expect(page.locator('.report-row-body', { hasText: marker })).toBeVisible();
  });

  test('opens a report, hides finalize once already finalized, and back-navigates', async ({ page, request }) => {
    const marker = `E2E-Detail-${Date.now()}`;
    await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: marker, finalize: true });

    await page.goto('/');
    await page.click('.view-tab:has-text("Reports")');
    await page.waitForSelector('.report-table');
    await page.click(`.report-row-body:has-text("${marker}")`);

    await expect(page.locator('.field-list')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.section-title')).toContainText('Finalized');
    await expect(page.locator('button:has-text("Save corrections")')).toBeVisible();
    // finalize_report (backend §9) 409s outside extracted/in_review — the
    // button is withheld rather than surfacing that error after the click.
    await expect(page.locator('button:has-text("Save & finalize report")')).toHaveCount(0);

    await page.click('.back-link');
    await expect(page.locator('.report-table')).toBeVisible();
    await expect(page.locator('.report-row-body', { hasText: marker })).toBeVisible();
  });

  test('a report still in "extracted" status can be finalized from the detail view', async ({ page, request }) => {
    const marker = `E2E-Finalize-${Date.now()}`;
    await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: marker, finalize: false });

    await page.goto('/');
    await page.click('.view-tab:has-text("Reports")');
    await page.waitForSelector('.report-table');
    await page.click(`.report-row-body:has-text("${marker}")`);

    await expect(page.locator('.field-list')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.section-title')).toContainText('Extracted');
    const finalizeButton = page.locator('button:has-text("Save & finalize report")');
    await expect(finalizeButton).toBeVisible();

    await finalizeButton.click();
    await expect(page.locator('.section-title')).toContainText('Finalized', { timeout: 15_000 });
    await expect(page.locator('button:has-text("Save & finalize report")')).toHaveCount(0);
  });
});
