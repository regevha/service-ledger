import { test, expect } from './coverage';
import { seedReport } from './helpers/api';
import { failToHear, installFakeSpeech, removeSpeech, say } from './helpers/fakeSpeech';

// Wide screens keep the Ask box in the page: no magnifier, no sheet. Recent questions and the microphone work there too.

test('wide: the box stays in the page and there is no magnifier', async ({ page }) => {
  await page.goto('/#/reports');
  await expect(page.getByTestId('ask-input')).toBeVisible();
  await expect(page.getByTestId('ask-open')).toHaveCount(0);
  await page.goto('/#/home');
  await expect(page.getByTestId('home-ask').getByTestId('ask-input')).toBeVisible();
  await expect(page.getByTestId('ask-open')).toHaveCount(0);
});

test('wide: recent questions appear under the field, newest first, and a click asks one again', async ({ page }) => {
  await page.goto('/#/reports');
  for (const q of ['maintenance in 2025', 'waiting for review', 'repairs in 2024']) {
    await page.getByTestId('ask-input').fill(q);
    await page.getByTestId('ask-submit').click();
    await expect(page.getByTestId('ask-input')).toHaveValue(q);
    await expect.poll(async () => JSON.parse((await page.evaluate(() => localStorage.getItem('sl.ask.kept'))) ?? 'null')?.text).toBe(q);
  }
  await expect(page.getByTestId('ask-recent-item')).toHaveText(['waiting for review', 'maintenance in 2025']);
  await page.getByTestId('ask-recent-item').filter({ hasText: 'maintenance in 2025' }).click();
  await expect.poll(async () => JSON.parse((await page.evaluate(() => localStorage.getItem('sl.ask.kept'))) ?? 'null')?.text).toBe('maintenance in 2025');
  await expect(page.getByTestId('ask-recent-item')).toHaveText(['repairs in 2024', 'waiting for review']);
});

test('wide: a damaged list of recent questions is ignored, not a crash', async ({ page }) => {
  await page.goto('/#/reports');
  await page.evaluate(() => localStorage.setItem('sl.ask.recent', '{"nope":true}'));
  await page.reload();
  await expect(page.getByTestId('ask-input')).toBeVisible();
  await expect(page.getByTestId('ask-recent')).toHaveCount(0);
});

test('wide: voice fills the field and asks; a failure shows a message; no recognition means no button', async ({ page, request }) => {
  await installFakeSpeech(page);
  const tech = 'Voice Wideson';
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: tech });
  await page.goto('/#/reports');
  await page.getByTestId('ask-voice').click();
  await expect(page.getByTestId('ask-voice')).toHaveAttribute('aria-pressed', 'true');
  await say(page, `repairs by ${tech.toLowerCase()}`);
  await expect(page.getByTestId('ask-input')).toHaveValue(`repairs by ${tech.toLowerCase()}`);
  await expect(page.locator('input[aria-label="Lab manager"]')).toHaveValue(/voice wideson/i);

  await page.getByTestId('ask-voice').click();
  await failToHear(page, 'no-speech');
  await expect(page.getByTestId('ask-voice-problem')).toContainText('Did not hear anything');
  // Tapping the microphone again clears the old message.
  await page.getByTestId('ask-voice').click();
  await expect(page.getByTestId('ask-voice-problem')).toHaveCount(0);
});

test('wide: without speech recognition there is no microphone button', async ({ page }) => {
  await removeSpeech(page);
  await page.goto('/#/reports');
  await expect(page.getByTestId('ask-input')).toBeVisible();
  await expect(page.getByTestId('ask-voice')).toHaveCount(0);
});
