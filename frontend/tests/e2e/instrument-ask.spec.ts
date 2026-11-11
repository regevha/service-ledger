import { expect, test } from '@playwright/test';
import { seedReport } from './helpers/api';

// A question about instruments ("instruments with more than 2 repairs"): the Ask box opens the Instruments tab,
// which lists only the instruments that pass, with how many repairs each has, and says what it is showing.
// Counted: finalized repairs only. The parse answer is faked; the counts come from the real backend.

function answer(extra: Record<string, string> = {}, notes: string[] = []) {
  return {
    filters: { repairs_op: 'gt', repairs_count: '1', ...extra },
    understood: [{ key: 'repairs', label: 'Above 1 repair' }],
    source: 'ai',
    notes,
    target: 'instruments',
  };
}

test('a question about repairs opens Instruments with only the instruments that pass', async ({ page, request }) => {
  const busy = await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', finalize: true, reportDate: '2026-02-01' });
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', instrumentId: busy.instrumentId, finalize: true, reportDate: '2026-03-01' });
  // Not counted: a draft-state report and a maintenance report on the same instrument.
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', instrumentId: busy.instrumentId, reportDate: '2026-04-01' });
  await seedReport(request, { model: 'LSRFortessa', reportType: 'preventive_maintenance', instrumentId: busy.instrumentId, finalize: true, reportDate: '2026-05-01' });
  await page.route('**/reports/parse-search', (route) => route.fulfill({ json: answer({ date_from: '2026-01-01', date_to: '2026-12-31' }) }));

  await page.goto('/#/reports');
  await page.getByTestId('ask-input').fill('instruments with more than 1 repair in 2026');
  await page.getByTestId('ask-submit').click();

  await expect(page.getByTestId('instrument-ask')).toContainText('Above 1 repair');
  await expect(page.getByTestId('instrument-row')).toHaveCount(1);
  await expect(page.getByTestId('instrument-repairs')).toHaveText('2 repairs');
  // Nothing was kept as a report search, so Reports is unfiltered when the person goes back.
  expect(await page.evaluate(() => localStorage.getItem('sl.ask.kept'))).toBeNull();

  await page.getByTestId('instrument-ask-clear').click();
  await expect(page.getByTestId('instrument-ask')).toHaveCount(0);
  await expect(page.getByTestId('instrument-row').nth(1)).toBeVisible();
  await expect(page.getByTestId('instrument-repairs')).toHaveCount(0);
});

test('"no repairs" lists the instruments with none, and what was left out is said', async ({ page }) => {
  await page.route('**/reports/parse-search', (route) =>
    route.fulfill({
      json: {
        filters: { repairs_op: 'eq', repairs_count: '0', date_from: '1999-01-01', date_to: '1999-12-31' },
        understood: [{ key: 'repairs', label: 'No repairs' }],
        source: 'ai',
        notes: ['Only the model, place and dates apply to a count of repairs per instrument (left out: technician)'],
        target: 'instruments',
      },
    }),
  );
  await page.goto('/#/reports');
  await page.getByTestId('ask-input').fill('instruments that never had a repair signed by Dana');
  await page.getByTestId('ask-submit').click();

  await expect(page.getByTestId('instrument-ask')).toContainText('No repairs');
  await expect(page.getByTestId('instrument-ask-note')).toContainText('left out: technician');
  // In 1999 nothing was repaired anywhere, so every instrument shows, each with 0.
  const rows = page.getByTestId('instrument-row');
  await expect(rows.first()).toBeVisible();
  const repairs = page.getByTestId('instrument-repairs');
  await expect(repairs).toHaveCount(await rows.count());
  await expect(repairs.first()).toHaveText('0 repairs');
});

test('from Home, a question about instruments also lands on Instruments', async ({ page }) => {
  await page.route('**/reports/parse-search', (route) => route.fulfill({ json: answer() }));
  await page.goto('/#/home');
  await page.getByTestId('ask-input').fill('instruments with more than 1 repair');
  await page.getByTestId('ask-submit').click();
  await expect(page.getByTestId('instrument-ask')).toBeVisible();
  await expect(page).toHaveURL(/#\/instruments/);
});
