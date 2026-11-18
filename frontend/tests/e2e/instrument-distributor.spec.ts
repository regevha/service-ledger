import { test, expect } from './coverage';

// The optional Distributor field on an instrument (the local seller / service
// company when it is not the maker, e.g. Omega Distribution): optional on create, shown
// in the Instruments list and on the instrument's detail page, editable and
// clearable. Unique name and serial because the suite shares one database.

test('distributor is optional, shown in the list and detail page, edited and cleared', async ({ page }) => {
  const stamp = Date.now();
  const withName = `E2E-Dist-${stamp}`;
  const withSerial = `E2E-DST-${stamp}`;
  const withoutName = `E2E-NoDist-${stamp}`;
  const withoutSerial = `E2E-NDS-${stamp}`;
  const label = (text: string) => page.getByTestId('form-label').filter({ hasText: new RegExp('^\\s*' + text) }).locator('input');

  // A new model per run: an existing model would lock the manufacturer.
  const model = `E2E-Cytometer-${Date.now()}`;
  await page.goto('/#/new');
  await page.getByTestId('tab-instruments').click();

  // Created without a distributor: allowed, shown as a dash.
  await page.click('button:has-text("+ New instrument")');
  await label('Name').fill(withoutName);
  await label('Model').fill(model);
  await label('Manufacturer').fill('Acme Optics');
  await label('Serial number').fill(withoutSerial);
  await page.click('button:has-text("Create instrument")');
  const plainRow = page.getByTestId('instrument-row').filter({ hasText: withoutName });
  await expect(plainRow).toContainText('Acme Optics');
  await expect(plainRow.locator('span').nth(2)).toHaveText('—');

  // Created with one: trimmed and shown in the list.
  await page.click('button:has-text("+ New instrument")');
  await label('Name').fill(withName);
  await label('Model').fill(model);
  await expect(label('Manufacturer')).toHaveValue('Acme Optics'); // follows the model
  await label('Distributor').fill('  Omega Distribution ');
  await label('Serial number').fill(withSerial);
  await page.click('button:has-text("Create instrument")');
  const row = page.getByTestId('instrument-row').filter({ hasText: withName });
  await expect(row.locator('span').nth(2)).toHaveText('Omega Distribution');

  // Detail page (reached through the Reports tab's instrument filter).
  await page.getByTestId('tab-reports').click();
  const select = page.getByLabel('Instrument', { exact: true });
  const value = (await select.locator('option', { hasText: withSerial }).getAttribute('value')) ?? '';
  await select.selectOption({ value });
  await page.click('button:has-text("View instrument details")');
  await expect(page.locator('.instrument-meta')).toContainText('Distributor: Omega Distribution');

  // Edit it, then clear it.
  await page.getByTestId('tab-instruments').click();
  await row.locator('button:has-text("Edit")').click();
  await expect(label('Distributor')).toHaveValue('Omega Distribution');
  await label('Distributor').fill('sigma diagnostics');
  await page.click('button:has-text("Save changes")');
  await expect(row).toContainText('sigma diagnostics');

  await row.locator('button:has-text("Edit")').click();
  await label('Distributor').fill('');
  await page.click('button:has-text("Save changes")');
  await expect(row).not.toContainText('sigma diagnostics');
  await expect(row.locator('span').nth(2)).toHaveText('—');
});
