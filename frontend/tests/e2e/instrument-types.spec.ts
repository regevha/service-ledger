import { test, expect } from './coverage';
import { uniquePdf } from './unique-upload';
import { TIMEOUT } from './timeouts';
import { API_BASE } from './helpers/api';

// A second kind of instrument: a type is added from the instrument form, an
// instrument is created with it, and a report for that instrument says
// plainly that its type has no template yet instead of borrowing the flow
// cytometer one. Instrument types cannot be deleted, so each run uses its own
// uniquely named type; the instrument (and its report) is removed at the end.

test('a new instrument type can be added, used, and shows a clear message when it has no template', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const typeName = `E2E Microscope ${stamp}`;
  const name = `E2E-EM-${stamp}`;
  const serial = `EM-${stamp}`;
  const label = (text: string) => page.locator('.schema-form-label', { hasText: new RegExp('^\\s*' + text) }).locator('input');

  await page.goto('/');
  await page.click('.view-tab:has-text("Instruments")');
  await page.click('button:has-text("+ New instrument")');

  // Flow cytometer is the first type and the default.
  await expect(page.locator('#instrument-type')).toHaveValue('facs');
  // The seeded types are all offered.
  for (const seeded of ['Flow cytometer', 'Electron microscope', 'ImageStream', 'Mass spectrometer', 'PCR machine']) {
    await expect(page.locator('#instrument-type option', { hasText: seeded })).toHaveCount(1);
  }
  await page.click('button:has-text("+ Add a type")');
  await label('New type name').fill(typeName);
  await page.click('button:has-text("Add")');
  await expect(page.locator('#instrument-type option:checked')).toHaveText(typeName);

  // Manufacturer is required for a new instrument.
  await label('Name').fill(name);
  await label('Model').fill('E2E-Talos');
  await label('Serial number').fill(serial);
  await expect(page.locator('button:has-text("Create instrument")')).toBeDisabled();
  await label('Manufacturer').fill('E2E Optics');
  // Model is required too: blank it and the button goes disabled again.
  await label('Model').fill('   ');
  await expect(page.locator('button:has-text("Create instrument")')).toBeDisabled();
  await label('Model').fill('E2E-Talos');
  await page.click('button:has-text("Create instrument")');

  const row = page.locator('.instrument-row.template-row-body', { hasText: name });
  await expect(row).toContainText(typeName);

  // The type cannot be changed on an existing instrument.
  await row.locator('button:has-text("Edit")').click();
  await expect(page.locator('#instrument-type')).toBeDisabled();
  await page.click('button:has-text("Back to instruments")');

  const instruments = await (await request.get(`${API_BASE}/instruments`)).json();
  const created = instruments.find((i: { serial_number: string }) => i.serial_number === serial);
  try {
    // A report for it: the stub reads the serial from the file name, the type
    // has no template, so the flow stops at the manual pick and then says why.
    await page.click('.view-tab:has-text("New report")');
    await page.locator('input[type="file"]').setInputFiles({
      name: `service_${serial}.pdf`,
      mimeType: 'application/pdf',
      buffer: uniquePdf('%PDF-1.4 microscope'),
    });
    await page.click('button:has-text("Upload & classify")');
    await page.waitForSelector('.class-row', { timeout: TIMEOUT.flow });
    await page.click('button:has-text("Confirm & continue")');
    await expect(page.getByText(new RegExp(`There is no .* template for ${typeName} / E2E-Talos yet`))).toBeVisible({
      timeout: TIMEOUT.ui,
    });
  } finally {
    await request.delete(`${API_BASE}/instruments/${created.id}`);
  }
});

test('the Templates tab lets a template be created for another instrument type', async ({ page, request }) => {
  const stamp = Date.now();
  const typeName = `E2E Spectrometer ${stamp}`;
  await request.post(`${API_BASE}/instrument-types`, { data: { display_name: typeName } });
  const model = `E2E-Spec-${stamp}`;

  await page.goto('/');
  await page.click('.view-tab:has-text("Templates")');
  await page.click('button:has-text("+ New template")');
  await page.locator('#template-instrument-type').selectOption({ label: typeName });
  await page.locator('.schema-form-label', { hasText: 'Model' }).locator('input').fill(model);
  await page.click('button:has-text("+ Add field")');
  await page.locator('.schema-field-row').first().locator('[aria-label="Field name"]').fill('note');
  await page.click('button:has-text("Create template")');

  const row = page.locator('.template-row-body', { hasText: model });
  await expect(row).toContainText(typeName);
  await row.getByRole('button', { name: /More actions/ }).click();
  await row.getByRole('menuitem', { name: 'Delete' }).click();
  await row.locator('button:has-text("Confirm delete")').click();
  await expect(row).toHaveCount(0);
});
