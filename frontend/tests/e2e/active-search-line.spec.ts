import { test, expect } from './coverage';
import type { Page } from '@playwright/test';
import { seedReport } from './helpers/api';

// The search in force is shown as removable conditions (src/components/ActiveSearch.tsx): under the Ask box's field
// where that is on a wide screen (Reports), and on a line under the top bar everywhere else, which stays in view.

const KEY = 'sl.ask.kept';

async function keptRecord(page: Page): Promise<{ text: string; filters: Record<string, string>; understood: { key: string; label: string }[] } | null> {
  return JSON.parse((await page.evaluate((key) => localStorage.getItem(key), KEY)) ?? 'null');
}

async function ask(page: Page, text: string, box = page.getByTestId('ask-box').first()) {
  await box.getByTestId('ask-input').fill(text);
  await box.getByTestId('ask-submit').click();
  await expect.poll(async () => (await keptRecord(page))?.text).toBe(text);
}

test('wide Reports: the conditions are under the Ask box field and the line at the top steps aside', async ({ page, request }) => {
  const tech = 'Line Widerson';
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: tech });
  await page.goto('/#/reports');
  await ask(page, `repairs by ${tech.toLowerCase()}`);

  const chips = page.getByTestId('ask-chip');
  await expect(chips).toHaveCount(2);
  await expect(chips.filter({ hasText: 'Repair' })).toBeVisible();
  await expect(chips.filter({ hasText: /Lab manager: Line Widerson/i })).toBeVisible();
  // Said once, not twice: the line at the top is in the page but out of sight here.
  await expect(page.getByTestId('active-search')).toBeHidden();
});

test('wide Reports: taking one condition out re-runs the list, the filters follow, and the rest is kept', async ({ page, request }) => {
  const tech = 'Line Oneoffson';
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: tech });
  await seedReport(request, { model: 'LSRFortessa', reportType: 'preventive_maintenance', technician: tech });
  await page.goto('/#/reports');
  await ask(page, `repairs by ${tech.toLowerCase()}`);
  await expect(page.getByTestId('report-row')).toHaveCount(1);

  await page.getByTestId('ask-chip').filter({ hasText: 'Repair' }).click();

  // The list shows both kinds now, still only this lab manager's, and the type filter is empty again.
  await expect(page.getByTestId('report-row')).toHaveCount(2);
  await expect(page.locator('select[aria-label="Report type"]')).toHaveValue('');
  await expect(page.locator('input[aria-label="Lab manager"]')).toHaveValue(/line oneoffson/i);
  await expect(page.getByTestId('ask-chip')).toHaveCount(1);
  const record = await keptRecord(page);
  expect(record!.filters).toEqual({ technician: expect.stringMatching(/line oneoffson/i) });
  // Taking a condition out is not a hand edit: the search is still in force, and it survives a reload.
  await page.reload();
  await expect(page.getByTestId('report-row')).toHaveCount(2);
  await expect(page.getByTestId('ask-chip')).toHaveCount(1);
});

test('wide Reports: taking out the last condition ends the search; so does Clear search', async ({ page, request }) => {
  const tech = 'Line Lastson';
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: tech });
  await page.goto('/#/reports');

  await ask(page, 'waiting for review');
  await expect(page.locator('select[aria-label="Status"]')).not.toHaveValue('');
  await page.getByTestId('ask-chip').first().click();
  await expect.poll(() => keptRecord(page)).toBeNull();
  await expect(page.locator('select[aria-label="Status"]')).toHaveValue('');
  await expect(page.getByTestId('ask-understood')).toHaveCount(0);
  await expect(page.getByTestId('ask-input')).toHaveValue(/waiting for review/); // the question stays in the field to edit

  await ask(page, `repairs by ${tech.toLowerCase()}`);
  await page.getByTestId('ask-clear').click();
  await expect.poll(() => keptRecord(page)).toBeNull();
  await expect(page.locator('input[aria-label="Lab manager"]')).toHaveValue('');
  await expect(page.locator('select[aria-label="Report type"]')).toHaveValue('');
});

test('a date is one condition: taking it out takes out both ends', async ({ page }) => {
  await page.goto('/#/reports');
  await ask(page, 'maintenance in 2025');
  const before = (await keptRecord(page))!;
  expect(before.filters.date_from).toBeTruthy();
  expect(before.filters.date_to).toBeTruthy();

  await page.getByTestId('ask-chip').filter({ hasText: /2025/ }).click();
  await expect.poll(async () => (await keptRecord(page))?.filters.date_from).toBeUndefined();
  const after = (await keptRecord(page))!;
  expect(after.filters.date_to).toBeUndefined();
  expect(after.filters.report_type).toBeTruthy();
  await expect(page.locator('input[aria-label="From date"]')).toHaveValue('');
  await expect(page.locator('input[aria-label="To date"]')).toHaveValue('');
});

test('a condition can be taken out from the keyboard', async ({ page }) => {
  await page.goto('/#/reports');
  await ask(page, 'maintenance in 2025');
  const chip = page.getByTestId('ask-chip').filter({ hasText: /2025/ });
  await expect(chip).toHaveAttribute('aria-label', /^Remove: /);
  await chip.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ask-chip').filter({ hasText: /2025/ })).toHaveCount(0);
});

test('Analytics: the line shows the search, taking a condition out re-runs the charts, the maker stays', async ({ page, request }) => {
  const tech = 'Line Chartson';
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: tech, finalize: true });
  await page.goto('/#/reports');
  await ask(page, `repairs by ${tech.toLowerCase()}`);

  await page.getByTestId('tab-analytics').click();
  const line = page.getByTestId('active-search');
  await expect(line).toBeVisible();
  await expect(line.getByTestId('active-search-chip')).toHaveCount(2);
  await expect(page.locator('input[aria-label="Lab manager"]')).toHaveValue(/line chartson/i);

  // A maker chosen here is Analytics' own and must survive the search changing.
  await page.locator('select[aria-label="Manufacturer"]').selectOption({ index: 1 });
  const maker = await page.locator('select[aria-label="Manufacturer"]').inputValue();
  expect(maker).not.toBe('');

  const rerun = page.waitForRequest((r) => r.url().includes('/analytics/fleet') && !/technician=/.test(r.url()) && /report_type=/.test(r.url()));
  await line.getByTestId('active-search-chip').filter({ hasText: /Lab manager/ }).click();
  await rerun;
  await expect(line.getByTestId('active-search-chip')).toHaveCount(1);
  await expect(page.locator('input[aria-label="Lab manager"]')).toHaveValue('');
  await expect(page.locator('select[aria-label="Manufacturer"]')).toHaveValue(maker);

  await line.getByTestId('active-search-clear').click();
  await expect(line).toHaveCount(0);
  await expect(page.locator('select[aria-label="Report type"]')).toHaveValue('');
  await expect(page.locator('select[aria-label="Manufacturer"]')).toHaveValue(maker);
  expect(await keptRecord(page)).toBeNull();
});

test('Home shows the line too, and what is left after taking one out is what Reports opens with', async ({ page, request }) => {
  const tech = 'Line Homeson';
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: tech });
  await seedReport(request, { model: 'LSRFortessa', reportType: 'preventive_maintenance', technician: tech });
  await page.goto('/#/reports');
  await ask(page, `repairs by ${tech.toLowerCase()}`);

  await page.getByTestId('tab-home').click();
  const line = page.getByTestId('active-search');
  await expect(line).toBeVisible();
  await line.getByTestId('active-search-chip').filter({ hasText: 'Repair' }).click();
  await expect(line.getByTestId('active-search-chip')).toHaveCount(1);

  await page.getByTestId('tab-reports').click();
  await expect(page.getByTestId('report-row')).toHaveCount(2);
  await expect(page.locator('select[aria-label="Report type"]')).toHaveValue('');
  await expect(page.locator('input[aria-label="Lab manager"]')).toHaveValue(/line homeson/i);
});

test('the line stays in view when the page scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 500 });
  await page.goto('/#/reports');
  await ask(page, 'maintenance in 2025');
  await page.getByTestId('tab-analytics').click();
  const line = page.getByTestId('active-search');
  await expect(line).toBeVisible();
  // Make sure there is something to scroll past, whatever the data on the page is.
  await page.evaluate(() => {
    const pad = document.createElement('div');
    pad.style.height = '3000px';
    (document.querySelector('.wrap') ?? document.body).appendChild(pad);
  });
  await page.evaluate(() => window.scrollTo(0, 1500));
  expect(await page.evaluate(() => window.scrollY), 'the page did not scroll, so this proves nothing').toBeGreaterThan(200);
  const box = (await line.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeLessThanOrEqual(2);
  await expect(line).toBeInViewport();
});

test('no line when there is no search; a search that is hand-edited away takes the line with it', async ({ page, request }) => {
  const tech = 'Line Handson';
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: tech });
  await page.goto('/#/home');
  await expect(page.getByTestId('active-search')).toHaveCount(0);

  await page.goto('/#/reports');
  await ask(page, `repairs by ${tech.toLowerCase()}`);
  await page.locator('select[aria-label="Status"]').selectOption('finalized');
  await expect.poll(() => keptRecord(page)).toBeNull();
  await page.getByTestId('tab-analytics').click();
  await expect(page.getByTestId('active-search')).toHaveCount(0);
});

test('a filter in force that nothing named still gets a chip, so it cannot hide', async ({ page }) => {
  await page.goto('/#/home');
  await page.evaluate(
    (key) => localStorage.setItem(key, JSON.stringify({ text: 'old', filters: { technician: 'zed named', status: 'draft' }, understood: [{ key: 'technician', label: 'Lab manager: Zed Named' }] })),
    KEY
  );
  await page.goto('/#/analytics');
  await page.reload();
  const chips = page.getByTestId('active-search').getByTestId('active-search-chip');
  await expect(chips).toHaveCount(2);
  await expect(chips.nth(1)).toHaveText('Status: draft');
  await chips.nth(1).click();
  await expect(chips).toHaveCount(1);
  expect((await keptRecord(page))!.filters).toEqual({ technician: 'zed named' });
});
