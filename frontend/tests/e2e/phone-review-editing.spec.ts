import { type Locator, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './coverage';
import { uniqueFixture } from './unique-upload';

// Phone coverage for editing on the review screen (docs: claude/plan-phone-e2e-tests.md, item 4): typing a value,
// saving, finalizing with flagged fields, the unsaved-changes question and a failed save. Where the desktop specs
// (review-screen-ux, unsaved-changes) check what happens, these check that it can be done with a thumb: every
// action is a tap, and every bar, question and button is inside the screen and big enough to hit.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIDENT_SCAN = path.join(__dirname, 'fixtures', 'confident-scan.pdf');

async function openIntakeReview(page: Page) {
  await page.goto('/#/new');
  await page.locator('input[type="file"]').setInputFiles(uniqueFixture(CONFIDENT_SCAN));
  await page.getByRole('button', { name: 'Upload & classify' }).tap();
  await page.waitForSelector('[data-testid="field-list"]', { timeout: 30_000 });
}

// The stub flags a varying number of fields; reporting the service date at 10% confidence flags at least one every run.
async function flagServiceDate(page: Page) {
  await page.route('**/extraction-jobs/*', async (route) => {
    const response = await route.fetch();
    const job = await response.json();
    if (job && typeof job === 'object') job.field_confidences = { ...(job.field_confidences ?? {}), report_date: 0.1 };
    await route.fulfill({ response, json: job });
  });
}

const editable = (page: Page) => page.locator('[data-testid="field-list"] textarea, [data-testid="field-list"] input[type="number"]').first();

async function insideScreen(page: Page, locator: Locator, what: string) {
  const box = (await locator.boundingBox())!;
  const { width, height } = page.viewportSize()!;
  expect(box.x, `${what} starts left of the screen`).toBeGreaterThanOrEqual(-0.5);
  expect(box.x + box.width, `${what} ends right of the screen`).toBeLessThanOrEqual(width + 0.5);
  expect(box.y, `${what} starts above the screen`).toBeGreaterThanOrEqual(-0.5);
  expect(box.y + box.height, `${what} ends below the screen`).toBeLessThanOrEqual(height + 0.5);
}

async function thumbSized(buttons: Locator, what: string) {
  for (let i = 0; i < (await buttons.count()); i++) {
    const box = (await buttons.nth(i).boundingBox())!;
    expect(box.height, `${what} button ${i + 1} is too small to tap`).toBeGreaterThanOrEqual(43.5);
  }
}

test.describe('editing a report on a phone', { tag: '@phone' }, () => {
  test('typing a value keeps the save bar in view, and Save corrections saves it', async ({ page }) => {
    await flagServiceDate(page);
    await openIntakeReview(page);
    const field = editable(page);
    await field.tap();
    await field.fill('12');
    await insideScreen(page, page.locator('.review-actions'), 'the save bar');
    await page.getByRole('button', { name: 'Save corrections' }).tap();
    await expect(page.locator('.toast')).toHaveText('Saved');
    await expect(field).toHaveValue('12');
  });

  test('finalizing with flagged fields: the question fits the screen, Review them goes to the field, Finalize anyway finalizes', async ({ page }) => {
    await flagServiceDate(page);
    await openIntakeReview(page);
    const flagged = await page.locator('.field.pending').count();
    expect(flagged).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Save & finalize report' }).tap();
    const question = page.locator('#finalize-confirm');
    await expect(question).toBeVisible();
    // The screen scrolls the question into view smoothly, so give it a moment to arrive.
    await expect(async () => insideScreen(page, question, 'the finalize question')).toPass({ timeout: 5_000 });
    await thumbSized(question.getByRole('button'), 'finalize question');
    await expect(page.locator('.success-panel')).toHaveCount(0);

    await question.getByRole('button', { name: 'Review them' }).tap();
    await expect(question).toHaveCount(0);
    await expect(page.locator('.field.pending')).toHaveCount(flagged);

    await page.getByRole('button', { name: 'Save & finalize report' }).tap();
    await page.getByRole('button', { name: 'Finalize anyway' }).tap();
    await expect(page.locator('.success-panel')).toBeVisible({ timeout: 15_000 });
  });

  test('leaving with unsaved edits: the question fits the screen; Stay keeps the edit, Discard changes leaves', async ({ page }) => {
    await openIntakeReview(page);
    const field = editable(page);
    await field.fill('12');

    await page.getByTestId('tab-reports').tap();
    const dialog = page.locator('#leave-dialog');
    await expect(dialog).toBeVisible();
    await insideScreen(page, dialog, 'the unsaved-changes question');
    await thumbSized(dialog.getByRole('button'), 'unsaved-changes question');

    await dialog.getByRole('button', { name: 'Stay' }).tap();
    await expect(dialog).toHaveCount(0);
    await expect(field).toHaveValue('12');

    await page.getByTestId('tab-reports').tap();
    await page.locator('#leave-dialog').getByRole('button', { name: 'Discard changes' }).tap();
    await expect(page.getByTestId('tab-reports')).toHaveAttribute('aria-current', 'page');
  });

  test('a failed save shows the reason, keeps what was typed, and Try again saves', async ({ page }) => {
    let failNext = true;
    await page.route('**/reports/*/fields', (route) => {
      if (route.request().method() === 'PATCH' && failNext) {
        failNext = false;
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'Simulated save failure' }) });
      }
      return route.continue();
    });
    await openIntakeReview(page);
    const field = editable(page);
    await field.fill('12');
    await page.getByRole('button', { name: 'Save corrections' }).tap();

    const error = page.locator('#save-error');
    await expect(error).toContainText('Simulated save failure');
    await expect(field).toHaveValue('12');
    const retry = error.getByRole('button', { name: 'Try again' });
    await thumbSized(retry, 'Try again');
    await retry.tap();
    await expect(page.locator('.toast')).toHaveText('Saved');
    await expect(page.locator('#save-error')).toHaveCount(0);
    await expect(field).toHaveValue('12');
  });

  // KNOWN GAP (found 2026-11-09): the error banner sits above the fields and the screen does not scroll to it, so a
  // person who saved from the bar at the bottom of a long form sees nothing happen. Un-fixme this when the banner
  // is scrolled into view (as the finalize question already is).
  test.fixme('a failed save is in view without scrolling back up', async ({ page }) => {
    await page.route('**/reports/*/fields', (route) =>
      route.request().method() === 'PATCH'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'Simulated save failure' }) })
        : route.continue()
    );
    await openIntakeReview(page);
    await editable(page).fill('12');
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.getByRole('button', { name: 'Save corrections' }).tap();
    const error = page.locator('#save-error');
    await expect(error).toContainText('Simulated save failure');
    await expect(async () => insideScreen(page, error, 'the save error')).toPass({ timeout: 3_000 });
  });
});
