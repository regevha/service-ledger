import { type APIRequestContext, type Page } from '@playwright/test';
import { test, expect } from './coverage';
import { API_BASE } from './helpers/api';

// The Templates tab's safeguards and conveniences: the form says what is wrong
// before you save, a template can be duplicated as a starting point, and a
// template that reports use shows how many, warns before fields are dropped
// and cannot be deleted. Also exercises the field/column editing controls
// (reorder, remove, change type, rename) and the screen's error paths. Every
// template here has a unique model, as the suite shares one database.

const textField = (name: string) => ({ name, type: 'text', unit: null, notes: null });

async function createTemplate(request: APIRequestContext, model: string, fields = [textField('fault_description'), textField('extra_notes')]) {
  const res = await request.post(`${API_BASE}/report-templates`, { data: { report_type: 'repair', model, fields } });
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string };
}

// Attaches a (draft) report to the template; returns the report id.
async function useTemplate(request: APIRequestContext, templateId: string) {
  const instrument = (await (await request.get(`${API_BASE}/instruments`)).json())[0];
  const report = await (await request.post(`${API_BASE}/reports`, { data: { technician_name: 'E2E template user' } })).json();
  const res = await request.patch(`${API_BASE}/reports/${report.id}/template`, {
    data: { instrument_id: instrument.id, template_id: templateId },
  });
  expect(res.status()).toBe(200);
  return report.id as string;
}

async function openTemplates(page: Page) {
  await page.goto('/');
  await page.click('.view-tab:has-text("Templates")');
  await page.waitForSelector('.template-table, .empty-hint');
}

const rowFor = (page: Page, model: string) => page.locator('.template-row-body', { hasText: model });

test.describe('the form says what is wrong', () => {
  test('each problem is listed, and Save unlocks once they are fixed', async ({ page }) => {
    await openTemplates(page);
    await page.click('button:has-text("+ New template")');
    const create = page.locator('button:has-text("Create template")');
    const problems = page.locator('#template-problems');

    await expect(problems).toContainText('Add at least one field.');
    await expect(create).toBeDisabled();

    await page.click('button:has-text("+ Add field")');
    await expect(problems).toContainText('Every field needs a name.');

    await page.locator('[aria-label="Field name"]').nth(0).fill('Fault');
    await page.click('button:has-text("+ Add field")');
    await page.locator('[aria-label="Field name"]').nth(1).fill('fault ');
    await expect(problems).toContainText('Field names must be unique: fault appears more than once.');

    await page.locator('[aria-label="Field name"]').nth(1).fill('category');
    await page.locator('[aria-label="Field type"]').nth(1).selectOption('enum');
    await expect(problems).toContainText('category needs at least one option.');
    await page.locator('[aria-label="Field type"]').nth(1).selectOption('object[]');
    await expect(problems).toContainText('category needs at least one column.');

    await page.locator('[aria-label="Field type"]').nth(1).selectOption('text');
    await expect(problems).toHaveCount(0);
    await expect(create).toBeEnabled();
  });

  test('model suggestions come from the fleet', async ({ page }) => {
    await openTemplates(page);
    await page.click('button:has-text("+ New template")');
    await expect(page.locator('#known-models option[value="LSRFortessa"]')).toHaveCount(1);
  });
});

test.describe('duplicating a template', () => {
  test('starts a new template from the fields of an existing one', async ({ page, request }) => {
    const source = `E2E-Source-${Date.now()}`;
    const copy = `E2E-Copy-${Date.now()}`;
    await createTemplate(request, source);
    await openTemplates(page);

    await rowFor(page, source).getByRole('button', { name: /More actions/ }).click();
    await rowFor(page, source).getByRole('menuitem', { name: 'Duplicate' }).click();
    await expect(page.locator('.section-title').first()).toContainText('New template');
    await expect(page.locator('#copy-notice')).toContainText('choose a different model');
    await expect(page.locator('.schema-field-row')).toHaveCount(2);
    await expect(page.locator('[aria-label="Field name"]').nth(0)).toHaveValue('fault_description');
    await expect(page.locator('.schema-form-label', { hasText: 'Model' }).locator('input')).toHaveValue('');

    // Saving under the source's own model is refused, with the reason.
    await page.locator('.schema-form-label', { hasText: 'Model' }).locator('input').fill(source);
    await page.click('button:has-text("Create template")');
    await expect(page.locator('.banner-crit')).toContainText('already exists');

    await page.locator('.schema-form-label', { hasText: 'Model' }).locator('input').fill(copy);
    await page.locator('[aria-label="Field name"]').nth(1).fill('renamed_in_copy');
    await page.click('button:has-text("Create template")');

    await expect(rowFor(page, copy).locator('span').nth(2)).toHaveText('2');
    // The source is untouched.
    await rowFor(page, source).locator('button:has-text("Edit")').click();
    await expect(page.locator('[aria-label="Field name"]').nth(1)).toHaveValue('extra_notes');
  });
});

test.describe('a template that reports use', () => {
  test('shows its usage, warns before fields are dropped, and cannot be deleted', async ({ page, request }) => {
    const model = `E2E-InUse-${Date.now()}`;
    const template = await createTemplate(request, model);
    const reportId = await useTemplate(request, template.id);
    try {
      await openTemplates(page);
      const row = rowFor(page, model);
      await expect(row.locator('.template-usage')).toHaveText('1 (0 finalized)');
      await row.getByRole('button', { name: /More actions/ }).click();
      await expect(row.getByRole('menuitem', { name: 'Delete' })).toBeDisabled();
      await expect(row.getByRole('menuitem', { name: 'Delete' })).toHaveAttribute('title', /1 report\(s\) use this template/);
      await page.keyboard.press('Escape');

      await row.locator('button:has-text("Edit")').click();
      await expect(page.locator('#template-in-use-notice')).toContainText('1 report uses this template (0 finalized)');

      // Removing a field in use asks first; "Keep editing" saves nothing.
      await page.locator('.schema-field-row').nth(1).locator('button:has-text("Remove")').click();
      await page.click('button:has-text("Save changes")');
      const dialog = page.getByRole('alertdialog', { name: 'Confirm removing fields' });
      await expect(dialog).toContainText('extra_notes is no longer in this template');
      await dialog.locator('button:has-text("Keep editing")').click();
      await expect(dialog).toHaveCount(0);
      const stillTwo = await (await request.get(`${API_BASE}/report-templates/${template.id}`)).json();
      expect(stillTwo.field_schema.fields).toHaveLength(2);

      await page.click('button:has-text("Save changes")');
      await page.getByRole('alertdialog').locator('button:has-text("Save anyway")').click();
      await expect(rowFor(page, model).locator('span').nth(2)).toHaveText('1');
      const afterwards = await (await request.get(`${API_BASE}/report-templates/${template.id}`)).json();
      expect(afterwards.field_schema.fields.map((f: { name: string }) => f.name)).toEqual(['fault_description']);

      // Adding a field needs no confirmation, even though reports use it.
      await rowFor(page, model).locator('button:has-text("Edit")').click();
      await page.click('button:has-text("+ Add field")');
      await page.locator('[aria-label="Field name"]').nth(1).fill('added_later');
      await page.click('button:has-text("Save changes")');
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await expect(rowFor(page, model).locator('span').nth(2)).toHaveText('2');
    } finally {
      await request.delete(`${API_BASE}/reports/${reportId}`);
      await request.delete(`${API_BASE}/report-templates/${template.id}`);
    }
  });

  test('a template nobody uses can be edited without a warning and deleted', async ({ page, request }) => {
    const model = `E2E-Unused-${Date.now()}`;
    await createTemplate(request, model);
    await openTemplates(page);
    const row = rowFor(page, model);
    await expect(row.locator('.template-usage')).toHaveText('0');

    await row.locator('button:has-text("Edit")').click();
    await expect(page.locator('#template-in-use-notice')).toHaveCount(0);
    await page.locator('.schema-field-row').nth(1).locator('button:has-text("Remove")').click();
    await page.click('button:has-text("Save changes")');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);

    await rowFor(page, model).getByRole('button', { name: /More actions/ }).click();
    await rowFor(page, model).getByRole('menuitem', { name: 'Delete' }).click();
    await rowFor(page, model).locator('button:has-text("Confirm delete")').click();
    await expect(rowFor(page, model)).toHaveCount(0);
  });

  test('a delete that loses a race with a report using the template shows the reason', async ({ page, request }) => {
    const model = `E2E-Race-${Date.now()}`;
    const template = await createTemplate(request, model);
    await openTemplates(page);
    const row = rowFor(page, model);
    await row.getByRole('button', { name: /More actions/ }).click();
    await row.getByRole('menuitem', { name: 'Delete' }).click(); // enabled: nothing used it when the list loaded

    const reportId = await useTemplate(request, template.id); // …until now
    try {
      await rowFor(page, model).locator('button:has-text("Confirm delete")').click();
      await expect(page.locator('.banner-warn')).toContainText('report(s) reference this template');
      await expect(rowFor(page, model)).toBeVisible();
    } finally {
      await request.delete(`${API_BASE}/reports/${reportId}`);
      await request.delete(`${API_BASE}/report-templates/${template.id}`);
    }
  });
});

test.describe('editing fields and columns', () => {
  test('reorder, remove, change type and the table-column controls', async ({ page }) => {
    await openTemplates(page);
    await page.click('button:has-text("+ New template")');
    await page.locator('.schema-form-label', { hasText: 'Model' }).locator('input').fill(`E2E-Edit-${Date.now()}`);

    for (const name of ['first', 'second', 'third']) {
      await page.click('button:has-text("+ Add field")');
      await page.locator('[aria-label="Field name"]').last().fill(name);
    }
    const names = () => page.locator('[aria-label="Field name"]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    expect(await names()).toEqual(['first', 'second', 'third']);

    // The first row cannot move up, the last cannot move down.
    await expect(page.locator('[aria-label="Move field up"]').first()).toBeDisabled();
    await expect(page.locator('[aria-label="Move field down"]').last()).toBeDisabled();
    await page.locator('[aria-label="Move field down"]').nth(0).click();
    expect(await names()).toEqual(['second', 'first', 'third']);
    await page.locator('[aria-label="Move field up"]').nth(2).click();
    expect(await names()).toEqual(['second', 'third', 'first']);

    await page.locator('.schema-field-row').nth(1).locator('button:has-text("Remove")').click();
    expect(await names()).toEqual(['second', 'first']);

    // Changing the type keeps the name, and a choice field gets an options input.
    const row = page.locator('.schema-field-row').nth(0);
    await row.locator('[aria-label="Field type"]').selectOption('enum');
    await expect(row.locator('.tag-input')).toBeVisible();
    await expect(row.locator('[aria-label="Field name"]')).toHaveValue('second');
    await row.locator('[aria-label="Field type"]').selectOption('object[]');
    await expect(row.locator('.tag-input')).toHaveCount(0);

    // Table columns: add, rename (blank and colliding names are refused), retype, remove.
    await row.locator('button:has-text("+ Add column")').click();
    await row.locator('button:has-text("+ Add column")').click();
    const column = (i: number) => row.locator('.item-schema-row').nth(i);
    await expect(column(0).locator('[aria-label="Column name"]')).toHaveValue('column_1');
    await expect(column(1).locator('[aria-label="Column name"]')).toHaveValue('column_2');

    await column(1).locator('[aria-label="Column name"]').fill('column_1'); // collides
    await column(1).locator('[aria-label="Column name"]').blur();
    await expect(column(1).locator('[aria-label="Column name"]')).toHaveValue('column_2');
    await column(1).locator('[aria-label="Column name"]').fill('   '); // blank
    await column(1).locator('[aria-label="Column name"]').blur();
    await expect(column(1).locator('[aria-label="Column name"]')).toHaveValue('column_2');
    await column(1).locator('[aria-label="Column name"]').fill('qty');
    await column(1).locator('[aria-label="Column name"]').blur();
    await expect(column(1).locator('[aria-label="Column name"]')).toHaveValue('qty');

    await column(1).locator('[aria-label="Column type"]').selectOption('number');
    await expect(column(1).locator('[aria-label="Column type"]')).toHaveValue('number');
    await column(0).locator('button:has-text("Remove")').click();
    await expect(row.locator('.item-schema-row')).toHaveCount(1);
    await expect(column(0).locator('[aria-label="Column name"]')).toHaveValue('qty');
  });
});

test.describe('when the backend is unhappy', () => {
  test('the list still works without usage counts', async ({ page }) => {
    await page.route('**/report-templates/usage', (route) => route.fulfill({ status: 500, body: 'boom' }));
    await openTemplates(page);
    await expect(page.locator('.template-row-body').first()).toBeVisible();
    await expect(page.locator('.template-usage').first()).toHaveText('0');
  });

  test('a list that cannot be loaded says so', async ({ page }) => {
    await page.route('**/report-templates/all', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"Database is down"}' }));
    await page.goto('/');
    await page.click('.view-tab:has-text("Templates")');
    await expect(page.locator('.banner-warn')).toContainText('Database is down');
  });
});
