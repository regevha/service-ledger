import { type APIRequestContext, type Page } from '@playwright/test';
import { test, expect } from './coverage';
import { uniqueFixture, uniquePdf } from './unique-upload';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIMEOUT } from './timeouts';
import { API_BASE } from './helpers/api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(__dirname, 'fixtures', 'sample-work-order.pdf');

// Suggesting a template of its own for a report that has none (phase 1 of the
// template-suggestion proposal): a report read with the generic template gets
// a notice, the Templates tab opens prefilled with the closest existing
// template as the starting point, and the waiting report is read again with
// the template once it is saved. Also the dead end (a type with no template at
// all) and the "Start from" picker on a plain "+ New template". Every model and
// type is unique to the run because the suite shares one database.

const textField = (name: string) => ({ name, type: 'text', unit: null, notes: null });

async function createInstrument(request: APIRequestContext, data: Record<string, string>) {
  const res = await request.post(`${API_BASE}/instruments`, { data: { manufacturer: 'E2E Maker', ...data } });
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string; model: string; serial_number: string };
}

async function createTemplate(request: APIRequestContext, data: Record<string, unknown>) {
  const res = await request.post(`${API_BASE}/report-templates`, { data });
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string };
}

// Reads the sample work order as this instrument's repair report, through the
// manual pick, and stops on the review screen (the generic repair template).
async function readSampleAs(page: Page, instrumentId: string) {
  await page.goto('/');
  await page.click('.view-tab:has-text("New report")');
  await page.locator('input[type="file"]').setInputFiles(uniqueFixture(SAMPLE));
  await page.click('button:has-text("Upload & classify")');
  await page.waitForSelector('.class-row', { timeout: TIMEOUT.flow });
  await page.locator('.class-row select').first().selectOption(instrumentId);
  await page.click('button:has-text("Confirm & continue")');
  await expect(page.locator('.field-list')).toBeVisible({ timeout: TIMEOUT.flow });
}

test('a report on the generic template offers a model-specific one, starts from the closest, and is read again', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const family = `E2E-Fam-${stamp}`;
  const model = `${family} Two`;
  const sibling = await createTemplate(request, {
    report_type: 'repair',
    model: `${family} One`,
    fields: [textField('family_note'), textField('fault_description')],
  });
  const instrument = await createInstrument(request, { name: `E2E-Fam-unit-${stamp}`, model, serial_number: `FAM-${stamp}` });
  let created: { id: string } | undefined;
  try {
    await readSampleAs(page, instrument.id);

    const notice = page.locator('#generic-template-notice');
    await expect(notice).toContainText(`generic Malfunction / repair template for ${model}`);
    await notice.locator(`button:has-text("Create a ${model} template")`).click();

    // The Templates tab, prefilled for this report and started from the
    // closest existing template (the sibling in the same family).
    await expect(page.locator('#template-request-notice')).toContainText(`Malfunction / repair report for ${model} is waiting`);
    await expect(page.locator('.schema-form-label', { hasText: 'Model' }).locator('input')).toHaveValue(model);
    await expect(page.locator('#template-start-from option:checked')).toContainText(`${family} One`);
    await expect(page.locator('#template-start-from option:checked')).toContainText(`${family} family`);
    await expect(page.locator('.schema-field-row')).toHaveCount(2);
    await expect(page.locator('[aria-label="Field name"]').first()).toHaveValue('family_note');

    // Edit the copy, then save it.
    await page.click('button:has-text("+ Add field")');
    await page.locator('[aria-label="Field name"]').nth(2).fill('extra_check');
    await page.click('button:has-text("Create template")');

    // Back on the waiting report, which is read again with the new template.
    await expect(page.locator('.field', { hasText: 'extra check' })).toBeVisible({ timeout: TIMEOUT.flow });
    await expect(page.locator('.field', { hasText: 'family note' })).toBeVisible();
    await expect(page.locator('#generic-template-notice')).toHaveCount(0);

    const reports = await (await request.get(`${API_BASE}/reports?instrument_id=${instrument.id}`)).json();
    expect(reports).toHaveLength(1);
    const report = await (await request.get(`${API_BASE}/reports/${reports[0].id}`)).json();
    const template = await (await request.get(`${API_BASE}/report-templates/${report.template_id}`)).json();
    expect(template.model).toBe(model);
    created = template;
  } finally {
    await request.delete(`${API_BASE}/instruments/${instrument.id}`);
    if (created) await request.delete(`${API_BASE}/report-templates/${created.id}`);
    await request.delete(`${API_BASE}/report-templates/${sibling.id}`);
  }
});

test('"Not now" hides the notice, and cancelling the request returns to the report unchanged', async ({ page, request }) => {
  const stamp = Date.now();
  const model = `E2E-Cancel-${stamp}`;
  const instrument = await createInstrument(request, { name: `E2E-Cancel-unit-${stamp}`, model, serial_number: `CAN-${stamp}` });
  try {
    await readSampleAs(page, instrument.id);
    await page.locator('#generic-template-notice button:has-text("Not now")').click();
    await expect(page.locator('#generic-template-notice')).toHaveCount(0);
  } finally {
    await request.delete(`${API_BASE}/instruments/${instrument.id}`);
  }

  const other = await createInstrument(request, {
    name: `E2E-Cancel2-unit-${stamp}`,
    model: `${model}-b`,
    serial_number: `CAN2-${stamp}`,
  });
  try {
    await readSampleAs(page, other.id);
    await page.locator('#generic-template-notice button:has-text("Create a")').click();
    await expect(page.locator('#template-request-notice')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    // Straight back to the waiting report, still on the generic template.
    await expect(page.locator('#generic-template-notice')).toBeVisible();
    await expect(page.locator('.field-list')).toBeVisible();
    // The Templates tab no longer shows the request.
    await page.click('.view-tab:has-text("Templates")');
    await expect(page.locator('#template-request-notice')).toHaveCount(0);
    await expect(page.locator('.template-table')).toBeVisible();
  } finally {
    await request.delete(`${API_BASE}/instruments/${other.id}`);
  }
});

test('a saved template for another model leaves the report as it was and says so', async ({ page, request }) => {
  const stamp = Date.now();
  const model = `E2E-Elsewhere-${stamp}`;
  const elsewhere = `E2E-Elsewhere-other-${stamp}`;
  const instrument = await createInstrument(request, { name: `E2E-Elsewhere-unit-${stamp}`, model, serial_number: `ELS-${stamp}` });
  let created: { id: string } | undefined;
  try {
    await readSampleAs(page, instrument.id);
    await page.locator('#generic-template-notice button:has-text("Create a")').click();
    await page.locator('.schema-form-label', { hasText: 'Model' }).locator('input').fill(elsewhere);
    await page.click('button:has-text("+ Add field")');
    await page.locator('[aria-label="Field name"]').last().fill('elsewhere_note');
    await page.click('button:has-text("Create template")');

    await expect(page.locator('#template-note')).toContainText(`${elsewhere} / Malfunction / repair`);
    await expect(page.locator('#template-note')).toContainText(`this ${model} report still uses the template it already had`);
    await expect(page.locator('.field', { hasText: 'elsewhere note' })).toHaveCount(0);

    const templates = await (await request.get(`${API_BASE}/report-templates/all`)).json();
    created = templates.find((t: { model: string | null }) => t.model === elsewhere);
    expect(created).toBeTruthy();
  } finally {
    await request.delete(`${API_BASE}/instruments/${instrument.id}`);
    if (created) await request.delete(`${API_BASE}/report-templates/${created.id}`);
  }
});

test('a type with no template at all offers to create one and then reads the report with it', async ({ page, request }) => {
  const stamp = Date.now();
  const typeName = `E2E Dead End ${stamp}`;
  const type = await (await request.post(`${API_BASE}/instrument-types`, { data: { display_name: typeName } })).json();
  const model = `E2E-DeadEnd-${stamp}`;
  const serial = `DE-${stamp}`;
  const instrument = await createInstrument(request, {
    name: `E2E-DeadEnd-unit-${stamp}`,
    instrument_type: type.key,
    model,
    serial_number: serial,
  });
  try {
    await page.goto('/');
    await page.click('.view-tab:has-text("New report")');
    await page.locator('input[type="file"]').setInputFiles({
      name: `service_${serial}.pdf`,
      mimeType: 'application/pdf',
      buffer: uniquePdf('%PDF-1.4 dead end'),
    });
    await page.click('button:has-text("Upload & classify")');
    await page.waitForSelector('.class-row', { timeout: TIMEOUT.flow });
    await page.click('button:has-text("Confirm & continue")');

    await expect(page.getByText(new RegExp(`There is no .* template for ${typeName} / ${model} yet`))).toBeVisible({ timeout: TIMEOUT.ui });
    await page.locator('#create-template-action').click();

    // Prefilled with this type; no template of this type exists, so there is
    // nothing to start from but a blank form.
    await expect(page.locator('#template-request-notice')).toContainText(model);
    await expect(page.locator('#template-instrument-type option:checked')).toHaveText(typeName);
    await expect(page.locator('#template-start-from option')).toHaveCount(1);
    await page.click('button:has-text("+ Add field")');
    await page.locator('[aria-label="Field name"]').first().fill('dead_end_note');
    await page.click('button:has-text("Create template")');

    await expect(page.locator('.field', { hasText: 'dead end note' })).toBeVisible({ timeout: TIMEOUT.flow });
  } finally {
    await request.delete(`${API_BASE}/instruments/${instrument.id}`);
    const templates = await (await request.get(`${API_BASE}/report-templates/all`)).json();
    for (const t of templates.filter((x: { instrument_type: string }) => x.instrument_type === type.key)) {
      await request.delete(`${API_BASE}/report-templates/${t.id}`);
    }
  }
});

test('"+ New template" lists the closest templates for the typed model and asks before replacing edited fields', async ({ page }) => {
  await page.goto('/');
  await page.click('.view-tab:has-text("Templates")');
  await page.click('button:has-text("+ New template")');

  // Blank until one is picked; the seeded CytoFLEX S repair template is the
  // closest to another CytoFLEX.
  await expect(page.locator('#template-start-from')).toHaveValue('');
  await page.locator('.schema-form-label', { hasText: 'Model' }).locator('input').fill('CytoFLEX LX');
  const closest = page.locator('#template-start-from option', { hasText: 'CytoFLEX family' });
  await expect(closest).toHaveCount(1, { timeout: 10_000 });
  await expect(closest).toContainText('CytoFLEX S');
  await page.locator('#template-start-from').selectOption({ label: await closest.innerText() });
  const copied = await page.locator('.schema-field-row').count();
  expect(copied).toBeGreaterThan(1);

  // Edit, then choose Blank: the person is asked before their edits go.
  await page.click('button:has-text("+ Add field")');
  await page.locator('#template-start-from').selectOption({ label: 'Blank (no starting template)' });
  const dialog = page.locator('[role="alertdialog"]', { hasText: 'replaces the fields below' });
  await expect(dialog).toBeVisible();
  await dialog.locator('button:has-text("Keep my fields")').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.schema-field-row')).toHaveCount(copied + 1);

  await page.locator('#template-start-from').selectOption({ label: 'Blank (no starting template)' });
  await page.locator('[role="alertdialog"] button:has-text("Replace fields")').click();
  await expect(page.locator('.schema-field-row')).toHaveCount(0);

  // Nothing was saved.
  await page.click('button:has-text("Cancel")');
  await expect(page.locator('.template-table')).toBeVisible();
});
