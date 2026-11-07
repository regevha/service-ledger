import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './coverage';
import { uniquePdf } from './unique-upload';
import { API_BASE } from './helpers/api';
import { finalizeFromReview } from './finalize-helper';
import { summarize, runPool, stateForReportStatus, needsPerson, type BatchItem } from '../../src/batchState';

const CONFIDENT = readFileSync(path.join(process.cwd(), 'tests/e2e/fixtures/confident-scan.pdf'));
const UNSURE = readFileSync(path.join(process.cwd(), 'tests/e2e/fixtures/sample-work-order.pdf'));

// Several files at once: each is read on its own and ends ready to check, or stopped with a reason.

test('pure helpers: counts, states and the pool limit', async () => {
  const item = (state: BatchItem['state']): BatchItem => ({ id: 1, file: new File([], 'a.pdf'), state });
  expect(summarize([item('ready'), item('approved'), item('queued'), item('uploading'), item('failed'), item('duplicate')])).toEqual({
    total: 6,
    ready: 1,
    approved: 1,
    working: 2,
    stopped: 2,
  });
  expect(stateForReportStatus('finalized')).toBe('approved');
  expect(stateForReportStatus('extracted')).toBe('ready');
  expect(needsPerson(item('ready'))).toBe(true);
  expect(needsPerson(item('approved'))).toBe(false);

  let running = 0;
  let peak = 0;
  const seen: number[] = [];
  await runPool([1, 2, 3, 4, 5], 2, async (n) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 10));
    seen.push(n);
    running -= 1;
  });
  expect(peak).toBe(2);
  expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
});

test('several PDFs are read one by one and each is checked on its report screen', async ({ page, request }) => {
  const tech = `E2E-Batch-${Date.now()}`;
  await page.goto('/');
  await page.getByTestId('tab-new').click();
  await page.getByTestId('open-batch').click();
  await expect(page.getByTestId('batch-screen')).toBeVisible();
  await expect(page).toHaveURL(/#\/batch/);
  await expect(page.getByTestId('tab-new')).toHaveAttribute('aria-current', 'page');

  await page.getByTestId('batch-input').setInputFiles([
    { name: 'confident-a.pdf', mimeType: 'application/pdf', buffer: uniquePdf(CONFIDENT) },
    { name: 'confident-b.pdf', mimeType: 'application/pdf', buffer: uniquePdf(CONFIDENT) },
    { name: 'sample-work-order.pdf', mimeType: 'application/pdf', buffer: uniquePdf(UNSURE) },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a report') },
  ]);
  // The text file is left out with a reason; the three PDFs wait to be read.
  await expect(page.getByRole('status').filter({ hasText: 'not a PDF or an image' })).toBeVisible();
  await expect(page.getByTestId('batch-row')).toHaveCount(3);
  await expect(page.getByTestId('batch-row').first()).toHaveAttribute('data-state', 'queued');

  await page.getByLabel('Technician name').fill(tech);
  await page.getByTestId('batch-start').click();

  // The two confident files end ready to check; the one the stub cannot place stops with a reason.
  await expect(page.locator('[data-testid=batch-row][data-state=ready]')).toHaveCount(2, { timeout: 90_000 });
  await expect(page.getByTestId('batch-counts')).toContainText('2 ready to check');
  const stopped = page.locator('[data-testid=batch-row][data-state=attention], [data-testid=batch-row][data-state=ready]');
  await expect(stopped).toHaveCount(3, { timeout: 90_000 });

  // Check one on the normal report screen, finalize it, and come back: it shows as approved.
  await page.getByTestId('batch-row').first().getByRole('button', { name: 'Check' }).click();
  await expect(page).toHaveURL(/#\/reports\//);
  await finalizeFromReview(page);
  const reportId = page.url().split('/reports/')[1];
  await expect
    .poll(async () => ((await (await request.get(`${API_BASE}/reports/${reportId}`)).json()) as { status: string }).status, { timeout: 15_000 })
    .toBe('finalized');
  await page.goto('/#/batch');
  await expect(page.getByTestId('batch-row').first()).toHaveAttribute('data-state', 'approved', { timeout: 15_000 });
  await expect(page.getByTestId('batch-counts')).toContainText('1 approved');
});

test('an exact file read before is shown as already on file', async ({ page }) => {
  const same = uniquePdf(CONFIDENT);
  await page.goto('/#/batch');
  await page.getByTestId('batch-input').setInputFiles({ name: 'first.pdf', mimeType: 'application/pdf', buffer: same });
  await page.getByTestId('batch-start').click();
  await expect(page.locator('[data-testid=batch-row][data-state=ready]')).toHaveCount(1, { timeout: 90_000 });
  await page.getByTestId('batch-input').setInputFiles({ name: 'again.pdf', mimeType: 'application/pdf', buffer: same });
  await page.getByTestId('batch-start').click();
  await expect(page.locator('[data-testid=batch-row][data-state=duplicate]')).toHaveCount(1, { timeout: 30_000 });
});
