import { test, expect } from './coverage';
import { BACKEND_PORT } from '../../playwright.config';

// "Institution" on an instrument (the university or company it belongs to): typed on the form,
// shown under the name in the list and on the instrument's page, editable, and shown next to the
// instrument in the Analytics hours chart.

const API_BASE = `http://localhost:${BACKEND_PORT}`;

test('institution: set on create, shown in the list, changed and cleared on edit', async ({ page }) => {
  const name = `E2E-Inst-${Date.now()}`;
  const serial = `E2E-INST-SN-${Date.now()}`;
  await page.goto('/');
  await page.click('.view-tab:has-text("Instruments")');
  await page.click('button:has-text("+ New instrument")');
  await page.locator('.schema-form-label', { hasText: /^\s*Name/ }).locator('input').fill(name);
  await page.locator('.schema-form-label', { hasText: 'Model' }).locator('input').fill('E2E-Model');
  await page.locator('.schema-form-label', { hasText: 'Manufacturer' }).locator('input').fill('E2E Maker');
  await page.locator('.schema-form-label', { hasText: 'Serial number' }).locator('input').fill(serial);
  await page.locator('.schema-form-label', { hasText: 'Institution' }).locator('input').fill('  Bar-Ilan University ');
  await page.click('button:has-text("Create instrument")');

  const row = page.locator('.instrument-row.template-row-body', { hasText: name });
  await expect(row.locator('.instrument-institution')).toHaveText('Bar-Ilan University');

  await row.locator('button:has-text("Edit")').click();
  const input = page.locator('.schema-form-label', { hasText: 'Institution' }).locator('input');
  await expect(input).toHaveValue('Bar-Ilan University');
  await input.fill('Tel Aviv University');
  await page.click('button:has-text("Save changes")');
  await expect(row.locator('.instrument-institution')).toHaveText('Tel Aviv University');

  await row.locator('button:has-text("Edit")').click();
  await page.locator('.schema-form-label', { hasText: 'Institution' }).locator('input').fill('');
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
  const bar = section.locator('.labor-bar', { has: page.locator('title', { hasText: name }) });
  // Long names are cut in the picture; the full name is in the bar's tooltip.
  await expect(bar.locator('title')).toContainText(name);
  await expect(bar.locator('.labor-bar-sub')).toContainText('Bar-Ilan');
  await expect(bar.locator('.labor-bar-none')).toHaveText('none');
});
