import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './coverage';
import { uniqueFixture } from './unique-upload';
import { TIMEOUT } from './timeouts';
import { API_BASE, seedReport } from './helpers/api';
import { openReviewFromList } from './helpers/ui';

// Things that go wrong when two requests, two pages or a slow worker are involved: a finalize sent
// twice, a report finalized from two tabs, and an extraction that never finishes.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'confident-scan.pdf');
const SAVE_AND_FINALIZE = 'button:has-text("Save & finalize report")';

test('finalize sent twice at once: one wins, the other is refused, nothing breaks', async ({ request }) => {
  const { reportId } = await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: `E2E-Double-${Date.now()}` });
  const [a, b] = await Promise.all([
    request.post(`${API_BASE}/reports/${reportId}/finalize`),
    request.post(`${API_BASE}/reports/${reportId}/finalize`),
  ]);
  const statuses = [a.status(), b.status()].sort();
  // Never a server error, and at least one of them finalized the report. The second one is a 409
  // ("cannot finalize a report in status finalized") when it arrives after the first has committed.
  expect(statuses.every((s) => s === 200 || s === 409), `got ${statuses}`).toBe(true);
  expect(statuses).toContain(200);

  const report = await (await request.get(`${API_BASE}/reports/${reportId}`)).json();
  expect(report.status).toBe('finalized');
  expect(report.finalized_at).toBeTruthy();
});

test('a double click on Save & finalize in the intake flow makes one finalized report', async ({ page, request }) => {
  const marker = `E2E-DoubleClick-${Date.now()}`;
  await page.goto('/');
  await page.click('.view-tab:has-text("New report")');
  await page.fill('input[placeholder="Your name (optional)"]', marker);
  await page.getByTestId('intake-file-input').setInputFiles(uniqueFixture(FIXTURE));
  await page.click('button:has-text("Upload & classify")');
  await expect(page.locator('.field-list')).toBeVisible({ timeout: TIMEOUT.flow });

  await page.locator(SAVE_AND_FINALIZE).dblclick();
  await expect(page.getByTestId('intake-success')).toBeVisible({ timeout: TIMEOUT.ui });
  await expect(page.getByTestId('intake-error')).toHaveCount(0);

  const reports = await (await request.get(`${API_BASE}/reports`)).json();
  const mine = (reports.items ?? reports).filter((r: { technician_name?: string }) => r.technician_name === marker);
  expect(mine).toHaveLength(1);
  expect(mine[0].status).toBe('finalized');
});

test('finalizing a report that another page already finalized shows the refusal and leaves it finalized', async ({ browser, request }) => {
  const marker = `E2E-TwoPages-${Date.now()}`;
  const { reportId } = await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: marker });

  const first = await (await browser.newContext()).newPage();
  const second = await (await browser.newContext()).newPage();
  try {
    await openReviewFromList(first, marker);
    await openReviewFromList(second, marker);
    await expect(first.locator(SAVE_AND_FINALIZE)).toBeVisible();
    await expect(second.locator(SAVE_AND_FINALIZE)).toBeVisible();

    await first.locator(SAVE_AND_FINALIZE).click();
    await expect(first.locator('.review-actions')).toContainText('Finalized', { timeout: TIMEOUT.ui });

    // The second page still shows the old state. Its attempt is refused and says so.
    await second.locator(SAVE_AND_FINALIZE).click();
    await expect(second.locator('#save-error')).toContainText("Cannot finalize a report in status 'finalized'", { timeout: TIMEOUT.ui });
  } finally {
    await first.context().close();
    await second.context().close();
  }
  const report = await (await request.get(`${API_BASE}/reports/${reportId}`)).json();
  expect(report.status).toBe('finalized');
});

test('an extraction that never finishes stays pending, then offers Try again', async ({ page }) => {
  // The worker is stood in for by the browser: every poll of the job answers "pending".
  await page.clock.install();
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

  // Still waiting, with a way out, while the poll runs.
  await expect(page.getByTestId('intake-working')).toBeVisible({ timeout: TIMEOUT.ui });
  await page.clock.runFor(30_000);
  await expect(page.getByTestId('intake-working')).toBeVisible();
  await expect(page.getByTestId('intake-cancel')).toBeVisible();

  // Past the 90 second limit the poll gives up and says so.
  await expect
    .poll(async () => {
      await page.clock.runFor(20_000);
      return page.getByTestId('intake-error').count();
    }, { timeout: TIMEOUT.flow })
    .toBe(1);
  await expect(page.getByTestId('intake-error')).toContainText('did not finish');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start over' })).toBeVisible();

  // Try again with a worker that answers: it goes through.
  await page.unroute('**/extraction-jobs/*');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.field-list, [data-testid="class-row"]').first()).toBeVisible({ timeout: TIMEOUT.flow });
});
