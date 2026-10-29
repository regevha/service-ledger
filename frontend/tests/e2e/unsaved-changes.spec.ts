import { type APIRequestContext, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './coverage';
import { uniqueFixture, uniquePdf } from './unique-upload';
import { BACKEND_PORT } from '../../playwright.config';

// Leaving a screen that has unsaved edits (PR 3 of the review-and-finalize plan): a tab, the browser's
// Back button, a screen's own Back and "Back to Classify" all ask first: Stay, Discard changes, Save and leave.

const API_BASE = `http://localhost:${BACKEND_PORT}`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIDENT_SCAN = path.join(__dirname, 'fixtures', 'confident-scan.pdf');

const dialog = (page: Page) => page.locator('#leave-dialog');
const firstText = (page: Page) => page.locator('.field-list textarea').first();

async function openIntakeReview(page: Page, startAt = '/') {
  await page.goto(startAt);
  await page.click('.view-tab:has-text("New report")');
  await page.locator('input[type="file"]').setInputFiles(uniqueFixture(CONFIDENT_SCAN));
  await page.click('button:has-text("Upload & classify")');
  await page.waitForSelector('.field-list', { timeout: 30_000 });
}

async function seedDraft(request: APIRequestContext, technician: string): Promise<string> {
  const report = await (await request.post(`${API_BASE}/reports`, { data: { technician_name: technician } })).json();
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
      multipart: { file: { name: 'seed.pdf', mimeType: 'application/pdf', buffer: uniquePdf('%PDF-1.4 seed') } },
    })
  ).json();
  const job = await (await request.post(`${API_BASE}/attachments/${attachment.id}/extract`)).json();
  for (let i = 0; i < 150; i++) {
    const j = await (await request.get(`${API_BASE}/extraction-jobs/${job.id}`)).json();
    if (j.status === 'succeeded' || j.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return report.id as string;
}

async function openSavedReport(page: Page, marker: string) {
  await page.goto('/');
  await page.click('.view-tab:has-text("Reports")');
  await page.waitForSelector('.report-table');
  await page.click(`.report-row-body:has-text("${marker}")`);
  await expect(page.locator('.field-list')).toBeVisible({ timeout: 15_000 });
}

test('a new report with unsaved edits: a tab asks first; Stay keeps everything where it was', async ({ page }) => {
  await openIntakeReview(page);
  await firstText(page).fill('Typed on the review screen');

  await page.click('.view-tab:has-text("Reports")');
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toContainText('not saved');
  await expect(dialog(page).getByRole('button', { name: 'Stay' })).toBeFocused();

  await dialog(page).getByRole('button', { name: 'Stay' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(/#\/new$/);
  await expect(page.locator('.field-list')).toBeVisible();
  await expect(firstText(page)).toHaveValue('Typed on the review screen');
});

test('Escape means Stay', async ({ page }) => {
  await openIntakeReview(page);
  await firstText(page).fill('Typed on the review screen');
  await page.click('.view-tab:has-text("Analytics")');
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(firstText(page)).toHaveValue('Typed on the review screen');
});

test('Discard changes leaves, and the edits are not saved', async ({ page }) => {
  await openIntakeReview(page);
  await firstText(page).fill('Typed and then discarded');
  await page.click('.view-tab:has-text("Reports")');
  await dialog(page).getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.locator('.report-table, .empty-hint').first()).toBeVisible();
  await expect(page).toHaveURL(/#\/reports$/);
  await expect(dialog(page)).toHaveCount(0);
});

test('Save and leave saves the edits, then leaves', async ({ page, request }) => {
  const marker = `Saved-by-leaving-${Date.now()}`;
  await openIntakeReview(page);
  await firstText(page).fill(marker);
  const saveRequest = page.waitForRequest((r) => r.method() === 'PATCH' && /\/reports\/[^/]+\/fields$/.test(r.url()));

  await page.click('.view-tab:has-text("Reports")');
  await dialog(page).getByRole('button', { name: 'Save and leave' }).click();
  const reportId = (await saveRequest).url().match(/\/reports\/([^/]+)\/fields$/)![1];

  await expect(page).toHaveURL(/#\/reports$/);
  await expect(dialog(page)).toHaveCount(0);
  const saved = await (await request.get(`${API_BASE}/reports/${reportId}`)).json();
  expect(JSON.stringify(saved.extracted_fields)).toContain(marker);
});

test('Save and leave with a failing save stays on the screen and shows why', async ({ page }) => {
  await openIntakeReview(page);
  await page.route('**/reports/*/fields', (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'Simulated save failure' }) })
      : route.continue()
  );
  await firstText(page).fill('Typed before a failing save');
  await page.click('.view-tab:has-text("Reports")');
  await dialog(page).getByRole('button', { name: 'Save and leave' }).click();

  await expect(dialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(/#\/new$/);
  await expect(page.locator('#save-error')).toContainText('Simulated save failure');
  await expect(firstText(page)).toHaveValue('Typed before a failing save');
});

test('nothing unsaved: tabs and Back to Classify just go, with no question', async ({ page }) => {
  await openIntakeReview(page);
  await page.click('.view-tab:has-text("Reports")');
  await expect(page).toHaveURL(/#\/reports$/);
  await expect(dialog(page)).toHaveCount(0);

  await page.click('.view-tab:has-text("New report")');
  await expect(page.locator('.dropzone')).toBeVisible(); // the intake flow was left, as before

  // Saved edits are no longer unsaved edits.
  await page.locator('input[type="file"]').setInputFiles(uniqueFixture(CONFIDENT_SCAN));
  await page.click('button:has-text("Upload & classify")');
  await page.waitForSelector('.field-list', { timeout: 30_000 });
  await firstText(page).fill('Typed and saved');
  await page.click('button:has-text("Save corrections")');
  await expect(page.locator('.toast')).toHaveText('Saved');
  await page.click('.view-tab:has-text("Analytics")');
  await expect(page).toHaveURL(/#\/analytics$/);
  await expect(dialog(page)).toHaveCount(0);
});

test('the browser Back button asks too; Stay puts the address back', async ({ page }) => {
  await openIntakeReview(page, '/#/reports');
  await expect(page).toHaveURL(/#\/new$/);
  await firstText(page).fill('Typed before pressing Back');

  await page.goBack();
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Stay' }).click();
  await expect(page).toHaveURL(/#\/new$/);
  await expect(page.locator('.field-list')).toBeVisible();
  await expect(firstText(page)).toHaveValue('Typed before pressing Back');

});

test('the browser Back button: Discard changes goes back', async ({ page }) => {
  await openIntakeReview(page, '/#/reports');
  await firstText(page).fill('Typed before pressing Back');
  await page.goBack();
  await dialog(page).getByRole('button', { name: 'Discard changes' }).click();
  await expect(page).toHaveURL(/#\/reports$/);
  await expect(page.locator('.field-list')).toHaveCount(0);
});

test('"Back to Classify" with unsaved edits says re-reading replaces them', async ({ page }) => {
  await openIntakeReview(page);
  await firstText(page).fill('Typed before going back');

  await page.getByTestId('back-to-classify').click();
  await expect(dialog(page)).toContainText('reading the document again replaces');
  await dialog(page).getByRole('button', { name: 'Stay' }).click();
  await expect(page.locator('.field-list')).toBeVisible();
  await expect(firstText(page)).toHaveValue('Typed before going back');

  await page.getByTestId('back-to-classify').click();
  await dialog(page).getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.locator('.field-list')).toHaveCount(0);
  await expect(page.getByTestId('back-to-classify')).toHaveCount(0);
});

test('a saved report with unsaved edits: Back and the tabs ask first', async ({ page, request }) => {
  const marker = `E2E-Leave-${Date.now()}`;
  await seedDraft(request, marker);
  await openSavedReport(page, marker);
  await firstText(page).fill('Edited on the saved report');

  await page.click('button:has-text("← Back to reports")');
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Stay' }).click();
  await expect(firstText(page)).toHaveValue('Edited on the saved report');

  await page.click('.view-tab:has-text("Analytics")');
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Stay' }).click();
  await expect(page).toHaveURL(/#\/reports\/[0-9a-f-]{36}$/);

  await page.click('button:has-text("← Back to reports")');
  await dialog(page).getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.locator('.report-table')).toBeVisible();
  await expect(page).toHaveURL(/#\/reports$/);
});

test('a saved report: Save and leave keeps the edits', async ({ page, request }) => {
  const marker = `E2E-LeaveSave-${Date.now()}`;
  const id = await seedDraft(request, marker);
  await openSavedReport(page, marker);
  await firstText(page).fill('Saved on the way out');

  await page.click('.view-tab:has-text("Analytics")');
  await dialog(page).getByRole('button', { name: 'Save and leave' }).click();
  await expect(page).toHaveURL(/#\/analytics$/);

  const saved = await (await request.get(`${API_BASE}/reports/${id}`)).json();
  expect(JSON.stringify(saved.extracted_fields)).toContain('Saved on the way out');
});

test('deleting a saved report is not a question about its edits', async ({ page, request }) => {
  const marker = `E2E-LeaveDelete-${Date.now()}`;
  await seedDraft(request, marker);
  await openSavedReport(page, marker);
  await firstText(page).fill('Edited, then the report is deleted');

  await page.click('button:has-text("Delete report")');
  await page.click('button:has-text("Confirm delete")');
  await expect(page.locator('.report-table, .empty-hint').first()).toBeVisible({ timeout: 15_000 });
  await expect(dialog(page)).toHaveCount(0);
});
