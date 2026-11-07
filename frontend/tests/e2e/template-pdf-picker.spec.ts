import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './coverage';
import { seedReport } from './helpers/api';

// The "Pick fields from a PDF" panel in the template editor: choose a stored report's PDF, click its text,
// and the text becomes a new template field.

test('click a word on a stored PDF to add it as a template field', async ({ page, request }) => {
  const model = `E2E-Pick-${Date.now()}`;
  await seedReport(request, {
    model: 'LSRFortessa',
    reportType: 'repair',
    file: { name: 'pick-fields-form.pdf', contents: readFileSync(path.join(process.cwd(), 'tests/e2e/fixtures/pick-fields-form.pdf')) },
  });

  await page.goto('/#/new');
  await page.getByTestId('tab-templates').click();
  await page.click('button:has-text("+ New template")');
  await page.getByTestId('form-label').filter({ hasText: 'Model' }).locator('input').fill(model);

  await page.getByTestId('pdf-picker-open').click();
  const picker = page.getByTestId('pdf-picker');
  await expect(picker).toBeVisible();
  await expect(page.getByTestId('pdf-word').first()).toBeAttached();

  const value = page.getByTestId('pdf-word').filter({ hasText: '29.40' }).first();
  await value.click();
  const card = page.getByTestId('pdf-add-card');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('pdf-add-sample')).toContainText('29.40');
  await expect(card.locator('[aria-label="Field name"]')).toHaveValue('laser_delay');
  await expect(card.locator('[aria-label="Field type"]')).toHaveValue('number');
  await card.getByRole('button', { name: 'Add field' }).click();

  await expect(page.getByTestId('pdf-picker-added')).toContainText('laser_delay');
  const row = page.locator('.schema-field-row').last();
  await expect(row.locator('[aria-label="Field name"]')).toHaveValue('laser_delay');
  await expect(row.locator('[aria-label="Field type"]')).toHaveValue('number');

  // The field is drawn back over the page where it was picked.
  await expect(page.getByTestId('pdf-marker')).toHaveCount(1);
  await expect(page.getByTestId('pdf-marker')).toContainText('laser_delay');

  // And the place is saved with the template: reopening it shows the same marker.
  await page.click('button:has-text("Create template")');
  const listRow = page.getByTestId('template-row').filter({ hasText: model });
  await listRow.locator('button:has-text("Edit")').click();
  await page.getByTestId('pdf-picker-open').click();
  await expect(page.getByTestId('pdf-word').first()).toBeAttached();
  await expect(page.getByTestId('pdf-marker')).toHaveCount(1);
  await expect(page.getByTestId('pdf-marker')).toContainText('laser_delay');

  // Removing the field removes its marker.
  await page.locator('.schema-field-row').first().getByRole('button', { name: /Remove/ }).click();
  await expect(page.getByTestId('pdf-marker')).toHaveCount(0);
});

test('the picker shows an empty state when no PDF is stored for the template', async ({ page }) => {
  await page.route('**/report-templates/sample-scans*', (route) => route.fulfill({ json: [] }));
  await page.goto('/#/new');
  await page.getByTestId('tab-templates').click();
  await page.click('button:has-text("+ New template")');
  await page.getByTestId('pdf-picker-open').click();
  await expect(page.getByTestId('pdf-picker-empty')).toBeVisible();
});
