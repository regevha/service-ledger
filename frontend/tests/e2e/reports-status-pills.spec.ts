import { test, expect } from './coverage';
import { seedReport } from './helpers/api';
import { showFlatList } from './helpers/ui';

// Status pills above the Reports list: All plus each status that has reports, each with its count.
// A pill narrows the list (and the Status choice in the filter bar follows); All lifts it.

test('status pills show counts and filter the list', async ({ page, request }) => {
  const stamp = Date.now();
  const done = `E2E-PillDone-${stamp}`;
  const open = `E2E-PillOpen-${stamp}`;
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: done, finalize: true });
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: open });

  await page.setViewportSize({ width: 1300, height: 900 });
  await page.goto('/#/reports');
  const pills = page.getByTestId('status-pills');
  await expect(pills).toBeVisible();
  const finalized = pills.getByRole('button', { name: /^Finalized \d+$/ });
  await expect(finalized).toBeVisible();
  await expect(pills.getByRole('button', { name: /^All \d+$/ })).toHaveAttribute('aria-pressed', 'true');

  await finalized.click();
  await expect(finalized).toHaveAttribute('aria-pressed', 'true');
  await showFlatList(page);
  await expect(page.locator('.report-row-body', { hasText: done })).toBeVisible();
  await expect(page.locator('.report-row-body', { hasText: open })).toHaveCount(0);
  await expect(page.getByLabel('Status', { exact: true })).toHaveValue('finalized');

  // The count of the other statuses does not change when one is chosen.
  await expect(pills.getByRole('button', { name: /^All \d+$/ })).toBeVisible();
  await pills.getByRole('button', { name: /^All \d+$/ }).click();
  await expect(page.locator('.report-row-body', { hasText: open })).toBeVisible();
});
