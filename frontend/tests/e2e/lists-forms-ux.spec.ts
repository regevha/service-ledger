import type { Page } from '@playwright/test';
import { test, expect } from './coverage';
import { isIsoDay } from '../../src/isoDay';
import { uniquePdf } from './unique-upload';
import { BACKEND_PORT } from '../../playwright.config';

// UI review items #20-#25: destructive actions that look destructive, a quieter Templates row,
// labelled fields in the template editor, required fields marked on the new-instrument form,
// stacked phone cards that say what each value is, and one date format everywhere.

const API_BASE = `http://localhost:${BACKEND_PORT}`;

async function color(page: Page, selector: string): Promise<string> {
  return page.locator(selector).first().evaluate((el) => getComputedStyle(el).color);
}

test('isIsoDay accepts real days only', () => {
  expect(isIsoDay('2025-03-14')).toBe(true);
  expect(isIsoDay('2024-02-29')).toBe(true);
  expect(isIsoDay('2025-02-30')).toBe(false);
  expect(isIsoDay('2025-3-14')).toBe(false);
  expect(isIsoDay('14/03/2025')).toBe(false);
  expect(isIsoDay('')).toBe(false);
});

test.describe('destructive actions', () => {
  test('Delete on an instrument row reads as destructive, its confirmation is solid red', async ({ page }) => {
    await page.goto('/#/instruments');
    await expect(page.locator('.instrument-row.template-row-body').first()).toBeVisible();
    const del = page.locator('.instrument-row.template-row-body').first().locator('button:has-text("Delete")');
    const edit = page.locator('.instrument-row.template-row-body').first().locator('button:has-text("Edit")');
    await expect(del).toHaveClass(/danger/);
    expect(await del.evaluate((el) => getComputedStyle(el).color)).not.toBe(await edit.evaluate((el) => getComputedStyle(el).color));
    await del.click();
    const confirm = page.getByRole('alertdialog').locator('button:has-text("Confirm delete")');
    await expect(confirm).toHaveClass(/solid/);
    await page.getByRole('alertdialog').locator('button:has-text("Cancel")').click();
  });

  test('on a report, Delete report sits apart from the navigation buttons', async ({ page, request }) => {
    const marker = `E2E-DelPos-${Date.now()}`;
    const report = await (await request.post(`${API_BASE}/reports`, { data: { technician_name: marker } })).json();
    await request.post(`${API_BASE}/reports/${report.id}/attachments`, {
      multipart: { file: { name: 'seed.pdf', mimeType: 'application/pdf', buffer: uniquePdf('%PDF-1.4 delpos') } },
    });
    await page.setViewportSize({ width: 1300, height: 800 });
    await page.goto(`/#/reports/${report.id}`);
    const del = page.locator('.detail-nav-row button:has-text("Delete report")');
    await expect(del).toBeVisible({ timeout: 15_000 });
    await expect(del).toHaveClass(/danger/);
    const [delBox, backBox, row] = await Promise.all([
      del.boundingBox(),
      page.locator('.detail-nav-row .back-link').boundingBox(),
      page.locator('.detail-nav-row').boundingBox(),
    ]);
    // Flush with the right edge of the toolbar, and a clear gap from the back link.
    expect(Math.round(delBox!.x + delBox!.width)).toBeGreaterThanOrEqual(Math.round(row!.x + row!.width) - 2);
    expect(delBox!.x - (backBox!.x + backBox!.width)).toBeGreaterThan(100);
  });
});

test.describe('templates table actions', () => {
  test('one visible Edit and a "⋯" menu; the row stays on one line', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/#/templates');
    const row = page.locator('.template-row-body').first();
    await expect(row).toBeVisible();
    await expect(row.getByRole('button', { name: 'Edit' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Duplicate' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Compare' })).toHaveCount(0);

    const menuButton = row.getByRole('button', { name: /More actions/ });
    await menuButton.click();
    await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    await expect(row.getByRole('menuitem')).toHaveText(['Duplicate', 'Compare', 'Delete']);
    await expect(row.getByRole('menuitem', { name: 'Delete' })).toHaveClass(/danger/);

    // Escape and a click elsewhere both close it.
    await page.keyboard.press('Escape');
    await expect(row.getByRole('menu')).toHaveCount(0);
    await menuButton.click();
    await page.locator('.section-title').first().click();
    await expect(row.getByRole('menu')).toHaveCount(0);

    const actions = await row.locator('.template-row-actions').boundingBox();
    expect(actions!.height).toBeLessThan(45);
  });

  test('phone: actions are one row, not four stacked buttons', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/templates');
    const row = page.locator('.template-row-body').first();
    await expect(row).toBeVisible();
    const actions = await row.locator('.template-row-actions').boundingBox();
    expect(actions!.height).toBeLessThan(50);
  });
});

test('template editor: every box has a caption, and the field name shows how it will read', async ({ page }) => {
  await page.goto('/#/templates');
  const row = page.locator('.template-row-body', { hasText: 'Calibration' }).first();
  await row.getByRole('button', { name: 'Edit' }).click();
  const first = page.locator('.schema-field-row').first();
  await expect(first).toBeVisible();
  for (const caption of ['Field name', 'Type', 'Unit (optional)', 'Notes for the lab manager (optional)']) {
    await expect(first.locator('.schema-field-caption', { hasText: caption })).toBeVisible();
  }
  const name = first.locator('input[aria-label="Field name"]');
  await name.fill('baseline_cv_percent');
  await first.locator('input[aria-label="Unit"]').fill('%');
  await expect(first.locator('.schema-field-preview')).toHaveText('Shown as Baseline CV (%)');
  // A filled-in unit is still identifiable: its caption stays.
  await expect(first.locator('.schema-field-caption', { hasText: 'Unit (optional)' })).toBeVisible();
});

test.describe('new instrument form', () => {
  async function openForm(page: Page) {
    await page.goto('/#/instruments');
    await page.click('button:has-text("New instrument")');
    await expect(page.locator('.section-title', { hasText: 'New instrument' })).toBeVisible();
  }

  test('required fields are marked and the button says what is missing', async ({ page }) => {
    await openForm(page);
    for (const label of ['Name', 'Model', 'Manufacturer', 'Serial number']) {
      await expect(page.locator('.schema-form-label', { hasText: label }).locator('.required-mark')).toBeVisible();
    }
    await expect(page.locator('.schema-form-label', { hasText: 'Room name' }).locator('.required-mark')).toHaveCount(0);
    await expect(page.locator('.schema-form-label', { hasText: 'Distributor' }).locator('.required-mark')).toHaveCount(0);
    await expect(page.locator('button:has-text("Create instrument")')).toBeDisabled();
    await expect(page.locator('#instrument-missing')).toHaveText('Still needed: name, model, manufacturer, serial number.');

    await page.locator('.schema-form-label', { hasText: 'Model' }).first().locator('input').fill('X1');
    await expect(page.locator('#instrument-missing')).toHaveText('Still needed: name, manufacturer, serial number.');

    await page.locator('.schema-form-label', { hasText: 'Name' }).first().locator('input').fill('Scratch');
    await page.locator('.schema-form-label', { hasText: 'Manufacturer' }).locator('input').fill('Acme');
    await page.locator('.schema-form-label', { hasText: 'Serial number' }).locator('input').fill('S-1');
    await expect(page.locator('#instrument-missing')).toHaveCount(0);
    await expect(page.locator('button:has-text("Create instrument")')).toBeEnabled();
  });

  test('"+ Add a type" is as tall as the select beside it', async ({ page }) => {
    await openForm(page);
    const [select, button] = await Promise.all([
      page.locator('#instrument-type').boundingBox(),
      page.locator('button:has-text("+ Add a type")').boundingBox(),
    ]);
    expect(Math.abs(select!.height - button!.height)).toBeLessThanOrEqual(2);
  });
});

test.describe('phone cards say what each value is', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  const before = (page: Page, selector: string) =>
    page.locator(selector).first().evaluate((el) => getComputedStyle(el, '::before').content.replace(/"/g, ''));

  test('Instruments', async ({ page }) => {
    await page.goto('/#/instruments');
    const row = '.instrument-row.template-row-body';
    await expect(page.locator(row).first()).toBeVisible();
    await expect(page.locator('.instrument-row.template-row-head')).toBeHidden();
    expect(await before(page, `${row} > span[data-label="Manufacturer"]`)).toBe('Manufacturer');
    expect(await before(page, `${row} > span[data-label="Room name"]`)).toBe('Room name');
    expect(await before(page, `${row} > span[data-label="Serial number"]`)).toBe('Serial number');
  });

  test('Reports: labelled values, and the sort buttons introduced as such', async ({ page }) => {
    await page.goto('/#/reports');
    const row = '.report-row-body';
    await expect(page.locator(row).first()).toBeVisible();
    expect(await before(page, `${row} > span[data-label="Lab manager"]`)).toBe('Lab manager');
    expect(await before(page, `${row} > span[data-label="Report date"]`)).toBe('Report date');
    expect(await before(page, `${row} > span[data-label="Status"]`)).toBe('Status');
    expect(await before(page, '.report-row-head')).toBe('Sort by');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});

test.describe('dates read YYYY-MM-DD everywhere', () => {
  test('the report filters take and show ISO dates; half-typed dates are not applied', async ({ page }) => {
    await page.goto('/#/reports');
    await expect(page.locator('.report-row-body').first()).toBeVisible();
    const from = page.getByLabel('From date', { exact: true });
    await expect(from).toHaveAttribute('placeholder', 'YYYY-MM-DD');

    // Typing is not applied until it is a whole, real day.
    await from.fill('2025-03');
    await expect(from).toHaveAttribute('aria-invalid', 'true');
    await from.fill('2025-02-30');
    await expect(from).toHaveAttribute('aria-invalid', 'true');
    // Leaving it puts back the last good value (empty), so nothing stale is left in the box.
    await from.blur();
    await expect(from).toHaveValue('');
    await expect(from).not.toHaveAttribute('aria-invalid', 'true');

    await from.fill('2090-01-01');
    await expect(from).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('.report-row-body')).toHaveCount(0);
    await from.fill('');
    await expect(page.locator('.report-row-body').first()).toBeVisible();
  });

  test('the calendar button fills the box in the same format', async ({ page }) => {
    await page.goto('/#/reports');
    await expect(page.locator('.report-row-body').first()).toBeVisible();
    const box = page.locator('.date-input').first();
    // The browser's own picker cannot be driven; its hidden input is what the button opens.
    await box.locator('input[type="date"]').evaluate((el: HTMLInputElement) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(el, '2031-04-05');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(box.locator('input[type="text"]')).toHaveValue('2031-04-05');
    await expect(box.getByRole('button', { name: /calendar/i })).toBeVisible();
  });

  test('the service date on the review screen is ISO too', async ({ page }) => {
    await page.goto('/#/new');
    await page.locator('input[type="file"]').setInputFiles({ name: 'confident-scan.pdf', mimeType: 'application/pdf', buffer: uniquePdf('%PDF-1.4 datefmt') });
    await page.click('button:has-text("Upload & classify")');
    await expect(page.locator('.field-list')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#review-report-date')).toHaveAttribute('placeholder', 'YYYY-MM-DD');
  });
});
