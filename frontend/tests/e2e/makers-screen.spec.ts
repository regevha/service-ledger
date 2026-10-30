import { type Page } from '@playwright/test';
import { test, expect } from './coverage';
import { API_BASE } from './helpers/api';

// Makers as records: a Makers list under the Instruments tab, a maker typed under another of its
// names is stored under its own, and the manufacturer boxes suggest the makers on file.

async function openMakers(page: Page) {
  await page.goto('/');
  await page.click('.view-tab:has-text("Instruments")');
  await page.click('.sub-switch button:has-text("Makers")');
  await expect(page.locator('#makers-section')).toBeVisible();
}

const makerRow = (page: Page, name: string) =>
  page.locator('.maker-row.template-row-body', { has: page.locator('[data-label="Maker"]', { hasText: new RegExp(`^${name}$`) }) });

test('the Makers list shows the seeded makers with their other names and counts', async ({ page }) => {
  await openMakers(page);
  const bd = makerRow(page, 'BD');
  await expect(bd).toBeVisible();
  await expect(bd.locator('[data-label="Other names"]')).toContainText('Becton Dickinson');
  await expect(bd.locator('[data-label="Instruments"]')).not.toHaveText('0');
});

test('adding a maker with another name, then typing that name on an instrument stores the maker', async ({ page, request }) => {
  const stamp = Date.now();
  const name = `E2E Maker ${stamp}`;
  await openMakers(page);
  await page.click('button:has-text("+ New maker")');
  await page.locator('.schema-form-label', { hasText: /^Name/ }).locator('input').fill(name);
  await page.locator('.schema-form-label', { hasText: 'Other names' }).locator('input').fill(`E2E Alt ${stamp}; E2E Other ${stamp}`);
  await page.click('button:has-text("Add maker")');
  const row = makerRow(page, name);
  await expect(row).toBeVisible();
  await expect(row.locator('[data-label="Other names"]')).toHaveText(`E2E Alt ${stamp}; E2E Other ${stamp}`);

  const res = await request.post(`${API_BASE}/instruments`, {
    data: { name: `E2E Unit ${stamp}`, model: `E2E Model ${stamp}`, manufacturer: `e2e  alt ${stamp}`, serial_number: `E2E-MK-${stamp}` },
  });
  expect(res.status()).toBe(201);
  expect((await res.json()).manufacturer).toBe(name);

  await openMakers(page);
  await expect(makerRow(page, name).locator('[data-label="Instruments"]')).toHaveText('1');
  // A maker in use cannot be deleted.
  await expect(makerRow(page, name).locator('button:has-text("Delete")')).toBeDisabled();
});

test('an unused maker can be renamed and deleted', async ({ page, request }) => {
  const stamp = Date.now();
  const created = await request.post(`${API_BASE}/manufacturers`, { data: { name: `E2E Temp ${stamp}`, aliases: [] } });
  expect(created.status()).toBe(201);
  await openMakers(page);
  await makerRow(page, `E2E Temp ${stamp}`).locator('button:has-text("Edit")').click();
  await page.locator('.schema-form-label', { hasText: /^Name/ }).locator('input').fill(`E2E Temp ${stamp} II`);
  await page.click('button:has-text("Save changes")');
  await expect(makerRow(page, `E2E Temp ${stamp} II`)).toBeVisible();
  await makerRow(page, `E2E Temp ${stamp} II`).locator('button:has-text("Delete")').click();
  await page.click('button:has-text("Confirm delete")');
  await expect(makerRow(page, `E2E Temp ${stamp} II`)).toHaveCount(0);
});

test('a name another maker already answers to is refused', async ({ page }) => {
  await openMakers(page);
  await page.click('button:has-text("+ New maker")');
  await page.locator('.schema-form-label', { hasText: /^Name/ }).locator('input').fill('Becton Dickinson');
  await page.click('button:has-text("Add maker")');
  await expect(page.locator('.banner-crit')).toContainText('already has this name');
});

test('the manufacturer box on a new model suggests the makers on file', async ({ page }) => {
  await page.goto('/');
  await page.click('.view-tab:has-text("Instruments")');
  await page.click('.sub-switch button:has-text("Models")');
  await page.click('button:has-text("+ New model")');
  const box = page.getByPlaceholder('e.g. Cytek Biosciences');
  await expect(box).toHaveAttribute('list', 'maker-names');
  await expect(page.locator('#maker-names option[value="BD"]')).toHaveCount(1);
  await expect(page.locator('#maker-names option[value="Becton Dickinson"]')).toHaveCount(1);
});
