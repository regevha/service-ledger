import { test, expect } from './coverage';

// The Templates tab (TemplateManager.tsx) is the structured field editor
// that replaces "edit seed_templates.py's Python literals and re-run the
// script" as the only way to change a report_templates row — this drives
// the full create -> edit -> delete cycle through the real UI, including
// the two conditional per-type controls (an enum field's options tag-input,
// an object[] field's item_schema column builder), which nothing else in
// this suite touches.
//
// This suite has no per-test truncation, so every template this test
// creates uses a unique model name (never a real seeded model) to avoid
// colliding with report_templates rows other specs — or a previous run of
// this same spec — may have left behind.

test('create, edit, and delete a report template through the structured field editor', async ({ page }) => {
  const uniqueModel = `E2E-Model-${Date.now()}`;

  await page.goto('/');
  await page.click('.view-tab:has-text("Templates")');
  await expect(page.locator('.section-title')).toContainText('Report templates');

  // ---- Create ----
  await page.click('button:has-text("+ New template")');
  await expect(page.locator('.section-title').first()).toContainText('New template');

  await page.locator('.schema-form-label', { hasText: 'Model' }).locator('input').fill(uniqueModel);

  // Field 1: a plain text field (the default type for a freshly-added row).
  await page.click('button:has-text("+ Add field")');
  const row1 = page.locator('.schema-field-row').nth(0);
  await row1.locator('[aria-label="Field name"]').fill('fault_description');

  // Field 2: an enum field — exercises the conditional options tag-input.
  await page.click('button:has-text("+ Add field")');
  const row2 = page.locator('.schema-field-row').nth(1);
  await row2.locator('[aria-label="Field name"]').fill('fault_category');
  await row2.locator('[aria-label="Field type"]').selectOption('enum');
  const optionsInput = row2.locator('.tag-input input[type="text"]');
  await optionsInput.fill('fluidics');
  await optionsInput.press('Enter');
  await optionsInput.fill('optics');
  await optionsInput.press('Enter');
  await expect(row2.locator('.tag-chip')).toHaveCount(2);

  await page.click('button:has-text("Create template")');

  // ---- Verify it landed in the list ----
  await expect(page.locator('.section-title').first()).toContainText('Report templates');
  const listRow = page.locator('.template-row-body', { hasText: uniqueModel });
  await expect(listRow).toBeVisible();
  // The "Fields" column is the row's 3rd span (report type, model, field
  // count, actions) — asserting on the row's full text instead would also
  // match the digits inside uniqueModel's Date.now() suffix, letting a
  // broken field count pass unnoticed.
  await expect(listRow.locator('span').nth(2)).toHaveText('2');

  // ---- Edit: add a third, object[]-typed field ----
  await listRow.locator('button:has-text("Edit")').click();
  await expect(page.locator('.section-title').first()).toContainText('Edit template');
  await expect(page.locator('.schema-field-row')).toHaveCount(2);

  await page.click('button:has-text("+ Add field")');
  const row3 = page.locator('.schema-field-row').nth(2);
  await row3.locator('[aria-label="Field name"]').fill('components_replaced');
  await row3.locator('[aria-label="Field type"]').selectOption('object[]');
  // Two columns, named so a length-based reorder (Postgres's old JSONB
  // key-reordering bug — see schemas.py's ItemSchemaColumn docstring) would
  // visibly flip them: "quantity" (8 chars) would sort after the shorter
  // "id" under that bug, but item_schema is a list now, so insertion order
  // should survive a save + reopen unchanged.
  await row3.locator('button:has-text("+ Add column")').click();
  await row3.locator('.item-schema-row').nth(0).locator('[aria-label="Column name"]').fill('quantity');
  await row3.locator('.item-schema-row').nth(0).locator('[aria-label="Column name"]').blur();
  await row3.locator('button:has-text("+ Add column")').click();
  await row3.locator('.item-schema-row').nth(1).locator('[aria-label="Column name"]').fill('id');
  await row3.locator('.item-schema-row').nth(1).locator('[aria-label="Column name"]').blur();
  await expect(row3.locator('.item-schema-row')).toHaveCount(2);

  await page.click('button:has-text("Save changes")');

  await expect(page.locator('.section-title').first()).toContainText('Report templates');
  const updatedRow = page.locator('.template-row-body', { hasText: uniqueModel });
  await expect(updatedRow.locator('span').nth(2)).toHaveText('3');

  // ---- Reopen and confirm the column order survived the save (the actual
  // regression check for the JSONB-ordering fix) ----
  await updatedRow.locator('button:has-text("Edit")').click();
  const reopenedRow3 = page.locator('.schema-field-row').nth(2);
  const columnNames = await reopenedRow3.locator('.item-schema-row [aria-label="Column name"]').evaluateAll(
    (inputs) => inputs.map((el) => (el as HTMLInputElement).value)
  );
  expect(columnNames).toEqual(['quantity', 'id']);
  await page.click('button:has-text("Cancel")');

  // ---- Delete: two-step confirm, cancel first to check it's a no-op ----
  await updatedRow.locator('button:has-text("Delete")').click();
  await updatedRow.locator('button:has-text("Cancel")').click();
  await expect(page.locator('.template-row-body', { hasText: uniqueModel })).toBeVisible();

  await updatedRow.locator('button:has-text("Delete")').click();
  await updatedRow.locator('button:has-text("Confirm delete")').click();
  await expect(page.locator('.template-row-body', { hasText: uniqueModel })).toHaveCount(0);
});

test('a template the backend rejects shows the validation reason, not a bare status', async ({ page }) => {
  // FastAPI sends request-validation 422s with `detail` as a list of
  // {loc, msg} entries; apiFetch used to read only a string `detail`, so
  // this showed "Unprocessable Content" (or nothing at all over HTTP/2)
  // instead of telling the user what to fix.
  await page.goto('/');
  await page.click('.view-tab:has-text("Templates")');
  await page.click('button:has-text("+ New template")');
  await page.locator('.schema-form-label', { hasText: 'Model' }).locator('input').fill(`E2E-Invalid-${Date.now()}`);

  // An enum field with no options — the client-side check only looks at
  // blank names, so this reaches the backend and gets a 422.
  await page.click('button:has-text("+ Add field")');
  const row = page.locator('.schema-field-row').nth(0);
  await row.locator('[aria-label="Field name"]').fill('fault_category');
  await row.locator('[aria-label="Field type"]').selectOption('enum');
  await page.click('button:has-text("Create template")');

  const banner = page.locator('.banner-crit');
  await expect(banner).toContainText('requires a non-empty options list');
  await expect(banner).not.toContainText('Value error');
  // Still on the form, nothing saved.
  await expect(page.locator('.section-title').first()).toContainText('New template');
});
