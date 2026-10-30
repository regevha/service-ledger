import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './coverage';
import { uniqueFixture } from './unique-upload';
import { TIMEOUT } from './timeouts';
import { API_BASE } from './helpers/api';

// Cancel on the working screen (review of 2026-10-29): it stops the work and leaves nothing behind.
// The job is cancelled, the draft report this attempt created is removed, and no later step
// (classify, extract) is started afterwards.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'confident-scan.pdf');

async function reportsBy(request: import('@playwright/test').APIRequestContext, marker: string) {
  const all = await (await request.get(`${API_BASE}/reports`)).json();
  return (all.items ?? all).filter((r: { technician_name?: string }) => r.technician_name === marker);
}

test('Cancel while the document is being read cancels the job, removes the draft and starts nothing else', async ({ page, request }) => {
  const marker = `E2E-Cancel-${Date.now()}`;
  const sent: string[] = [];
  page.on('request', (r) => sent.push(`${r.method()} ${new URL(r.url()).pathname}`));

  // Hold every answer about a job, so the screen is still waiting when Cancel is pressed. When the
  // answers are let go the job is finished: the screen must not go on to the next step.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/extraction-jobs/*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await gate;
    await route.continue();
  });

  await page.goto('/');
  await page.click('.view-tab:has-text("New report")');
  await page.fill('input[placeholder="Your name (optional)"]', marker);
  await page.getByTestId('intake-file-input').setInputFiles(uniqueFixture(FIXTURE));
  await page.click('button:has-text("Upload & classify")');
  await expect(page.getByTestId('intake-working')).toBeVisible({ timeout: TIMEOUT.ui });
  await expect.poll(() => sent.filter((s) => s.startsWith('POST') && s.endsWith('/translate')).length, { timeout: TIMEOUT.ui }).toBe(1);

  const mark = sent.length;
  await page.getByTestId('intake-cancel').click();
  await expect(page.getByTestId('intake-dropzone')).toBeVisible({ timeout: TIMEOUT.ui });
  release();
  await page.waitForTimeout(1500);

  const after = sent.slice(mark);
  expect(after.some((s) => /^POST \/extraction-jobs\/[^/]+\/cancel$/.test(s)), `after Cancel: ${after}`).toBe(true);
  expect(after.some((s) => /^DELETE \/reports\/[^/]+$/.test(s)), `after Cancel: ${after}`).toBe(true);
  expect(after.filter((s) => s.endsWith('/classify') || s.endsWith('/extract') || s.endsWith('/translate'))).toEqual([]);
  expect(await reportsBy(request, marker)).toEqual([]);
  await expect(page.getByTestId('intake-error')).toHaveCount(0);
});

test('Cancel right after pressing Upload leaves no draft either', async ({ page, request }) => {
  const marker = `E2E-CancelEarly-${Date.now()}`;
  await page.goto('/');
  await page.click('.view-tab:has-text("New report")');
  await page.fill('input[placeholder="Your name (optional)"]', marker);
  await page.getByTestId('intake-file-input').setInputFiles(uniqueFixture(FIXTURE));
  await page.click('button:has-text("Upload & classify")');
  await page.getByTestId('intake-cancel').click();
  await expect(page.getByTestId('intake-dropzone')).toBeVisible({ timeout: TIMEOUT.ui });
  // Whatever step the request was in, the draft is gone once things settle.
  await expect.poll(async () => (await reportsBy(request, marker)).length, { timeout: TIMEOUT.ui }).toBe(0);
  await expect(page.getByTestId('intake-error')).toHaveCount(0);
});
