import { type APIRequestContext, type Page } from '@playwright/test';
import { test, expect } from './coverage';
import { BACKEND_PORT } from '../../playwright.config';

// The model filter: every unit of one model record. The Reports and Analytics tabs share one filter
// bar, which now has a Model choice (the instrument choice narrows to it); the Instruments list has
// its own; saved filters keep the model; the CSV export follows it.

const API_BASE = `http://localhost:${BACKEND_PORT}`;

type Unit = { id: string; name: string; serial: string; model: string; technician: string };

/** One instrument of its own model, with one report on it (so lists and charts have something to show). */
async function unitWithReport(request: APIRequestContext, stamp: number, tag: string): Promise<Unit> {
  const model = `E2E-MF-${tag}-${stamp}`;
  const serial = `SN-MF-${tag}-${stamp}`;
  const name = `E2E MF ${tag} ${stamp}`;
  const technician = `E2E-MF-Tech-${tag}-${stamp}`;
  const created = await request.post(`${API_BASE}/instruments`, {
    data: { name, model, manufacturer: 'E2E Maker', serial_number: serial },
  });
  expect(created.status()).toBe(201);
  const instrument = await created.json();
  const template = await (
    await request.post(`${API_BASE}/report-templates`, {
      data: { instrument_type: 'facs', report_type: 'repair', model, fields: [{ name: 'summary', type: 'text' }] },
    })
  ).json();
  const report = await (await request.post(`${API_BASE}/reports`, { data: { technician_name: technician } })).json();
  const confirmed = await request.patch(`${API_BASE}/reports/${report.id}/template`, {
    data: { instrument_id: instrument.id, template_id: template.id },
  });
  expect(confirmed.ok()).toBeTruthy();
  return { id: instrument.id, name, serial, model, technician };
}

async function clearSavedFilters(request: APIRequestContext) {
  const { items } = await (await request.get(`${API_BASE}/saved-report-filters`)).json();
  for (const item of items) await request.delete(`${API_BASE}/saved-report-filters/${item.id}`);
}

async function openReports(page: Page) {
  await page.goto('/');
  await page.click('.view-tab:has-text("Reports")');
  await page.waitForSelector('.report-table, .empty-hint');
}

test.beforeEach(async ({ request }) => clearSavedFilters(request));
test.afterEach(async ({ request }) => clearSavedFilters(request));

test('Reports: the Model choice keeps one model, narrows the instruments, and the export follows it', async ({ page, request }) => {
  const stamp = Date.now();
  const a = await unitWithReport(request, stamp, 'A');
  const b = await unitWithReport(request, stamp, 'B');
  await openReports(page);

  const bar = page.locator('.filter-row');
  await expect(page.locator('.report-row-body', { hasText: a.technician })).toBeVisible();
  await expect(page.locator('.report-row-body', { hasText: b.technician })).toBeVisible();

  await bar.getByLabel('Model', { exact: true }).selectOption({ label: a.model });
  await expect(page.locator('.report-row-body', { hasText: a.technician })).toBeVisible();
  await expect(page.locator('.report-row-body', { hasText: b.technician })).toHaveCount(0);

  // The instrument choice only offers the units of that model.
  const instruments = bar.getByLabel('Instrument', { exact: true }).locator('option');
  await expect(instruments.filter({ hasText: a.serial })).toHaveCount(1);
  await expect(instruments.filter({ hasText: b.serial })).toHaveCount(0);

  // The CSV export is the same filter.
  const href = await page.getByRole('link', { name: /Export CSV/ }).getAttribute('href');
  expect(new URL(href!).searchParams.get('model_id')).toBeTruthy();

  // Choosing the model's own instrument still works, and "All models" lifts the filter.
  await bar.getByLabel('Instrument', { exact: true }).selectOption({ label: `${a.model} (${a.serial})` });
  await expect(page.locator('.report-row-body', { hasText: a.technician })).toBeVisible();
  await bar.getByLabel('Model', { exact: true }).selectOption('');
  await bar.getByLabel('Instrument', { exact: true }).selectOption('');
  await expect(page.locator('.report-row-body', { hasText: b.technician })).toBeVisible();
});

test('Reports: choosing a model drops an instrument of another model, and the folded bar names the model', async ({ page, request }) => {
  const stamp = Date.now();
  const a = await unitWithReport(request, stamp, 'A');
  const b = await unitWithReport(request, stamp, 'B');
  await openReports(page);

  const bar = page.locator('.filter-row');
  await bar.getByLabel('Instrument', { exact: true }).selectOption({ label: `${b.model} (${b.serial})` });
  await expect(page.locator('.report-row-body', { hasText: a.technician })).toHaveCount(0);

  await bar.getByLabel('Model', { exact: true }).selectOption({ label: a.model });
  // The instrument of the other model was dropped rather than left to contradict the model.
  await expect(bar.getByLabel('Instrument', { exact: true })).toHaveValue('');
  await expect(page.locator('.report-row-body', { hasText: a.technician })).toBeVisible();

  await page.getByRole('button', { name: 'Hide filters ▴' }).click();
  await expect(page.locator('.filters-summary-text')).toContainText(a.model);
  await page.getByRole('button', { name: 'Show filters ▾' }).click();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(bar.getByLabel('Model', { exact: true })).toHaveValue('');
});

test('Analytics: the same Model choice narrows the charts, and a maker change drops a model of another maker', async ({ page, request }) => {
  const stamp = Date.now();
  const a = await unitWithReport(request, stamp, 'A');
  const b = await unitWithReport(request, stamp, 'B');
  await page.goto('/#/analytics');
  const bar = page.getByTestId('analytics-filters');
  await expect(bar).toBeVisible({ timeout: 15_000 });
  await expect(bar.getByLabel('Model', { exact: true })).toBeVisible();

  // These reports are not finalized, so count every status.
  await bar.getByLabel('Status').selectOption('all');
  const perInstrument = page.getByTestId('reports-per-instrument-chart');
  await expect(perInstrument).toContainText(a.name, { timeout: 15_000 });
  await expect(perInstrument).toContainText(b.name);

  await bar.getByLabel('Model', { exact: true }).selectOption({ label: a.model });
  await expect(perInstrument).toContainText(a.name);
  await expect(perInstrument).not.toContainText(b.name);

  // The maker choice keeps the models of that maker only, and drops a model of another maker.
  await bar.getByLabel('Manufacturer').selectOption('BD');
  await expect(bar.getByLabel('Model', { exact: true })).toHaveValue('');
  await expect(bar.getByLabel('Model', { exact: true }).locator('option', { hasText: a.model })).toHaveCount(0);
});

test('Instruments: the list can be narrowed to one model', async ({ page, request }) => {
  const stamp = Date.now();
  const a = await unitWithReport(request, stamp, 'A');
  const b = await unitWithReport(request, stamp, 'B');
  await page.goto('/');
  await page.click('.view-tab:has-text("Instruments")');
  const rowA = page.locator('.instrument-row.template-row-body', { hasText: a.name });
  const rowB = page.locator('.instrument-row.template-row-body', { hasText: b.name });
  await expect(rowA).toBeVisible();
  await expect(rowB).toBeVisible();

  await page.getByLabel('Filter by model').selectOption({ label: a.model });
  await expect(rowA).toBeVisible();
  await expect(rowB).toHaveCount(0);

  // It combines with the maintenance filter: nothing of this model is overdue.
  await page.getByLabel('Filter by maintenance').selectOption('overdue');
  await expect(rowA).toHaveCount(0);
  await expect(page.locator('.empty-hint')).toContainText('No instruments match these filters');
  await page.getByLabel('Filter by maintenance').selectOption('all');
  await page.getByLabel('Filter by model').selectOption('all');
  await expect(rowB).toBeVisible();
});

test('Saved filters keep the model, and go stale when the model is deleted', async ({ page, request }) => {
  const stamp = Date.now();
  const a = await unitWithReport(request, stamp, 'A');
  const b = await unitWithReport(request, stamp, 'B');
  await openReports(page);

  const bar = page.locator('.filter-row');
  await bar.getByLabel('Model', { exact: true }).selectOption({ label: a.model });
  await page.click('button:has-text("Save this filter")');
  await page.fill('input[aria-label="Saved filter name"]', `Model ${stamp}`);
  await page.click('.saved-filter-name button:has-text("Save")');
  await expect(page.locator('[data-testid="saved-filter-active"]')).toContainText(`Model ${stamp}`);

  // After a reload nothing is filtered; picking the saved filter brings the model back.
  await openReports(page);
  await expect(page.locator('.report-row-body', { hasText: b.technician })).toBeVisible();
  await page.selectOption('select[aria-label="Saved filters"]', { label: `Model ${stamp}` });
  await expect(bar.getByLabel('Model', { exact: true }).locator('option:checked')).toHaveText(a.model);
  await expect(page.locator('.report-row-body', { hasText: b.technician })).toHaveCount(0);
  await expect(page.locator('[data-testid="saved-filter-active"]')).not.toContainText('(changed)');

  // Delete the unit and its model: the saved filter is marked, and applying it leaves the model out.
  const deleted = await request.delete(`${API_BASE}/instruments/${a.id}`);
  expect(deleted.status()).toBe(204);
  const models = await (await request.get(`${API_BASE}/instrument-models`)).json();
  const record = models.find((m: { name: string }) => m.name === a.model);
  expect((await request.delete(`${API_BASE}/instrument-models/${record.id}`)).status()).toBe(204);

  await openReports(page);
  const option = page.locator('select[aria-label="Saved filters"] option', { hasText: `Model ${stamp}` });
  await expect(option).toContainText('model no longer exists');
  await page.selectOption('select[aria-label="Saved filters"]', { label: `⚠ Model ${stamp} (model no longer exists)` });
  await expect(page.getByText('The saved model no longer exists')).toBeVisible();
  await expect(bar.getByLabel('Model', { exact: true })).toHaveValue('');
});
