import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './coverage';
import { uniqueFixture } from './unique-upload';
import { TIMEOUT } from './timeouts';
import { API_BASE } from './helpers/api';

// Intake review of 2026-10-29: the file can be chosen with the keyboard (item 2), the step bar follows
// the real step and keeps showing the one that failed (item 6), a refused file offers another file
// instead of the same failing retry (item 5), and the name box has a label (item 15).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'confident-scan.pdf');

const activeStep = (page: import('@playwright/test').Page) => page.locator('.steps .step.active');

test('the name box has a label, and Tab from it reaches the file picker', async ({ page }) => {
  await page.goto('/');
  await page.click('.view-tab:has-text("New report")');
  const name = page.getByLabel('Your name (optional)');
  await name.focus();
  await page.keyboard.press('Tab');
  const picker = page.getByLabel('Choose a scan or PDF');
  await expect(picker).toBeFocused();
  // The drop zone shows where the focus is.
  expect(await page.getByTestId('intake-dropzone').evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none');

  await picker.setInputFiles(uniqueFixture(FIXTURE));
  await expect(page.getByTestId('intake-dropzone')).toContainText('confident-scan');
  await expect(page.getByRole('button', { name: /Upload & classify/ })).toBeEnabled();
});

test('the step bar counts the upload as step 1 until it is finished', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/reports/*/attachments', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await gate;
    await route.continue();
  });
  await page.goto('/');
  await page.click('.view-tab:has-text("New report")');
  await page.getByTestId('intake-file-input').setInputFiles(uniqueFixture(FIXTURE));
  await page.click('button:has-text("Upload & classify")');

  await expect(page.getByTestId('intake-working')).toContainText('Uploading');
  await expect(activeStep(page)).toHaveText(/Upload/);
  await expect(page.locator('.steps .step.done')).toHaveCount(0);

  release();
  await expect(activeStep(page)).toHaveText(/Classify|Review/, { timeout: TIMEOUT.flow });
});

test('when reading the document fails, the step bar stays on Classify and the message names the step', async ({ page }) => {
  await page.route('**/attachments/*/classify', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'The reading service is down.' }) })
  );
  await page.goto('/');
  await page.click('.view-tab:has-text("New report")');
  await page.getByTestId('intake-file-input').setInputFiles(uniqueFixture(FIXTURE));
  await page.click('button:has-text("Upload & classify")');

  const error = page.getByTestId('intake-error');
  await expect(error).toBeVisible({ timeout: TIMEOUT.flow });
  await expect(error).toContainText('Reading the document failed');
  await expect(error).toContainText('confident-scan');
  await expect(error).toContainText('The reading service is down.');
  await expect(activeStep(page)).toHaveText(/Classify/);
  await expect(page.locator('.steps .step.failed')).toHaveText(/Classify/);
  await expect(page.locator('.steps .step.done')).toHaveCount(1); // Upload is done
});

test('a refused file offers another file, not the same retry, and removes the empty draft', async ({ page, request }) => {
  const marker = `E2E-Refused-${Date.now()}`;
  await page.route('**/reports/*/attachments', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 413, contentType: 'application/json', body: JSON.stringify({ detail: 'This image is 6.0 MB; the limit is 5 MB.' }) })
      : route.continue()
  );
  await page.goto('/');
  await page.click('.view-tab:has-text("New report")');
  await page.getByLabel('Your name (optional)').fill(marker);
  await page.getByTestId('intake-file-input').setInputFiles(uniqueFixture(FIXTURE));
  await page.click('button:has-text("Upload & classify")');

  await expect(page.getByTestId('intake-error')).toContainText('The upload failed', { timeout: TIMEOUT.ui });
  await expect(page.getByTestId('intake-error')).toContainText('the limit is 5 MB');
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await expect(activeStep(page)).toHaveText(/Upload/);

  const all = await (await request.get(`${API_BASE}/reports`)).json();
  expect((all.items ?? all).filter((r: { technician_name?: string }) => r.technician_name === marker)).toEqual([]);

  await page.getByRole('button', { name: 'Choose another file' }).click();
  await expect(page.getByTestId('intake-dropzone')).toBeVisible();
  await expect(page.getByLabel('Your name (optional)')).toHaveValue(marker);
});
