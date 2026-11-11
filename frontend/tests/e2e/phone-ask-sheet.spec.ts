import { test, expect } from './coverage';
import type { Page } from '@playwright/test';
import { seedReport } from './helpers/api';
import { askInSheet, openAskSheet } from './helpers/askSheet';
import { failToHear, installFakeSpeech, removeSpeech, say } from './helpers/fakeSpeech';

// On a phone the Ask box is a sheet opened from the magnifier in the top bar (src/components/AskSheet.tsx), so it
// no longer fills the top third of the page. Recent questions and the microphone live in the same sheet.

async function noSideScroll(page: Page) {
  const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(scroll, 'the page scrolls sideways').toBeLessThanOrEqual(client + 1);
}

test.describe('The Ask sheet on a phone', { tag: '@phone' }, () => {
  test('the magnifier is on Home, Reports and Analytics only, thumb-sized and inside the screen', async ({ page }) => {
    const width = page.viewportSize()!.width;
    for (const route of ['home', 'reports', 'analytics']) {
      await page.goto(`/#/${route}`);
      const button = page.getByTestId('ask-open');
      await expect(button).toBeVisible();
      const b = (await button.boundingBox())!;
      expect(b.width).toBeGreaterThanOrEqual(43.5);
      expect(b.height).toBeGreaterThanOrEqual(43.5);
      expect(b.x + b.width).toBeLessThanOrEqual(width + 0.5);
      await expect(page.getByTestId('ask-input')).toHaveCount(0); // nothing of the box in the page itself
      await noSideScroll(page);
    }
    await page.goto('/#/instruments');
    await expect(page.getByTestId('ask-open')).toHaveCount(0);
  });

  test('the sheet opens over the page with the field ready, and closes with Close, a tap outside and Escape', async ({ page }) => {
    await page.goto('/#/reports');
    const sheet = await openAskSheet(page);
    await expect(sheet).toHaveAttribute('aria-modal', 'true');
    await expect(sheet.getByTestId('ask-input')).toBeFocused();
    // Closed, the page above the lists is free of the box; open, the sheet is a short strip, not the whole screen.
    const box = (await sheet.boundingBox())!;
    expect(box.height).toBeLessThan(page.viewportSize()!.height * 0.6);
    expect(box.x).toBeGreaterThanOrEqual(-0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 0.5);

    await sheet.getByTestId('ask-sheet-close').tap();
    await expect(page.getByTestId('ask-sheet')).toHaveCount(0);

    await openAskSheet(page);
    await page.getByTestId('ask-sheet-backdrop').tap({ position: { x: 20, y: page.viewportSize()!.height - 20 } });
    await expect(page.getByTestId('ask-sheet')).toHaveCount(0);

    await openAskSheet(page);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('ask-sheet')).toHaveCount(0);
  });

  test('a question that sets something closes the sheet and the line at the top shows it; one that sets nothing says so and stays', async ({ page }) => {
    await page.goto('/#/reports');
    await askInSheet(page, 'show me all reports');
    await expect(page.getByTestId('ask-sheet')).toBeVisible();
    await expect(page.getByTestId('ask-understood')).toContainText('Nothing in that matched a filter');
    await expect(page.getByTestId('active-search')).toHaveCount(0);

    await page.getByTestId('ask-input').fill('maintenance in 2025');
    await page.getByTestId('ask-submit').tap();
    await expect(page.getByTestId('ask-sheet')).toHaveCount(0);
    await expect(page.getByTestId('active-search')).toBeVisible();
  });

  test('on Analytics the sheet works and the charts follow the question', async ({ page }) => {
    await page.goto('/#/analytics');
    await askInSheet(page, 'maintenance in 2025');
    await expect(page.getByTestId('active-search')).toBeVisible();
    await expect(page.getByTestId('active-search-chip').first()).toBeVisible();
    await expect(page.getByTestId('active-search')).toContainText(/2025/);
  });

  test('the last five questions are listed as recent, newest first, once each, and survive a reload; a tap asks one again', async ({ page }) => {
    await page.goto('/#/reports');
    const questions = ['maintenance in 2025', 'waiting for review', 'repairs last month', 'repairs in 2024', 'maintenance in 2023', 'waiting for review'];
    for (const q of questions) {
      await askInSheet(page, q);
      // Wait until this one is in force before the next, so nothing is cut short by the reload below.
      await expect.poll(async () => JSON.parse((await page.evaluate(() => localStorage.getItem('sl.ask.kept'))) ?? 'null')?.text).toBe(q);
      await expect(page.getByTestId('ask-sheet')).toHaveCount(0);
    }

    await page.reload();
    const sheet = await openAskSheet(page);
    // The one in force is not offered again; the others are, newest first, none repeated.
    await expect(sheet.getByTestId('ask-recent-item')).toHaveText(['maintenance in 2023', 'repairs in 2024', 'repairs last month', 'maintenance in 2025']);

    await sheet.getByTestId('ask-recent-item').filter({ hasText: 'repairs last month' }).tap();
    await expect(page.getByTestId('ask-sheet')).toHaveCount(0);
    await expect(page.getByTestId('active-search')).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('sl.ask.kept') ?? 'null')?.text)).toBe('repairs last month');
  });

  test('a question that set nothing is not added to the recent ones', async ({ page }) => {
    await page.goto('/#/reports');
    await askInSheet(page, 'show me all reports');
    await expect(page.getByTestId('ask-understood')).toBeVisible();
    await page.getByTestId('ask-sheet-close').tap();
    const sheet = await openAskSheet(page);
    await expect(sheet.getByTestId('ask-recent')).toHaveCount(0);
  });

  test('voice: the microphone takes a spoken question, asks it, and the sheet closes', async ({ page, request }) => {
    await installFakeSpeech(page);
    const tech = 'Voice Phoneson';
    await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: tech });
    await page.goto('/#/reports');
    const sheet = await openAskSheet(page);
    const mic = sheet.getByTestId('ask-voice');
    const b = (await mic.boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(43.5);
    expect(b.width).toBeGreaterThanOrEqual(43.5);
    await mic.tap();
    await expect(mic).toHaveAttribute('aria-pressed', 'true');
    await expect(sheet.getByTestId('ask-voice-status')).toBeVisible();
    await say(page, `repairs by ${tech.toLowerCase()}`);
    await expect(page.getByTestId('ask-sheet')).toHaveCount(0);
    await expect(page.getByTestId('active-search')).toContainText(/Lab manager: voice phoneson/i);
    await noSideScroll(page);
  });

  test('voice: a blocked microphone says so and the box still works by typing', async ({ page }) => {
    await installFakeSpeech(page);
    await page.goto('/#/reports');
    const sheet = await openAskSheet(page);
    await sheet.getByTestId('ask-voice').tap();
    await failToHear(page, 'not-allowed');
    await expect(sheet.getByTestId('ask-voice-problem')).toContainText('microphone is blocked');
    await expect(sheet.getByTestId('ask-voice')).toHaveAttribute('aria-pressed', 'false');
    await sheet.getByTestId('ask-input').fill('maintenance in 2025');
    await sheet.getByTestId('ask-submit').tap();
    await expect(page.getByTestId('active-search')).toBeVisible();
  });

  test('voice: where the browser has no speech recognition there is no microphone button', async ({ page }) => {
    await removeSpeech(page);
    await page.goto('/#/reports');
    const sheet = await openAskSheet(page);
    await expect(sheet.getByTestId('ask-input')).toBeVisible();
    await expect(sheet.getByTestId('ask-voice')).toHaveCount(0);
  });

  test('a dropped search still shows its notice on the page, where the box is no longer', async ({ page }) => {
    await page.goto('/#/home');
    await page.evaluate(
      (value) => localStorage.setItem('sl.ask.kept', value),
      JSON.stringify({ text: 'old', filters: { instrument_id: '00000000-0000-4000-8000-000000000000' }, understood: [{ key: 'instrument_id', label: 'Instrument: gone' }] })
    );
    await page.reload();
    await expect(page.getByTestId('kept-search-notice')).toBeVisible();
    await expect(page.getByTestId('active-search')).toHaveCount(0);
  });
});
