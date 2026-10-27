import { test, expect } from './coverage';

// The optional Manufacturer field on an instrument (the fleet is no longer
// BD-only): set when creating, shown in the Instruments list and on the
// instrument's detail page, editable, and clearable. Every instrument here
// has a unique name/serial because the suite shares one database.

test('manufacturer can be set, shown in the list and detail page, and follows the model', async ({ page }) => {
  const stamp = Date.now();
  const name = `E2E-Maker-${stamp}`;
  const model = `E2E-Cytometer-${stamp}`;
  const serial = `E2E-MFR-${stamp}`;
  const label = (text: string) => page.locator('.schema-form-label', { hasText: new RegExp('^\\s*' + text) }).locator('input');

  await page.goto('/');
  await page.click('.view-tab:has-text("Instruments")');
  await page.click('button:has-text("+ New instrument")');
  await label('Name').fill(name);
  await label('Model').fill(model);
  await label('Manufacturer').fill('  Acme Optics ');
  await label('Serial number').fill(serial);
  await page.click('button:has-text("Create instrument")');

  const row = page.locator('.instrument-row.template-row-body', { hasText: name });
  await expect(row).toContainText('Acme Optics');
  await expect(row).toContainText(model);

  // Detail page (reached through the Reports tab's instrument filter).
  await page.click('.view-tab:has-text("Reports")');
  await page.locator('.filter-row select[aria-label="Instrument"]').selectOption({ value: await optionValue(page, serial) });
  await page.click('button:has-text("View instrument details")');
  await expect(page.locator('.instrument-meta')).toContainText(`Acme Optics ${model} · S/N ${serial}`);

  // The manufacturer follows the model: the instrument's form shows it
  // read-only, and changing it on the Models screen changes the instrument.
  await page.click('.view-tab:has-text("Instruments")');
  await row.locator('button:has-text("Edit")').click();
  await expect(label('Manufacturer')).toHaveValue('Acme Optics');
  await expect(label('Manufacturer')).toBeDisabled();
  await page.click('button:has-text("Cancel")');

  await page.click('.sub-switch button:has-text("Models")');
  const modelRow = page.locator('.model-row.template-row-body', {
    has: page.locator('.model-name', { hasText: new RegExp(`^${model}$`) }),
  });
  await modelRow.locator('button:has-text("Edit")').click();
  await page.locator('.schema-form-label', { hasText: new RegExp('^\\s*Manufacturer') }).locator('input').fill('Globex');
  await page.click('button:has-text("Save changes")');

  await page.click('.sub-switch button:has-text("Instruments")');
  await expect(row).toContainText('Globex');
});

async function optionValue(page: import('@playwright/test').Page, serial: string): Promise<string> {
  const option = page.locator('.filter-row select[aria-label="Instrument"]').locator('option', { hasText: serial });
  return (await option.getAttribute('value')) ?? '';
}
