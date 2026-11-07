import { test, expect } from './coverage';
import { seedReport } from './helpers/api';

// The "Ask in plain words" box on the Reports tab fills the same filters the bar below holds.

test('a plain-words request fills the filters and narrows the list', async ({ page, request }) => {
  const tech = 'Zed Askerson';
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: tech });
  await seedReport(request, { model: 'LSRFortessa', reportType: 'preventive_maintenance', technician: tech });

  await page.goto('/#/reports');
  await page.getByTestId('ask-input').fill('repairs by zed askerson');
  await page.getByTestId('ask-submit').click();

  const chips = page.getByTestId('ask-chip');
  await expect(chips.filter({ hasText: 'Repair' })).toHaveCount(1);
  await expect(chips.filter({ hasText: 'Lab manager: Zed Askerson' })).toHaveCount(1);

  // The filter bar shows what was understood, and the list holds only the repair by that person.
  await expect(page.getByTestId('result-count')).toContainText('1');
  await expect(page.getByTestId('report-row')).toHaveCount(1);
  await expect(page.locator('input[value="Zed Askerson" i], input[value="zed askerson"]').first()).toBeVisible();
});

test('words that match no filter say so and keep every report', async ({ page }) => {
  await page.goto('/#/reports');
  await page.getByTestId('ask-input').fill('show me all reports');
  await page.getByTestId('ask-submit').click();
  await expect(page.getByTestId('ask-understood')).toContainText('Nothing in that matched a filter');
});

test('an example fills the box and applies', async ({ page }) => {
  await page.goto('/#/reports');
  await page.getByRole('button', { name: 'waiting for review' }).click();
  await expect(page.getByTestId('ask-chip').filter({ hasText: 'waiting for review' })).toHaveCount(1);
});
