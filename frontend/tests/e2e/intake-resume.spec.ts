import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './coverage';
import { uniqueFixture } from './unique-upload';
import { TIMEOUT } from './timeouts';

// "Try again" after the wait ran out goes back to waiting for the same job (review of 2026-10-29,
// finding 2). It used to submit the document a second time, so the scan was read twice.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'confident-scan.pdf');

test('Try again after a timeout waits for the same job instead of submitting another', async ({ page }) => {
  const submits: string[] = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (r.method() === 'POST' && /\/attachments\/[^/]+\/(translate|classify|extract)$/.test(path)) submits.push(path.split('/').pop()!);
  });

  await page.clock.install();
  // The browser's view of every job: still pending, so the wait runs out.
  await page.route('**/extraction-jobs/*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const real = await route.fetch();
    const job = await real.json();
    await route.fulfill({ response: real, json: { ...job, status: 'pending', error_message: null } });
  });

  await page.goto('/');
  await page.click('.view-tab:has-text("New report")');
  await page.getByTestId('intake-file-input').setInputFiles(uniqueFixture(FIXTURE));
  await page.click('button:has-text("Upload & classify")');
  await expect(page.getByTestId('intake-working')).toBeVisible({ timeout: TIMEOUT.ui });
  await expect
    .poll(async () => {
      await page.clock.runFor(20_000);
      return page.getByTestId('intake-error').count();
    }, { timeout: TIMEOUT.flow })
    .toBe(1);
  expect(submits).toEqual(['translate']);

  // The worker answers now. Try again picks the same job up, and the flow goes on, one step at a time.
  await page.unroute('**/extraction-jobs/*');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.field-list, [data-testid="class-row"]').first()).toBeVisible({ timeout: TIMEOUT.flow });
  expect(submits.filter((s) => s === 'translate')).toHaveLength(1);
  expect(submits.filter((s) => s === 'classify')).toHaveLength(1);
});
