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
