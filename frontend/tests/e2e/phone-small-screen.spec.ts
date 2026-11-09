import { type Locator, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './coverage';
import { seedReport } from './helpers/api';
import { uniqueFixture } from './unique-upload';

// The smallest phone still in use (an iPhone SE, 375x667; the `phone-small` project): the screens where the sticky
// save bar, the tab bar and a question box compete for a short screen. Docs: claude/plan-phone-e2e-tests.md.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIDENT_SCAN = path.join(__dirname, 'fixtures', 'confident-scan.pdf');

async function noSideScroll(page: Page) {
  const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(scroll, 'the page scrolls sideways').toBeLessThanOrEqual(client + 1);
}

async function insideScreen(page: Page, locator: Locator, what: string) {
  const box = (await locator.boundingBox())!;
  const { width, height } = page.viewportSize()!;
  expect(box.x, `${what} starts left of the screen`).toBeGreaterThanOrEqual(-0.5);
  expect(box.x + box.width, `${what} ends right of the screen`).toBeLessThanOrEqual(width + 0.5);
  expect(box.y, `${what} starts above the screen`).toBeGreaterThanOrEqual(-0.5);
  expect(box.y + box.height, `${what} ends below the screen`).toBeLessThanOrEqual(height + 0.5);
}

async function openIntakeReview(page: Page) {
  await page.route('**/extraction-jobs/*', async (route) => {
    const response = await route.fetch();
    const job = await response.json();
    if (job && typeof job === 'object') job.field_confidences = { ...(job.field_confidences ?? {}), report_date: 0.1 };
    await route.fulfill({ response, json: job });
  });
  await page.goto('/#/new');
  await page.locator('input[type="file"]').setInputFiles(uniqueFixture(CONFIDENT_SCAN));
  await page.getByRole('button', { name: 'Upload & classify' }).tap();
  await page.waitForSelector('[data-testid="field-list"]', { timeout: 30_000 });
}

test.describe('on the smallest phone', { tag: '@small' }, () => {
  test('the screen really is 375 wide', async ({ page }) => {
    await page.goto('/#/home');
    expect(page.viewportSize()).toEqual({ width: 375, height: 667 });
  });

  for (const [name, hash] of [
    ['Home', '/#/home'],
    ['New report', '/#/new'],
    ['Reports', '/#/reports'],
    ['Analytics', '/#/analytics'],
    ['Instruments', '/#/instruments'],
    ['Templates', '/#/templates'],
  ] as const) {
    test(`${name}: nothing scrolls sideways and the tab bar is flush with the bottom`, async ({ page }) => {
      await page.goto(hash);
      await page.waitForLoadState('networkidle');
      await noSideScroll(page);
      const bar = page.getByRole('navigation', { name: 'Main' });
      const box = (await bar.boundingBox())!;
      expect(Math.round(box.y + box.height)).toBe(667);
      expect(box.width).toBe(375);
    });
  }

  test('Home: the ask box and its buttons are inside the screen', async ({ page }) => {
    await page.goto('/#/home');
    for (const id of ['ask-input', 'ask-submit', 'home-choose-files', 'home-new-report']) {
      await insideScreen(page, page.getByTestId(id), id);
    }
  });

  test('Reports: a question gives chips that wrap inside the screen', async ({ page }) => {
    await page.goto('/#/reports');
    await page.getByRole('button', { name: 'maintenance in 2025 at Bar-Ilan University' }).tap();
    const chips = page.getByTestId('ask-chip');
    await expect(chips.first()).toBeVisible();
    for (let i = 0; i < (await chips.count()); i++) await insideScreen(page, chips.nth(i), `chip ${i + 1}`);
    await noSideScroll(page);
  });

  test('the review screen: the save bar sits above the tab bar and covers no button of it', async ({ page }) => {
    await openIntakeReview(page);
    // The bar lives inside the fields block, so it sticks once that block has scrolled into view; on this short,
    // narrow screen the notices above it fill the first screen, so go to the fields first.
    await page.getByTestId('field-list').scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, 200));
    const saveBar = page.locator('.review-actions');
    const tabBar = page.getByRole('navigation', { name: 'Main' });
    const [s, t] = [(await saveBar.boundingBox())!, (await tabBar.boundingBox())!];
    expect(s.y + s.height, 'the save bar runs into the tab bar').toBeLessThanOrEqual(t.y + 1);
    await insideScreen(page, saveBar, 'the save bar');
    for (const name of ['Save corrections', 'Save & finalize report']) {
      const button = page.getByRole('button', { name });
      await insideScreen(page, button, name);
      expect((await button.boundingBox())!.height, `${name} is too small to tap`).toBeGreaterThanOrEqual(43.5);
    }
  });

  test('finalizing with flagged fields: the question fits a short screen', async ({ page }) => {
    await openIntakeReview(page);
    await page.getByRole('button', { name: 'Save & finalize report' }).tap();
    const question = page.locator('#finalize-confirm');
    await expect(question).toBeVisible();
    await expect(async () => insideScreen(page, question, 'the finalize question')).toPass({ timeout: 5_000 });
    await expect(question.getByRole('button', { name: 'Finalize anyway' })).toBeVisible();
  });

  test('leaving with unsaved edits: the question and its three buttons fit a short screen', async ({ page }) => {
    await openIntakeReview(page);
    await page.locator('[data-testid="field-list"] textarea, [data-testid="field-list"] input[type="number"]').first().fill('12');
    await page.getByTestId('tab-reports').tap();
    const dialog = page.locator('#leave-dialog');
    await expect(dialog).toBeVisible();
    await insideScreen(page, dialog, 'the unsaved-changes question');
    for (const name of ['Stay', 'Discard changes', 'Save and leave']) {
      await insideScreen(page, dialog.getByRole('button', { name }), name);
    }
  });

  test('a saved report: the header and its buttons fit the width', async ({ page, request }) => {
    const marker = `E2E-Small-${Date.now()}`;
    await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: marker, finalize: true });
    await page.goto('/#/reports');
    await page.getByTestId('report-group').first().waitFor();
    await noSideScroll(page);
  });
});
