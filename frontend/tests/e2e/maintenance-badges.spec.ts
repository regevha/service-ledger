import { type APIRequestContext } from '@playwright/test';
import { test, expect } from './coverage';
import { API_BASE, seedReport } from './helpers/api';

// Models plan step 4, part A: each instrument shows whether its maintenance is
// overdue (model's service interval + newest finalized preventive-maintenance
// report), in the list, on its page and on the model page; the list filters by
// state; and the manufacturer follows the model.

async function setup(request: APIRequestContext, model: string) {
  const unit = await (
    await request.post(`${API_BASE}/instruments`, {
      data: { name: `E2E Maint ${model}`, model, manufacturer: 'E2E Maker', serial_number: `SN-${model}` },
    })
  ).json();
  const record = (await (await request.get(`${API_BASE}/instrument-models`)).json()).find((m: { name: string }) => m.name === model);
  expect((await request.patch(`${API_BASE}/instrument-models/${record.id}`, { data: { service_interval_months: 6 } })).ok()).toBeTruthy();
  return { unit, record };
}

async function maintenanceReport(request: APIRequestContext, model: string, instrumentId: string, day: string) {
  const template = await (
    await request.post(`${API_BASE}/report-templates`, {
      data: { instrument_type: 'facs', report_type: 'preventive_maintenance', model, fields: [{ name: 'summary', type: 'text' }] },
    })
  ).json();
  await seedReport(request, {
    instrumentId,
    model,
    reportType: 'preventive_maintenance',
    templateId: template.id,
    technician: 'Dana Levi',
    fields: { summary: 'Yearly service' },
    reportDate: day,
    finalize: true,
  });
}

test('overdue shows on the list, the instrument page and the model page; the filter finds it', async ({ page, request }) => {
  const model = `E2E-Maint-${Date.now()}`;
  const { unit, record } = await setup(request, model);
  await maintenanceReport(request, model, unit.id, '2025-01-10');

  await page.goto('/');
  await page.click('.view-tab:has-text("Instruments")');
  const row = page.locator('.instrument-row.template-row-body', { hasText: `E2E Maint ${model}` });
  await expect(row.locator('.maintenance-overdue')).toContainText('Overdue');

  await page.getByLabel('Filter by maintenance').selectOption('overdue');
  await expect(row).toBeVisible();
  await page.getByLabel('Filter by maintenance').selectOption('ok');
  await expect(row).toHaveCount(0);
  await page.getByLabel('Filter by maintenance').selectOption('all');

  await page.click('.sub-switch button:has-text("Models")');
  await page.locator('.model-name', { hasText: new RegExp(`^${model}$`) }).click();
  const unitRow = page.locator('.model-unit-row.template-row-body', { hasText: `E2E Maint ${model}` });
  await expect(unitRow.locator('.maintenance-overdue')).toBeVisible();

  await page.goto(`/#/reports/instrument/${unit.id}`);
  await expect(page.locator('.instrument-header .maintenance-overdue')).toBeVisible();
  expect(record.id).toBeTruthy();
});

test('a unit without maintenance reports says so, and the manufacturer follows the model', async ({ page, request }) => {
  const model = `E2E-MaintB-${Date.now()}`;
  const { unit } = await setup(request, model);

  await page.goto('/');
  await page.click('.view-tab:has-text("Instruments")');
  const row = page.locator('.instrument-row.template-row-body', { hasText: `E2E Maint ${model}` });
  await expect(row.locator('.maintenance-no_record')).toContainText('No maintenance on record');

  await row.getByRole('button', { name: 'Edit' }).click();
  const manufacturer = page.getByPlaceholder('e.g. BD');
  await expect(manufacturer).toBeDisabled();
  await expect(manufacturer).toHaveValue('E2E Maker');
  await expect(page.getByText('Set by the model')).toBeVisible();
  expect(unit.id).toBeTruthy();
});
