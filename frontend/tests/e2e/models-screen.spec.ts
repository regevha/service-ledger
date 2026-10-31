import { test, expect } from './coverage';
import { API_BASE } from './helpers/api';

// Instrument models as records of their own (models plan, step 2): a Models list under the
// Instruments tab, a model suggestion on the instrument form, rename / merge / delete that say
// exactly what they change.

async function makeUnit(request: import('@playwright/test').APIRequestContext, model: string, tag: string, manufacturer = 'E2E Maker') {
  const r = await request.post(`${API_BASE}/instruments`, {
    data: { name: `E2E ${tag}`, model, manufacturer, serial_number: `E2E-MS-${tag}-${Date.now()}` },
  });
  expect(r.ok()).toBeTruthy();
  return r.json();
}

async function openModels(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.click('.view-tab:has-text("Instruments")');
  await page.click('.sub-switch button:has-text("Models")');
  await expect(page.locator('#models-section')).toBeVisible();
}

// The row whose model name is exactly this.
const modelRow = (page: import('@playwright/test').Page, name: string) =>
  page.locator('.model-row.template-row-body', {
    has: page.locator('.model-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}$`) }),
  });

test('the instrument form says whether the model is new or existing and fills in its manufacturer', async ({ page, request }) => {
  const model = `E2E-Form-${Date.now()}`;
  await makeUnit(request, model, 'form', 'Acme Corp');
  await page.goto('/');
  await page.click('.view-tab:has-text("Instruments")');
  await page.click('button:has-text("+ New instrument")');
  const modelInput = page.locator('.schema-form-label', { hasText: 'Model' }).locator('input');
  await modelInput.fill(model);
  await expect(page.locator('#model-hint')).toHaveText('Existing model · 1 instrument');
  await expect(page.locator('.schema-form-label', { hasText: 'Manufacturer' }).locator('input')).toHaveValue('Acme Corp');
  await modelInput.fill(`${model}-new`);
  await expect(page.locator('#model-hint')).toContainText('New model');
});

test('a new instrument with a new model adds it to the Models list', async ({ page }) => {
  const model = `E2E-Added-${Date.now()}`;
  await page.goto('/');
  await page.click('.view-tab:has-text("Instruments")');
  await page.click('button:has-text("+ New instrument")');
  await page.locator('.schema-form-label', { hasText: /^\s*Name/ }).locator('input').fill(`E2E ${model}`);
  await page.locator('.schema-form-label', { hasText: 'Model' }).locator('input').fill(model);
  await page.locator('.schema-form-label', { hasText: 'Manufacturer' }).locator('input').fill('Acme Corp');
  await page.locator('.schema-form-label', { hasText: 'Serial number' }).locator('input').fill(`E2E-ADD-${Date.now()}`);
  await page.click('button:has-text("Create instrument")');
  await page.click('.sub-switch button:has-text("Models")');
  const row = modelRow(page, model);
  await expect(row.locator('[data-label="Instruments"]')).toHaveText('1');
  await expect(row.locator('[data-label="Manufacturer"]')).toHaveText('Acme Corp');
});

test('renaming a model warns what changes, then renames its instruments and templates', async ({ page, request }) => {
  const model = `E2E-Ren-${Date.now()}`;
  const unit = await makeUnit(request, model, 'ren');
  const t = await request.post(`${API_BASE}/report-templates`, {
    data: { instrument_type: 'flow_cytometer', report_type: 'repair', model, fields: [{ name: 'summary', type: 'text' }] },
  });
  expect(t.ok()).toBeTruthy();

  await openModels(page);
  await modelRow(page, model).locator('button:has-text("Edit")').click();
  const name = page.locator('.schema-form-label', { hasText: 'Name' }).locator('input');
  await name.fill(`${model}-II`);
  await expect(page.locator('#model-rename-warning')).toContainText('1 instrument and the model of 1 template');
  await page.locator('.schema-form-label', { hasText: 'Service interval' }).locator('input').fill('6');
  await page.click('button:has-text("Save changes")');
  const row = modelRow(page, `${model}-II`);
  await expect(row.locator('[data-label="Service interval"]')).toHaveText('6 months');
  const after = await (await request.get(`${API_BASE}/instruments/${unit.id}`)).json();
  expect(after.model).toBe(`${model}-II`);
});

test('look-alike models are flagged and merging says exactly what moves', async ({ page, request }) => {
  const stamp = Date.now();
  const keep = `E2E Sorter ${stamp}`;
  const dupe = `E2ESorter${stamp}`;
  await makeUnit(request, keep, 'keep');
  const moved = await makeUnit(request, dupe, 'moved');

  await openModels(page);
  await expect(modelRow(page, dupe).locator('.model-similar')).toContainText(`“${keep}”`);

  await modelRow(page, dupe).locator('.row-menu-button').click();
  await page.click('[role="menuitem"]:has-text("Merge into")');
  const dialog = page.locator('[role="alertdialog"][aria-label="Merge model"]');
  await dialog.locator('select').selectOption({ label: keep });
  await expect(dialog).toContainText(`1 instrument and 0 templates written for “${dupe}” move to “${keep}”`);
  await expect(dialog).toContainText('This cannot be undone');
  await dialog.locator('button:has-text("Confirm merge")').click();

  await expect(modelRow(page, dupe)).toHaveCount(0);
  await expect(modelRow(page, keep).locator('[data-label="Instruments"]')).toHaveText('2');
  const after = await (await request.get(`${API_BASE}/instruments/${moved.id}`)).json();
  expect(after.model).toBe(keep);
});

test('delete is blocked while a model has instruments and says what it deletes when it has none', async ({ page, request }) => {
  const used = `E2E-Used-${Date.now()}`;
  const empty = `E2E-Empty-${Date.now()}`;
  await makeUnit(request, used, 'used');
  expect((await request.post(`${API_BASE}/instrument-models`, { data: { name: empty } })).ok()).toBeTruthy();

  await openModels(page);
  await modelRow(page, used).locator('.row-menu-button').click();
  await expect(page.locator('[role="menuitem"]:has-text("Delete")')).toBeDisabled();
  await page.keyboard.press('Escape');

  await modelRow(page, empty).locator('.row-menu-button').click();
  await page.click('[role="menuitem"]:has-text("Delete")');
  const dialog = page.locator('[role="alertdialog"][aria-label="Confirm delete model"]');
  await expect(dialog).toContainText(`Delete the model “${empty}”? This deletes only the model record; it has no instruments.`);
  await dialog.locator('button:has-text("Confirm delete")').click();
  await expect(modelRow(page, empty)).toHaveCount(0);
});

test('phone: Models list is reachable, shows captions and the switch is full width', async ({ page, request }) => {
  const model = `E2E-Phone-${Date.now()}`;
  await makeUnit(request, model, 'phone');
  await page.setViewportSize({ width: 390, height: 844 });
  await openModels(page);
  const row = modelRow(page, model);
  await expect(row).toBeVisible();
  await expect(row.locator('[data-label="Instruments"]')).toHaveText('1');
  const box = await page.locator('.sub-switch').boundingBox();
  expect(box!.width).toBeGreaterThan(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
