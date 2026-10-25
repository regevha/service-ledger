import { type APIRequestContext } from '@playwright/test';
import { test, expect } from './coverage';
import { uniquePdf } from './unique-upload';
import { BACKEND_PORT } from '../../playwright.config';

// Free-text search on the Reports list: finalized reports only, excerpts under
// each result, matched words highlighted when a result is opened.
//
// Like reports-search.spec.ts, every report carries a unique marker word and
// assertions look for that marker among the rows, never absolute counts.

const API_BASE = `http://localhost:${BACKEND_PORT}`;

async function waitForJob(request: APIRequestContext, jobId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const job = await (await request.get(`${API_BASE}/extraction-jobs/${jobId}`)).json();
    if (job.status === 'succeeded' || job.status === 'failed') return;
    if (Date.now() >= deadline) throw new Error('extraction job did not finish');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** A repair report on a Fortessa with the given text, finalized or left extracted (a draft-like state). */
async function seedTextReport(
  request: APIRequestContext,
  opts: { technician: string; workPerformed: string; finalize: boolean }
) {
  const report = await (await request.post(`${API_BASE}/reports`, { data: { technician_name: opts.technician } })).json();
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
      multipart: { file: { name: 'seed.pdf', mimeType: 'application/pdf', buffer: uniquePdf('%PDF-1.4 text search') } },
    })
  ).json();
  const job = await (await request.post(`${API_BASE}/attachments/${attachment.id}/extract`)).json();
  await waitForJob(request, job.id);
  const patched = await request.patch(`${API_BASE}/reports/${report.id}/fields`, {
    data: { extracted_fields: { work_performed: opts.workPerformed } },
  });
  expect(patched.ok()).toBeTruthy();
  if (opts.finalize) expect((await request.post(`${API_BASE}/reports/${report.id}/finalize`)).ok()).toBeTruthy();
  return report.id as string;
}

async function openReports(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.click('.view-tab:has-text("Reports")');
  await page.waitForSelector('.report-table, .empty-hint');
}

test('search finds finalized reports with an excerpt, skips drafts, and highlights on open', async ({ page, request }) => {
  const stamp = Date.now();
  const word = `zyxwv${stamp}`;
  const technician = `E2E-Search-Tech-${stamp}`;
  const hitId = await seedTextReport(request, {
    technician,
    workPerformed: `Replaced the ${word} sheath filter and flushed the line`,
    finalize: true,
  });
  await seedTextReport(request, {
    technician: `${technician}-draft`,
    workPerformed: `Draft that also mentions ${word}`,
    finalize: false,
  });

  await openReports(page);
  await page.fill('input[aria-label="Search reports"]', word);

  const rows = page.locator('.report-row-body');
  await expect(rows).toHaveCount(1);
  await expect(page.locator('[data-testid="result-count"]')).toContainText('1 finalized report match');
  const excerpt = page.locator('[data-testid="excerpt"]');
  await expect(excerpt).toContainText('Work performed');
  await expect(excerpt.locator('mark')).toHaveText(word);

  // Open the result: the matched word is highlighted above the fields.
  await rows.first().click();
  const matches = page.locator('[data-testid="search-matches"]');
  await expect(matches).toBeVisible({ timeout: 15_000 });
  await expect(matches.locator('mark')).toHaveText(word);
  await matches.locator('button:has-text("Clear")').click();
  await expect(matches).toHaveCount(0);

  // Back keeps the search.
  await page.click('button:has-text("← Back to reports")');
  await expect(page.locator('input[aria-label="Search reports"]')).toHaveValue(word);
  await expect(page.locator('.report-row-body')).toHaveCount(1);
  expect(hitId).toBeTruthy();

  // The lab manager's name is not searched.
  await page.fill('input[aria-label="Search reports"]', technician);
  await expect(page.locator('[data-testid="empty-hint"]')).toContainText('No finalized reports contain');

  await page.click('button:has-text("Clear filters")');
  await expect(page.locator('input[aria-label="Search reports"]')).toHaveValue('');
});

test('search says it covers finalized reports only when the status filter is something else', async ({ page, request }) => {
  const stamp = Date.now();
  const word = `qwertyu${stamp}`;
  await seedTextReport(request, {
    technician: `E2E-Search-Status-${stamp}`,
    workPerformed: `Cleaned the ${word} nozzle`,
    finalize: true,
  });

  await openReports(page);
  await page.fill('input[aria-label="Search reports"]', word);
  await expect(page.locator('.report-row-body')).toHaveCount(1);

  await page.selectOption('.filter-row select >> nth=2', 'draft');
  await expect(page.locator('[data-testid="empty-hint"]')).toContainText('Search covers finalized reports only');

  await page.selectOption('.filter-row select >> nth=2', 'finalized');
  await expect(page.locator('.report-row-body')).toHaveCount(1);

  // Another filter that excludes it gives the plain no-match message.
  await page.selectOption('.filter-row select >> nth=1', 'installation_upgrade');
  await expect(page.locator('[data-testid="empty-hint"]')).toContainText(`No finalized reports contain “${word}”`);
});

test('a one-character search is not sent and shows a hint; several words must all appear', async ({ page, request }) => {
  const stamp = Date.now();
  const a = `alphaone${stamp}`;
  const b = `betatwo${stamp}`;
  await seedTextReport(request, { technician: `E2E-Words-A-${stamp}`, workPerformed: `Checked ${a} and ${b}`, finalize: true });
  await seedTextReport(request, { technician: `E2E-Words-B-${stamp}`, workPerformed: `Checked only ${a}`, finalize: true });

  await openReports(page);
  await page.fill('input[aria-label="Search reports"]', 'x');
  await expect(page.locator('.search-hint')).toContainText('at least 2 characters');
  await expect(page.locator('[data-testid="result-count"]')).not.toContainText('match');

  await page.fill('input[aria-label="Search reports"]', a);
  await expect(page.locator('.report-row-body')).toHaveCount(2);
  await page.fill('input[aria-label="Search reports"]', `${a} ${b}`);
  await expect(page.locator('.report-row-body')).toHaveCount(1);
  await page.fill('input[aria-label="Search reports"]', `${a} -${b}`);
  await expect(page.locator('.report-row-body')).toHaveCount(1);
  await expect(page.locator('[data-testid="excerpt"]')).toContainText(`only ${a}`);
});
