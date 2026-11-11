import { test, expect } from './coverage';
import type { APIRequestContext, Page } from '@playwright/test';
import { API_BASE, seedReport } from './helpers/api';

// The search asked for in plain words is kept in the browser until the person changes it (src/keptSearch.ts),
// and Home, Reports and Analytics all start from it.

const KEY = 'sl.ask.kept';

async function stored(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), KEY);
}

/** Asks on a screen that has the box and waits until the server has read it and it is kept (so storage can be checked at once). */
async function ask(page: Page, text: string) {
  await page.getByTestId('ask-input').fill(text);
  await page.getByTestId('ask-submit').click();
  await expect.poll(async () => JSON.parse((await stored(page)) ?? 'null')?.text).toBe(text);
}

/** An instrument that existed when the search was kept and is deleted before the app opens again. */
async function goneInstrument(request: APIRequestContext) {
  const stamp = Date.now();
  const inst = await (
    await request.post(`${API_BASE}/instruments`, {
      data: { name: `Temp ${stamp}`, model: 'E2E-Kept-Model', manufacturer: 'BD', serial_number: `KS-${stamp}` },
    })
  ).json();
  expect((await request.delete(`${API_BASE}/instruments/${inst.id}`)).status()).toBe(204);
  return inst.id as string;
}

async function keep(page: Page, record: unknown) {
  await page.goto('/#/home');
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [KEY, typeof record === 'string' ? record : JSON.stringify(record)]);
  await page.reload();
}

test('the search is still there after a reload: the list, the filters and the question', async ({ page, request }) => {
  const tech = 'Kept Reloadson';
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: tech });
  await seedReport(request, { model: 'LSRFortessa', reportType: 'preventive_maintenance', technician: tech });

  await page.goto('/#/reports');
  await ask(page, `repairs by ${tech.toLowerCase()}`);
  await expect(page.getByTestId('report-row')).toHaveCount(1);

  await page.reload();
  await expect(page.getByTestId('report-row')).toHaveCount(1);
  await expect(page.locator('input[aria-label="Lab manager"]')).toHaveValue(/kept reloadson/i);
  await expect(page.getByTestId('ask-input')).toHaveValue(`repairs by ${tech.toLowerCase()}`);
  await expect(page.getByTestId('ask-chip').filter({ hasText: 'Repair' })).toHaveCount(1);
});

test('one search for every screen: asked on Home, used by Reports and Analytics, shown again on Home', async ({ page, request }) => {
  const tech = 'Kept Sharedson';
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: tech });
  await seedReport(request, { model: 'LSRFortessa', reportType: 'preventive_maintenance', technician: tech });

  await page.goto('/#/home');
  await page.getByTestId('home-ask').getByTestId('ask-input').fill(`repairs by ${tech.toLowerCase()}`);
  await page.getByTestId('home-ask').getByTestId('ask-submit').click();
  await expect(page.getByTestId('report-row')).toHaveCount(1);

  // Analytics starts from the same filters, and asks the server for them.
  const request1 = page.waitForRequest((r) => r.url().includes('/analytics/fleet') && /technician=kept\+sharedson/i.test(r.url()));
  await page.getByTestId('tab-analytics').click();
  await request1;
  await expect(page.locator('input[aria-label="Lab manager"]')).toHaveValue(/kept sharedson/i);

  // Home shows the question again.
  await page.getByTestId('tab-home').click();
  await expect(page.getByTestId('home-ask').getByTestId('ask-input')).toHaveValue(`repairs by ${tech.toLowerCase()}`);

  // And Reports still has it.
  await page.getByTestId('tab-reports').click();
  await expect(page.getByTestId('report-row')).toHaveCount(1);
});

test('a new question replaces the kept one', async ({ page, request }) => {
  const first = 'Kept Firstson';
  const second = 'Kept Secondson';
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: first });
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: second });

  await page.goto('/#/reports');
  await ask(page, `repairs by ${first.toLowerCase()}`);
  await expect(page.locator('input[aria-label="Lab manager"]')).toHaveValue(/kept firstson/i);
  await ask(page, `repairs by ${second.toLowerCase()}`);
  await expect(page.locator('input[aria-label="Lab manager"]')).toHaveValue(/kept secondson/i);

  await page.reload();
  await expect(page.getByTestId('ask-input')).toHaveValue(`repairs by ${second.toLowerCase()}`);
  await expect(page.locator('input[aria-label="Lab manager"]')).toHaveValue(/kept secondson/i);
});

test('changing a filter by hand ends the kept search for good', async ({ page, request }) => {
  const tech = 'Kept Handson';
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: tech });

  await page.goto('/#/reports');
  await ask(page, `repairs by ${tech.toLowerCase()}`);
  expect(await stored(page)).not.toBeNull();

  // Any hand edit counts: here the status.
  await page.locator('select[aria-label="Status"]').selectOption('finalized');
  await expect.poll(() => stored(page)).toBeNull();

  await page.getByTestId('tab-home').click();
  await expect(page.getByTestId('home-ask').getByTestId('ask-input')).toHaveValue('');
  await page.getByTestId('tab-reports').click();
  await expect(page.getByTestId('ask-input')).toHaveValue('');
  await page.reload();
  await expect(page.getByTestId('ask-input')).toHaveValue('');
  await expect(page.locator('input[aria-label="Lab manager"]')).toHaveValue('');
});

test('Clear filters also ends it', async ({ page, request }) => {
  const tech = 'Kept Clearson';
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: tech });

  await page.goto('/#/reports');
  await ask(page, `repairs by ${tech.toLowerCase()}`);
  expect(await stored(page)).not.toBeNull();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect.poll(() => stored(page)).toBeNull();
  await page.reload();
  await expect(page.locator('input[aria-label="Lab manager"]')).toHaveValue('');
});

test('applying a saved filter replaces it', async ({ page, request }) => {
  const stamp = Date.now();
  const tech = 'Kept Savedson';
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: tech });
  const saved = await (
    await request.post(`${API_BASE}/saved-report-filters`, { data: { name: `Kept ${stamp}`, filters: { technician: `Saved Marker ${stamp}` } } })
  ).json();
  try {
    await page.goto('/#/reports');
    await ask(page, `repairs by ${tech.toLowerCase()}`);
    await page.selectOption('select[aria-label="Saved filters"]', { label: `Kept ${stamp}` });
    await expect(page.locator('input[aria-label="Lab manager"]')).toHaveValue(`Saved Marker ${stamp}`);
    await expect.poll(() => stored(page)).toBeNull();
    await page.reload();
    await expect(page.getByTestId('ask-input')).toHaveValue('');
  } finally {
    await request.delete(`${API_BASE}/saved-report-filters/${saved.id}`);
  }
});

test('an Analytics-only filter does not end it, since Reports has no such filter', async ({ page, request }) => {
  const tech = 'Kept Makerson';
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: tech });

  await page.goto('/#/reports');
  await ask(page, `repairs by ${tech.toLowerCase()}`);
  await page.getByTestId('tab-analytics').click();
  await expect(page.locator('input[aria-label="Lab manager"]')).toHaveValue(/kept makerson/i);
  await page.locator('select[aria-label="Manufacturer"]').selectOption({ index: 1 });
  await page.waitForTimeout(500);
  expect(await stored(page)).not.toBeNull();
});

test('a question that sets nothing is not kept, and it takes the earlier search with it', async ({ page, request }) => {
  const tech = 'Kept Nothingson';
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: tech });

  await page.goto('/#/reports');
  await ask(page, `repairs by ${tech.toLowerCase()}`);
  expect(await stored(page)).not.toBeNull();
  await page.getByTestId('ask-input').fill('show me all reports');
  await page.getByTestId('ask-submit').click();
  await expect(page.getByTestId('ask-understood')).toContainText('Nothing in that matched a filter');
  expect(await stored(page)).toBeNull();
  await page.reload();
  await expect(page.getByTestId('ask-input')).toHaveValue('');
});

test('a kept search that names an instrument which still exists is used as it was', async ({ page, request }) => {
  const instruments = await (await request.get(`${API_BASE}/instruments`)).json();
  const id = instruments[0].id as string;
  await keep(page, { text: 'reports of one instrument', filters: { instrument_id: id }, understood: [{ key: 'instrument_id', label: 'One instrument' }] });

  await page.goto('/#/reports');
  await expect(page.getByRole('button', { name: /View instrument details/ })).toBeVisible();
  await expect(page.getByTestId('kept-search-notice')).toHaveCount(0);
  expect(await stored(page)).not.toBeNull();
});

test('a kept search whose instrument was deleted is dropped with a notice, and nothing is filtered by it', async ({ page, request }) => {
  const id = await goneInstrument(request);
  await keep(page, { text: 'reports of a deleted instrument', filters: { instrument_id: id, report_type: 'repair' }, understood: [{ key: 'instrument_id', label: 'Gone' }] });

  // Opening straight on Reports: it waits for the check, then starts unfiltered and says why.
  await page.goto('/#/reports');
  await expect(page.getByTestId('kept-search-notice')).toContainText('Your last search was cleared: the instrument it named no longer exists.');
  await expect(page.getByRole('button', { name: /View instrument details/ })).toHaveCount(0);
  await expect(page.locator('select[aria-label="Report type"]')).toHaveValue('');
  await expect(page.getByTestId('ask-input')).toHaveValue('');
  expect(await stored(page)).toBeNull();

  // The notice goes when it is dismissed.
  await page.getByTestId('kept-search-notice').getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByTestId('kept-search-notice')).toHaveCount(0);
});

test('the same drop, seen from Home, which is not held back by the check', async ({ page, request }) => {
  const id = await goneInstrument(request);
  await keep(page, { text: 'reports of a deleted instrument', filters: { instrument_id: id }, understood: [] });
  await page.goto('/#/home');
  await expect(page.getByTestId('kept-search-notice')).toContainText('the instrument it named no longer exists');
  await expect(page.getByTestId('home-ask').getByTestId('ask-input')).toHaveValue('');
});

test('a gone instrument, model and place are all named', async ({ page }) => {
  const missing = '00000000-0000-4000-8000-000000000000';
  await keep(page, { text: 'old', filters: { instrument_id: missing, model_id: missing, place_id: missing }, understood: [] });
  await page.goto('/#/analytics');
  // Analytics has no Ask box, so the notice waits on the screens that do; the search is gone either way.
  await expect(page.getByTestId('kept-search-checking')).toHaveCount(0);
  await expect.poll(() => stored(page)).toBeNull();
  await page.getByTestId('tab-home').click();
  await expect(page.getByTestId('kept-search-notice')).toContainText('the instrument, model and place it named no longer exists');
});

test('a stored record that is not ours is ignored, and the app opens normally', async ({ page }) => {
  await keep(page, '{this is not json');
  await page.goto('/#/reports');
  await expect(page.getByTestId('ask-input')).toHaveValue('');
  await expect(page.getByTestId('kept-search-notice')).toHaveCount(0);
  await expect(page.locator('select[aria-label="Status"]')).toBeVisible();

  await keep(page, { text: 'x', filters: { report_type: 'repair' } }); // understood missing
  await page.goto('/#/reports');
  await expect(page.getByTestId('ask-input')).toHaveValue('');
  await expect(page.locator('select[aria-label="Report type"]')).toHaveValue('');
});

test('if the check cannot be made, the search is kept rather than lost', async ({ page, request }) => {
  const instruments = await (await request.get(`${API_BASE}/instruments`)).json();
  await keep(page, { text: 'one instrument', filters: { instrument_id: instruments[0].id }, understood: [{ key: 'instrument_id', label: 'One' }] });
  await page.route('**/instruments', (route) => route.abort());
  await page.goto('/#/home');
  await page.reload();
  await expect(page.getByTestId('home-ask').getByTestId('ask-input')).toHaveValue('one instrument');
  await expect(page.getByTestId('kept-search-notice')).toHaveCount(0);
  expect(await stored(page)).not.toBeNull();
});
