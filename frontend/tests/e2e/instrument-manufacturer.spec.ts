import { test, expect } from './coverage';

// The optional Manufacturer field on an instrument (the fleet is no longer
// BD-only): set when creating, shown in the Instruments list and on the
// instrument's detail page, editable, and clearable. Every instrument here
// has a unique name/serial because the suite shares one database.

test('manufacturer can be set, shown in the list and detail page, edited and cleared', async ({ page }) => {
  const stamp = Date.now();
  const name = `E2E-Maker-${stamp}`;
  const serial = `E2E-MFR-${stamp}`;
  const label = (text: string) => page.locator('.schema-form-label', { hasText: text }).locator('input');

  await page.goto('/');
  await page.click('.view-tab:has-text("Instruments")');
  await page.click('button:has-text("+ New instrument")');
  await label('Name').fill(name);
  await label('Model').fill('E2E-Cytometer');
  await label('Manufacturer').fill('  Acme Optics ');
  await label('Serial number').fill(serial);
  await page.click('button:has-text("Create instrument")');

  const row = page.locator('.instrument-row.template-row-body', { hasText: name });
  await expect(row).toContainText('Acme Optics');
  await expect(row).toContainText('E2E-Cytometer');

  // Detail page (reached through the Reports tab's instrument filter).
  await page.click('.view-tab:has-text("Reports")');
  await page.locator('.filter-row select').first().selectOption({ value: await optionValue(page, serial) });
  await page.click('button:has-text("View instrument details")');
  await expect(page.locator('.instrument-meta')).toContainText(`Acme Optics E2E-Cytometer · S/N ${serial}`);

  // Edit it, then clear it.
  await page.click('.view-tab:has-text("Instruments")');
  await row.locator('button:has-text("Edit")').click();
  await expect(label('Manufacturer')).toHaveValue('Acme Optics');
  await label('Manufacturer').fill('Globex');
  await page.click('button:has-text("Save changes")');
  await expect(row).toContainText('Globex');

  await row.locator('button:has-text("Edit")').click();
  await label('Manufacturer').fill('');
  await page.click('button:has-text("Save changes")');
  await expect(row).not.toContainText('Globex');
  await expect(row).toContainText('—');
});

async function optionValue(page: import('@playwright/test').Page, serial: string): Promise<string> {
  const option = page.locator('.filter-row select').first().locator('option', { hasText: serial });
  return (await option.getAttribute('value')) ?? '';
}
