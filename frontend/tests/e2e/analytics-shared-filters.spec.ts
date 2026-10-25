import { test, expect } from './coverage';

// The Analytics tab and the Reports tab use one filter bar (ReportFilterBar), so they offer the
// same controls and mean the same by them.

const CONTROLS = ['Search reports', 'Instrument', 'Report type', 'Status', 'From date', 'To date', 'Lab manager'];

test('Analytics offers the same filters as the Reports tab', async ({ page }) => {
  await page.goto('/#/reports');
  const reportsBar = page.locator('.filter-row');
  for (const label of CONTROLS) await expect(reportsBar.getByLabel(label, { exact: true })).toBeVisible();
  await expect(page.getByLabel('Saved filters', { exact: false }).first()).toBeVisible();

  await page.goto('/#/analytics');
  const bar = page.getByTestId('analytics-filters');
  await expect(bar).toBeVisible({ timeout: 15_000 });
  for (const label of CONTROLS) await expect(bar.getByLabel(label, { exact: true })).toBeVisible();
  await expect(page.getByLabel('Saved filters', { exact: false }).first()).toBeVisible();
  // Analytics' own extra: the maker.
  await expect(bar.getByLabel('Manufacturer')).toBeVisible();
});

test('Analytics: lab manager, search and status narrow the numbers', async ({ page }) => {
  await page.goto('/#/analytics');
  const bar = page.getByTestId('analytics-filters');
  const basis = page.getByTestId('analytics-basis');
  await expect(bar).toBeVisible({ timeout: 15_000 });
  await expect(bar.getByLabel('Status')).toHaveValue('');
  await expect(bar.getByLabel('Status').locator('option').first()).toHaveText('Finalized');

  await bar.getByLabel('Lab manager').fill('zz-nobody-has-this-name');
  await expect(basis).toContainText('Based on 0 finalized reports matching the filters');
  await bar.getByRole('button', { name: 'Clear filters' }).click();
  await expect(bar.getByLabel('Lab manager')).toHaveValue('');

  await bar.getByLabel('Search reports').fill('zzqqxxnothingmatches');
  await expect(basis).toContainText('Based on 0 finalized reports matching the filters');
  // Search covers finalized reports only, so a draft status leaves nothing either.
  await bar.getByLabel('Status').selectOption('draft');
  await expect(basis).toContainText('Based on 0');
  await bar.getByRole('button', { name: 'Clear filters' }).click();

  // "All statuses" is a separate choice from the default.
  await bar.getByLabel('Status').selectOption('all');
  await expect(basis).toContainText('matching the filters');
});

test('Analytics shows reports per instrument and per instrument model as column charts', async ({ page }) => {
  await page.goto('/#/analytics');
  const perInstrument = page.locator('.chart-section', { hasText: 'Finalized reports per instrument' }).first();
  await expect(page.getByTestId('reports-per-instrument-chart')).toBeVisible({ timeout: 15_000 });
  // One column per instrument (the seeded fleet has at least five), none of them cut off the page.
  expect(await page.locator('[data-testid="reports-per-instrument-chart"] .count-bar').count()).toBeGreaterThanOrEqual(5);
  await expect(page.getByTestId('reports-per-model-chart')).toBeVisible();
  await expect(page.locator('.chart-title', { hasText: 'Finalized reports per instrument model' })).toBeVisible();
  await expect(perInstrument).toBeVisible();

  // With the status filter changed, the titles stop saying "Finalized".
  await page.getByTestId('analytics-filters').getByLabel('Status').selectOption('all');
  await expect(page.locator('.chart-title', { hasText: /^Reports per instrument$/ })).toBeVisible();
});
