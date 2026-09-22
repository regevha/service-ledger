import { test, expect } from '@playwright/test';

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
  await expect(listRow).toContainText('2'); // field count

  // ---- Edit: add a third, object[]-typed field ----
  await listRow.locator('button:has-text("Edit")').click();
  await expect(page.locator('.section-title').first()).toContainText('Edit template');
  await expect(page.locator('.schema-field-row')).toHaveCount(2);

  await page.click('button:has-text("+ Add field")');
  const row3 = page.locator('.schema-field-row').nth(2);
  await row3.locator('[aria-label="Field name"]').fill('components_replaced');
  await row3.locator('[aria-label="Field type"]').selectOption('object[]');
  // A fresh object[] field starts with no columns — add one and leave its
  // default name/type (column_1 / text) rather than renaming.
  await row3.locator('button:has-text("+ Add column")').click();
  await expect(row3.locator('.item-schema-row')).toHaveCount(1);

  await page.click('button:has-text("Save changes")');

  await expect(page.locator('.section-title').first()).toContainText('Report templates');
  const updatedRow = page.locator('.template-row-body', { hasText: uniqueModel });
  await expect(updatedRow).toContainText('3');

  // ---- Delete: two-step confirm, cancel first to check it's a no-op ----
  await updatedRow.locator('button:has-text("Delete")').click();
  await updatedRow.locator('button:has-text("Cancel")').click();
  await expect(page.locator('.template-row-body', { hasText: uniqueModel })).toBeVisible();

  await updatedRow.locator('button:has-text("Delete")').click();
  await updatedRow.locator('button:has-text("Confirm delete")').click();
  await expect(page.locator('.template-row-body', { hasText: uniqueModel })).toHaveCount(0);
});
