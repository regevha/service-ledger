import { type APIRequestContext, type Page } from '@playwright/test';
import { test, expect } from './coverage';
import { createNumericTemplate } from './numeric-fixture';
import { API_BASE, seedReport } from './helpers/api';

// Models plan step 3: a model's page shows its instruments side by side (last service date, report
// counts) and its newest reports, with links to the instrument and the report.

async function makeUnit(request: APIRequestContext, model: string, tag: string) {
  const r = await request.post(`${API_BASE}/instruments`, {
    data: { name: `E2E ${tag} ${model}`, model, manufacturer: 'E2E Maker', serial_number: `SN-${tag}-${model}` },
  });
  expect(r.ok()).toBeTruthy();
  return r.json();
}

async function openModelPage(page: Page, model: string) {
  await page.goto('/');
  await page.click('.view-tab:has-text("Instruments")');
  await page.click('.sub-switch button:has-text("Models")');
  await page.locator('.model-name', { hasText: new RegExp(`^${model}$`) }).click();
  await expect(page.locator('#model-page')).toBeVisible();
}

async function finalizedReport(request: APIRequestContext, model: string, instrumentId: string, day: string) {
  const { reportId } = await seedReport(request, {
    instrumentId,
    model,
    reportType: 'installation_upgrade',
    technician: 'Dana Levi',
    fields: { cst_beads_lot: 'LOT-1' },
    reportDate: day,
    finalize: true,
  });
  return reportId;
}

test('the model page lists its instruments with last service and its reports, with links', async ({ page, request }) => {
  const model = `E2E-MPage-${Date.now()}`;
  await createNumericTemplate(request, model);
  const serviced = await makeUnit(request, model, 'a');
  await makeUnit(request, model, 'b');
  const reportId = await finalizedReport(request, model, serviced.id, '2026-05-09');

  await openModelPage(page, model);
  await expect(page.locator('#model-facts')).toContainText('E2E Maker · Flow cytometer · 2 instruments · no service interval set');

  const a = page.locator('.model-unit-row.template-row-body', { hasText: `E2E a ${model}` });
  await expect(a.locator('[data-label="Last service"]')).toContainText('2026');
  await expect(a.locator('[data-label="Last service"]')).toContainText('May');
  await expect(a.locator('[data-label="Reports"]')).toHaveText('1');
  const b = page.locator('.model-unit-row.template-row-body', { hasText: `E2E b ${model}` });
  await expect(b.locator('[data-label="Last service"]')).toHaveText('None yet');
  await expect(b.locator('[data-label="Reports"]')).toHaveText('0');

  const row = page.locator('.model-report-row.template-row-body');
  await expect(row).toHaveCount(1);
  await expect(row.locator('[data-label="Technician"]')).toHaveText('Dana Levi');
  await row.locator('.model-report-link').click();
  await expect(page).toHaveURL(new RegExp(`#/reports/${reportId}$`));
});

test('a unit name opens that instrument, and a model with no instruments says so', async ({ page, request }) => {
  const model = `E2E-MPage2-${Date.now()}`;
  const unit = await makeUnit(request, model, 'a');
  await openModelPage(page, model);
  await page.locator('.model-unit-link').click();
  await expect(page).toHaveURL(new RegExp(`#/reports/instrument/${unit.id}$`));

  const empty = `E2E-MEmpty-${Date.now()}`;
  expect((await request.post(`${API_BASE}/instrument-models`, { data: { name: empty } })).ok()).toBeTruthy();
  await openModelPage(page, empty);
  await expect(page.getByText('No instruments of this model.')).toBeVisible();
  await expect(page.getByText('No reports for this model yet.')).toBeVisible();
  await page.click('button:has-text("← Back to models")');
  await expect(page.locator('#models-section')).toBeVisible();
});

test('Edit on the model page opens the edit form', async ({ page, request }) => {
  const model = `E2E-MPage3-${Date.now()}`;
  await makeUnit(request, model, 'a');
  await openModelPage(page, model);
  await page.click('#model-page button:has-text("Edit")');
  await expect(page.locator('.section-title', { hasText: 'Edit model' })).toBeVisible();
});

test('phone: the model page has no sideways scroll and keeps captions', async ({ page, request }) => {
  const model = `E2E-MPage4-${Date.now()}`;
  await makeUnit(request, model, 'a');
  await page.setViewportSize({ width: 390, height: 844 });
  await openModelPage(page, model);
  const unit = page.locator('.model-unit-row.template-row-body').first();
  await expect(unit.locator('[data-label="Last service"]')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
