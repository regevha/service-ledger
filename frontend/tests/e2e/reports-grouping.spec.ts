import { test, expect } from './coverage';
import { seedReport } from './helpers/api';

// The Reports list opens grouped by instrument: one card per instrument with its reports inside, a count,
// a "need review" chip and a link to the instrument page. "Group: None" is the flat sortable table.

test('reports are grouped by instrument, and Group: None shows the flat table', async ({ page, request }) => {
  const stamp = Date.now();
  const a = `E2E-GroupA-${stamp}`;
  const b = `E2E-GroupB-${stamp}`;
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: a, finalize: true });
  await seedReport(request, { model: 'FACSAria III', reportType: 'preventive_maintenance', technician: b, finalize: true });

  await page.setViewportSize({ width: 1300, height: 900 });
  await page.goto('/#/reports');
  await expect(page.getByTestId('report-groups')).toBeVisible();
  await expect(page.getByTestId('group-select')).toHaveValue('instrument');
  // No sort headers on the grouped view.
  await expect(page.locator('.report-row-head')).toHaveCount(0);

  const groupA = page.getByTestId('report-group').filter({ has: page.locator('.report-row-body', { hasText: a }) });
  await expect(groupA).toHaveCount(1);
  await expect(groupA.locator('.report-group-head strong')).toHaveText('LSRFortessa');
  await expect(groupA.locator('.report-row-body', { hasText: b })).toHaveCount(0);
  await expect(groupA.getByRole('button', { name: /Instrument page/ })).toBeVisible();

  // A row still opens its report.
  await groupA.locator('.report-row-body', { hasText: a }).click();
  await expect(page.locator('.field-list, .back-link').first()).toBeVisible();
  await page.goBack();

  // None: one flat table with sortable headers; the choice is remembered.
  await page.getByTestId('group-select').selectOption('none');
  await expect(page.getByTestId('report-groups')).toHaveCount(0);
  await expect(page.getByTestId('sort-date')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('group-select')).toHaveValue('none');
});
