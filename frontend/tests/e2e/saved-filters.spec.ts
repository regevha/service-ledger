import { type APIRequestContext, type Page } from '@playwright/test';
import { test, expect } from './coverage';
import { BACKEND_PORT } from '../../playwright.config';

// Saved filters on the Reports list: a short global list (at most five) of named
// combinations of the six filters. The list is shared by every spec in this
// run, so each test clears it first and leaves it empty.

const API_BASE = `http://localhost:${BACKEND_PORT}`;

async function clearSavedFilters(request: APIRequestContext) {
  const { items } = await (await request.get(`${API_BASE}/saved-report-filters`)).json();
  for (const item of items) await request.delete(`${API_BASE}/saved-report-filters/${item.id}`);
}

async function reportFor(request: APIRequestContext, technician: string) {
  const res = await request.post(`${API_BASE}/reports`, { data: { technician_name: technician } });
  expect(res.status()).toBe(201);
}

async function openReports(page: Page) {
  await page.goto('/');
  await page.click('.view-tab:has-text("Reports")');
  await page.waitForSelector('.report-table, .empty-hint');
}

async function saveCurrent(page: Page, name: string) {
  await page.click('button:has-text("Save this filter")');
  await page.fill('input[aria-label="Saved filter name"]', name);
  await page.click('.saved-filter-name button:has-text("Save")');
}

test.beforeEach(async ({ request }) => clearSavedFilters(request));
test.afterEach(async ({ request }) => clearSavedFilters(request));

test('save a filter, reload, pick it, see the same rows, then delete it', async ({ page, request }) => {
  const stamp = Date.now();
  const mine = `E2E-SF-Mine-${stamp}`;
  const other = `E2E-SF-Other-${stamp}`;
  await reportFor(request, mine);
  await reportFor(request, other);

  await openReports(page);
  await expect(page.locator('button:has-text("Save this filter")')).toBeDisabled();

  await page.fill('input[aria-label="Lab manager"]', mine);
  await expect(page.locator('.report-row-body', { hasText: other })).toHaveCount(0);
  await saveCurrent(page, `Mine ${stamp}`);
  await expect(page.locator('[data-testid="saved-filter-active"]')).toContainText(`Mine ${stamp}`);
  await expect(page.locator('select[aria-label="Saved filters"] option').first()).toContainText('1 of 5');

  // After a reload nothing is filtered, and the saved filter is still there.
  await openReports(page);
  await expect(page.locator('.report-row-body', { hasText: other })).toBeVisible();
  await page.selectOption('select[aria-label="Saved filters"]', { label: `Mine ${stamp}` });
  await expect(page.locator('input[aria-label="Lab manager"]')).toHaveValue(mine);
  await expect(page.locator('.report-row-body', { hasText: mine })).toBeVisible();
  await expect(page.locator('.report-row-body', { hasText: other })).toHaveCount(0);
  await expect(page.locator('[data-testid="saved-filter-active"]')).not.toContainText('(changed)');

  // Editing a control marks it as changed.
  await page.getByLabel('Status', { exact: true }).selectOption('finalized');
  await expect(page.locator('[data-testid="saved-filter-active"]')).toContainText('(changed)');

  // Delete asks first, and says it removes the filter for everyone.
  await page.click(`button:has-text("Delete “Mine ${stamp}”")`);
  await expect(page.locator('.saved-filters')).toContainText('for everyone');
  await page.click('button:has-text("Keep")');
  await expect(page.locator('select[aria-label="Saved filters"] option')).toHaveCount(2);
  await page.click(`button:has-text("Delete “Mine ${stamp}”")`);
  await page.click('button:has-text("Yes, delete")');
  await expect(page.locator('select[aria-label="Saved filters"] option')).toHaveCount(1);
});

test('a duplicate name is refused in place, and a sixth filter is blocked', async ({ page, request }) => {
  const stamp = Date.now();
  await reportFor(request, `E2E-SF-Dup-${stamp}`);

  await openReports(page);
  await page.fill('input[aria-label="Lab manager"]', `E2E-SF-Dup-${stamp}`);
  await saveCurrent(page, `Same name ${stamp}`);
  await expect(page.locator('[data-testid="saved-filter-active"]')).toBeVisible();

  await saveCurrent(page, `same NAME ${stamp}`);
  await expect(page.locator('[role="alert"]')).toContainText('already exists');
  await page.click('.saved-filter-name button:has-text("Cancel")');

  // Fill the remaining four slots through the API; the save button then locks.
  for (let n = 0; n < 4; n++) {
    const res = await request.post(`${API_BASE}/saved-report-filters`, {
      data: { name: `Filler ${stamp} ${n}`, filters: { technician: `filler-${n}` } },
    });
    expect(res.status()).toBe(201);
  }
  await openReports(page);
  await page.fill('input[aria-label="Lab manager"]', 'anything');
  await expect(page.locator('select[aria-label="Saved filters"] option').first()).toContainText('5 of 5');
  await expect(page.locator('button:has-text("Save this filter")')).toBeDisabled();
});

test('a filter whose instrument was deleted is marked stale and still applies its other criteria', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const marker = `E2E-SF-Stale-${stamp}`;
  const inst = await (
    await request.post(`${API_BASE}/instruments`, {
      data: { name: `Temp ${stamp}`, model: 'E2E-SF-Model', manufacturer: 'BD', serial_number: `SF-${stamp}` },
    })
  ).json();
  await reportFor(request, marker);
  const created = await request.post(`${API_BASE}/saved-report-filters`, {
    data: { name: `Stale ${stamp}`, filters: { instrument_id: inst.id, technician: marker } },
  });
  expect(created.status()).toBe(201);
  expect((await request.delete(`${API_BASE}/instruments/${inst.id}`)).status()).toBe(204);

  await openReports(page);
  const option = page.locator('select[aria-label="Saved filters"] option', { hasText: `Stale ${stamp}` });
  await expect(option).toContainText('instrument no longer exists');
  await page.selectOption('select[aria-label="Saved filters"]', { label: await option.innerText() });
  await expect(page.locator('.saved-filters')).toContainText('The saved instrument no longer exists');
  await expect(page.locator('input[aria-label="Lab manager"]')).toHaveValue(marker);
  await expect(page.locator('.report-row-body', { hasText: marker })).toBeVisible();
  await expect(page.locator('[data-testid="saved-filter-active"]')).not.toContainText('(changed)');
});

// Found on 2026-10-16: with only a search word typed (for example "valve") the
// Save button was greyed out and did nothing. The search text is now part of a
// saved filter.
test('a search word alone can be saved, and applying it fills the search box again', async ({ page, request }) => {
  const stamp = Date.now();
  const word = `valve${stamp}`;
  const search = page.locator('input[aria-label="Search reports"]');
  const picker = page.locator('select[aria-label="Saved filters"]');
  const save = page.locator('button:has-text("Save this filter")');

  // A second saved filter without any search, to check that applying it clears the box.
  const res = await request.post(`${API_BASE}/saved-report-filters`, {
    data: { name: `Lab ${stamp}`, filters: { technician: `lab-${stamp}` } },
  });
  expect(res.status()).toBe(201);

  await openReports(page);
  await expect(save).toBeDisabled();
  await search.fill(word);
  await expect(save).toBeEnabled();
  await saveCurrent(page, `Search ${stamp}`);
  await expect(page.locator('[data-testid="saved-filter-active"]')).toContainText(`Search ${stamp}`);

  const { items } = await (await request.get(`${API_BASE}/saved-report-filters`)).json();
  expect(items.find((i: { name: string }) => i.name === `Search ${stamp}`).filters).toEqual({ q: word });

  // After a reload the box is empty; picking the saved filter fills it again.
  await openReports(page);
  await expect(search).toHaveValue('');
  await picker.selectOption({ label: `Search ${stamp}` });
  await expect(search).toHaveValue(word);
  await expect(page.locator('[data-testid="saved-filter-active"]')).not.toContainText('(changed)');

  // Typing something else marks it as changed.
  await search.fill(`${word}x`);
  await expect(page.locator('[data-testid="saved-filter-active"]')).toContainText('(changed)');

  // Applying a filter that has no search clears the search box.
  await picker.selectOption({ label: `Lab ${stamp}` });
  await expect(search).toHaveValue('');
  await expect(page.locator('input[aria-label="Lab manager"]')).toHaveValue(`lab-${stamp}`);
});
