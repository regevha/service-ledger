import { test, expect } from './coverage';
import { API_BASE } from './helpers/api';

// "Institution" on an instrument (the university or company it belongs to): typed on the form,
// shown under the name in the list and on the instrument's page, editable, and shown next to the
// instrument in the Analytics hours chart.

test('institution: set on create, shown in the list, changed and cleared on edit', async ({ page }) => {
  const name = `E2E-Inst-${Date.now()}`;
  const serial = `E2E-INST-SN-${Date.now()}`;
  await page.goto('/#/new');
  await page.getByTestId('tab-instruments').click();
  await page.click('button:has-text("+ New instrument")');
  await page.getByTestId('form-label').filter({ hasText: /^\s*Name/ }).locator('input').fill(name);
  await page.getByTestId('form-label').filter({ hasText: 'Model' }).locator('input').fill('E2E-Model');
  await page.getByTestId('form-label').filter({ hasText: 'Manufacturer' }).locator('input').fill('E2E Maker');
  await page.getByTestId('form-label').filter({ hasText: 'Serial number' }).locator('input').fill(serial);
  await page.getByTestId('form-label').filter({ hasText: 'Institute' }).locator('input').fill('  Bar-Ilan University ');
  await page.click('button:has-text("Create instrument")');

  const row = page.getByTestId('instrument-row').filter({ hasText: name });
  await expect(row.locator('.instrument-institution')).toHaveText('Bar-Ilan University');

  await row.locator('button:has-text("Edit")').click();
  const input = page.getByTestId('form-label').filter({ hasText: 'Institute' }).locator('input');
  await expect(input).toHaveValue('Bar-Ilan University');
  await input.fill('Tel Aviv University');
  await page.click('button:has-text("Save changes")');
  await expect(row.locator('.instrument-institution')).toHaveText('Tel Aviv University');

  await row.locator('button:has-text("Edit")').click();
  await page.getByTestId('form-label').filter({ hasText: 'Institute' }).locator('input').fill('');
  await page.click('button:has-text("Save changes")');
  await expect(row).toBeVisible();
  await expect(row.locator('.instrument-institution')).toHaveCount(0);
});

test('Analytics hours chart: the bar is labelled with the instrument name and shows its institution', async ({ page, request }) => {
  const name = `E2E-Bar-${Date.now()}`;
  const made = await request.post(`${API_BASE}/instruments`, {
    data: { name, model: 'E2E-BarModel', manufacturer: 'E2E Maker', serial_number: `E2E-BAR-${Date.now()}`, institution: 'Bar-Ilan University' },
  });
  expect(made.ok()).toBeTruthy();

  await page.goto('/#/analytics');
  const section = page.locator('.chart-section', { hasText: 'Labor hours by instrument' });
  await expect(section.locator('.chart-note').first()).toContainText('repair and preventive maintenance reports');
  const bar = section.locator('.labor-bar', { hasText: name });
  await expect(bar.locator('.bar-label')).toHaveText(name);
  await expect(bar.locator('.bar-sublabel')).toContainText('Bar-Ilan University');
  await expect(bar.locator('.bar-value')).toHaveText('none');
});

test('a room needs an institution: the form will not save a room alone', async ({ page }) => {
  await page.goto('/#/new');
  await page.getByTestId('tab-instruments').click();
  await page.click('button:has-text("+ New instrument")');
  const field = (label: string | RegExp) => page.getByTestId('form-label').filter({ hasText: label }).locator('input');
  await field(/^\s*Name/).fill(`E2E-RoomOnly-${Date.now()}`);
  await field('Model').fill(`E2E-RoomModel-${Date.now()}`);
  await field('Manufacturer').fill('E2E Maker');
  await field('Serial number').fill(`E2E-ROOMONLY-${Date.now()}`);
  await field('Room name').fill('Room 7');
  await expect(page.locator('#place-hint')).toContainText('A room needs an institute');
  await expect(page.getByRole('button', { name: 'Create instrument' })).toBeDisabled();
  await field('Institute').fill('Bar-Ilan University');
  await expect(page.getByRole('button', { name: 'Create instrument' })).toBeEnabled();
});
