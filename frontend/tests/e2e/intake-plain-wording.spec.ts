import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './coverage';
import { uniqueFixture } from './unique-upload';
import { TIMEOUT } from './timeouts';

// Intake review of 2026-10-29, items 13 and 14: progress labels and errors in plain words, with the
// server's own text kept under "Details for support".

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'confident-scan.pdf');

async function startIntake(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.click('.view-tab:has-text("New report")');
  await page.getByTestId('intake-file-input').setInputFiles(uniqueFixture(FIXTURE));
  await page.click('button:has-text("Upload & classify")');
}

test('progress is described in plain words, in order', async ({ page }) => {
  const seen = new Set<string>();
  const watch = setInterval(() => {
    void page
      .getByTestId('intake-working')
      .innerText({ timeout: 200 })
      .then((t) => seen.add(t.split('\n')[0]))
      .catch(() => undefined);
  }, 100);
  // Slow the worker's answers a little so each stage is on screen long enough to read.
  await page.route('**/extraction-jobs/*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await new Promise((r) => setTimeout(r, 350));
    await route.continue();
  });
  await startIntake(page);
  await expect(page.locator('.field-list, [data-testid="class-row"]').first()).toBeVisible({ timeout: TIMEOUT.flow });
  clearInterval(watch);

  const labels = [...seen].join(' | ');
  expect(labels).toContain('Reading the instrument and visit type');
  expect(labels).not.toMatch(/Claude|vision|resolved template|Classifying/);
});

test('a server error in developer words is shown as a plain sentence, with the original under Details', async ({ page }) => {
  const raw = 'Claude API request failed during extraction: Error code: 529 - {"type":"overloaded_error"}';
  await page.route('**/attachments/*/classify', (route) =>
    route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ detail: raw }) })
  );
  await startIntake(page);
  const error = page.getByTestId('intake-error');
  await expect(error).toBeVisible({ timeout: TIMEOUT.flow });
  await expect(error).toContainText('The reading service is busy. Try again in a minute.');
  await expect(error).not.toContainText('529');
  const details = page.getByTestId('intake-error-details');
  await expect(details).toContainText('Details for support');
  await details.locator('summary').click();
  await expect(details).toContainText(raw);
});

test('a message with no better wording is shown as it is, with no Details box', async ({ page }) => {
  await page.route('**/attachments/*/classify', (route) =>
    route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ detail: 'This document has no pages.' }) })
  );
  await startIntake(page);
  await expect(page.getByTestId('intake-error')).toContainText('This document has no pages.', { timeout: TIMEOUT.flow });
  await expect(page.getByTestId('intake-error-details')).toHaveCount(0);
});
