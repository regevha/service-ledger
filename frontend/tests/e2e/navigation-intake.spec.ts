import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './coverage';
import { uniqueFixture } from './unique-upload';
import { TIMEOUT } from './timeouts';
import { API_BASE, seedReport } from './helpers/api';

import { finalizeFromReview } from './finalize-helper';
// UI review items #16-#19: the processing panel (what is being read, how long, a way out), the
// success screen (where to go next), the one-line classify instruction, and the address bar
// following the app (Refresh, Back and bookmarks).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'confident-scan.pdf');

async function finalizeOne(page: import('@playwright/test').Page, technician: string) {
  await page.goto('/');
  await page.fill('input[placeholder="Your name (optional)"]', technician);
  await page.getByTestId('intake-file-input').setInputFiles(uniqueFixture(FIXTURE));
  await page.click('button:has-text("Upload & classify")');
  await expect(page.locator('.field-list')).toBeVisible({ timeout: TIMEOUT.flow });
  await finalizeFromReview(page);
  await expect(page.getByTestId('intake-success')).toBeVisible({ timeout: TIMEOUT.ui });
}

test.describe('address bar', () => {
  test('tabs are addressable: the hash follows, Refresh keeps the tab, Back returns to the last one', async ({ page }) => {
    await page.goto('/');
    await page.click('.view-tab:has-text("Instruments")');
    await expect(page).toHaveURL(/#\/instruments$/);
    await page.click('.view-tab:has-text("Templates")');
    await expect(page).toHaveURL(/#\/templates$/);

    await page.reload();
    await expect(page.locator('.view-tab.active')).toHaveText('Templates');

    await page.goBack();
    await expect(page.locator('.view-tab.active')).toHaveText('Instruments');
    await expect(page).toHaveURL(/#\/instruments$/);
  });

  test('an unknown address falls back to New report', async ({ page }) => {
    await page.goto('/#/nonsense/whatever');
    await expect(page.locator('.view-tab.active')).toHaveText('New report');
  });

  test('an open report has its own address; Refresh keeps it open and Back returns to the list', async ({ page }) => {
    const marker = `E2E-Nav-${Date.now()}`;
    await finalizeOne(page, marker);
    await page.click('.view-tab:has-text("Reports")');
    await page.click(`.report-row-body:has-text("${marker}")`);
    await expect(page.locator('.field-list')).toBeVisible({ timeout: TIMEOUT.ui });
    await expect(page).toHaveURL(/#\/reports\/[0-9a-f-]{36}$/);

    await page.reload();
    await expect(page.locator('.field-list')).toBeVisible({ timeout: TIMEOUT.ui });
    await expect(page.locator('.view-tab.active')).toHaveText('Reports');

    await page.goBack();
    await expect(page.locator('.report-table')).toBeVisible();
    await expect(page).toHaveURL(/#\/reports$/);
    await page.goForward();
    await expect(page.locator('.field-list')).toBeVisible({ timeout: TIMEOUT.ui });
  });

  test('a link to a report that does not exist lands on the list, not a blank screen', async ({ page, request }) => {
    // The list only draws its table when there is at least one report.
    await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: `E2E-DeadLink-${Date.now()}` });
    await page.goto('/#/reports/00000000-0000-0000-0000-000000000000');
    await expect(page.locator('.report-table')).toBeVisible();
    await expect(page).toHaveURL(/#\/reports$/);
  });

  test('an instrument page has its own address too', async ({ page, request }) => {
    const instruments = await (await request.get(`${API_BASE}/instruments`)).json();
    const target = instruments[0];
    await page.goto(`/#/reports/instrument/${target.id}`);
    await expect(page.locator('.back-link')).toBeVisible({ timeout: TIMEOUT.ui });
    await expect(page.locator('body')).toContainText(target.name);
    await page.click('.back-link');
    await expect(page).toHaveURL(/#\/reports$/);
  });
});

test.describe('intake flow', () => {
  test('while reading: the file name, a time hint and a way to cancel; Cancel returns to a clean upload screen', async ({ page }) => {
    // Hold the upload back so the processing panel stays up long enough to look at.
    await page.route('**/reports/*/attachments', async (route) => {
      if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, 2500));
      await route.continue();
    });
    await page.goto('/');
    await page.getByTestId('intake-file-input').setInputFiles(uniqueFixture(FIXTURE));
    // Cancel cannot stop the upload already on its way: it carries on in the background. Waiting for
    // its answer (and for the network to go quiet after it) is how the test knows the abandoned run is over.
    const abandonedUpload = page.waitForResponse((r) => r.request().method() === 'POST' && /\/reports\/[^/]+\/attachments$/.test(r.url()));
    await page.click('button:has-text("Upload & classify")');

    const panel = page.getByTestId('intake-working');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('intake-working-file')).toContainText('.pdf');
    await expect(panel).toContainText(/\d+s/);
    await expect(panel.getByRole('button', { name: 'Cancel' })).toBeVisible();

    await panel.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('intake-dropzone')).toBeVisible();
    await expect(page.getByTestId('intake-working')).toHaveCount(0);
    // Whatever the abandoned run does afterwards must not pull the screen back.
    await abandonedUpload;
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('intake-dropzone')).toBeVisible();
    await expect(page.getByTestId('intake-working')).toHaveCount(0);
  });

  test('while saving: the review screen stays in place, both buttons wait, and there is nothing to cancel', async ({ page }) => {
    await page.route('**/reports/*/finalize', async (route) => {
      await new Promise((r) => setTimeout(r, 1200));
      await route.continue();
    });
    await page.goto('/');
    await page.getByTestId('intake-file-input').setInputFiles(uniqueFixture(FIXTURE));
    await page.click('button:has-text("Upload & classify")');
    await expect(page.locator('.field-list')).toBeVisible({ timeout: TIMEOUT.flow });
    await finalizeFromReview(page);
    // The form is still there; the buttons say what is happening and cannot be pressed twice.
    await expect(page.locator('button:has-text("Finalizing…")')).toBeDisabled();
    await expect(page.locator('button:has-text("Save corrections")')).toBeDisabled();
    await expect(page.locator('.field-list')).toBeVisible();
    await expect(page.locator('.working-panel')).toHaveCount(0);
    await expect(page.locator('.steps .step.active')).toContainText('Review & finalize');
    await expect(page.locator('.success-panel')).toBeVisible({ timeout: 15_000 });
  });

  test('the success screen says where to go next: no internal id, ISO date, all steps done', async ({ page }) => {
    const marker = `E2E-Done-${Date.now()}`;
    await finalizeOne(page, marker);
    const panel = page.getByTestId('intake-success');
    await expect(panel.locator('code')).toHaveCount(0);
    await expect(panel).not.toContainText(/[0-9a-f]{8}\b.*finalized/);
    await expect(panel).toContainText(/Saved on \d{4}-\d{2}-\d{2}/);
    await expect(page.locator('.steps .step.done')).toHaveCount(3);
    await expect(page.locator('.steps .step.active')).toHaveCount(0);

    await panel.getByTestId('intake-open-report').click();
    await expect(page.locator('.field-list')).toBeVisible({ timeout: TIMEOUT.ui });
    await expect(page).toHaveURL(/#\/reports\/[0-9a-f-]{36}$/);
    await expect(page.locator('.review-actions')).toContainText('Finalized');
  });

  test('"View instrument" opens the instrument the report belongs to', async ({ page }) => {
    await finalizeOne(page, `E2E-DoneInstr-${Date.now()}`);
    await page.getByTestId('intake-view-instrument').click();
    await expect(page.locator('.back-link')).toBeVisible({ timeout: TIMEOUT.ui });
    await expect(page).toHaveURL(/#\/reports\/instrument\/[0-9a-f-]{36}$/);
  });

  test('the classify screen asks for one thing, in one line', async ({ page }) => {
    // The sample work order's name is one of the stub's "needs confirming" markers (see manual-confirm.spec.ts).
    await page.goto('/');
    await page.getByTestId('intake-file-input').setInputFiles(uniqueFixture(path.join(__dirname, 'fixtures', 'sample-work-order.pdf')));
    await page.click('button:has-text("Upload & classify")');
    const hint = page.locator('.section:has(.section-title:has-text("Detected from the document")) .hint-text');
    await expect(hint).toBeVisible({ timeout: TIMEOUT.flow });
    await expect(hint).toHaveText('Check the instrument and the report type, then continue.');
  });
});
