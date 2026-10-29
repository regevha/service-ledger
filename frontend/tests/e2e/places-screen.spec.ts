import { type APIRequestContext, type Page } from '@playwright/test';
import { test, expect } from './coverage';
import { API_BASE } from './helpers/api';

// Places as records (places plan, step 2): a Places list under the Instruments tab, suggestions on
// the instrument form, rename / move / merge / delete that say exactly what they change.

async function makeUnit(request: APIRequestContext, tag: string, institution: string | null, location: string | null) {
  const r = await request.post(`${API_BASE}/instruments`, {
    data: { name: `E2E ${tag}`, model: 'E2E Place Model', manufacturer: 'E2E Maker', serial_number: `E2E-PL-${tag}-${Date.now()}`, institution, location },
  });
  expect(r.ok()).toBeTruthy();
  return r.json();
}

async function openPlaces(page: Page) {
  await page.goto('/');
  await page.click('.view-tab:has-text("Instruments")');
  await page.click('.sub-switch button:has-text("Places")');
  await expect(page.locator('#places-section')).toBeVisible();
}

// The row whose place name is exactly this, of this kind.
const placeRow = (page: Page, name: string, kind: string) =>
  page.locator('.place-row.template-row-body', {
    has: page.locator('.place-name-text', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }),
    hasText: kind,
  });

test('the Places list shows institutions and rooms with their instrument counts', async ({ page, request }) => {
  const uni = `E2E Uni ${Date.now()}`;
  await makeUnit(request, 'a', uni, 'Room 1');
  await makeUnit(request, 'b', uni, 'Room 1');
  await makeUnit(request, 'c', uni, null);

  await openPlaces(page);
  await expect(placeRow(page, uni, 'Institution').locator('[data-label="Instruments"]')).toContainText('3');
  await expect(placeRow(page, uni, 'Institution').locator('[data-label="Instruments"]')).toContainText('1 directly');
  const room = page.locator('.place-row.template-row-body', { hasText: 'Room 1' }).filter({ hasText: uni });
  await expect(room.locator('[data-label="Instruments"]')).toHaveText('2');
});

test('renaming an institution warns how many instruments change and updates them', async ({ page, request }) => {
  const stamp = Date.now();
  const uni = `E2E Ren Uni ${stamp}`;
  const unit = await makeUnit(request, 'ren', uni, 'R9');

  await openPlaces(page);
  await placeRow(page, uni, 'Institution').locator('button:has-text("Edit")').click();
  await page.locator('.schema-form-label', { hasText: 'Name' }).locator('input').fill(`${uni} II`);
  await expect(page.locator('#place-rename-warning')).toContainText('Renaming changes the institution of 1 instrument to');
  await page.click('button:has-text("Save changes")');
  await expect(placeRow(page, `${uni} II`, 'Institution')).toBeVisible();
  const after = await (await request.get(`${API_BASE}/instruments/${unit.id}`)).json();
  expect(after.institution).toBe(`${uni} II`);
  expect(after.location).toBe('R9');
});

test('look-alike places are flagged, and merge says exactly what moves', async ({ page, request }) => {
  const stamp = Date.now();
  const keep = `E2E Room ${stamp}`;
  const dupe = `${stamp}`;
  const uni = `E2E Merge Uni ${stamp}`;
  await makeUnit(request, 'k', uni, keep);
  const moved = await makeUnit(request, 'm', uni, dupe);

  await openPlaces(page);
  const dupeRow = page.locator('.place-row.template-row-body', { has: page.locator('.place-name-text', { hasText: new RegExp(`^${dupe}$`) }) });
  await expect(dupeRow.locator('.model-similar')).toContainText(`“${keep}”`);

  await dupeRow.locator('.row-menu-button').click();
  await page.click('[role="menuitem"]:has-text("Merge into")');
  const dialog = page.locator('[role="alertdialog"][aria-label="Merge place"]');
  await dialog.locator('select').selectOption({ label: `${keep} (${uni})` });
  await expect(dialog).toContainText(`1 instrument pointing at “${dupe}” move to “${keep}”`);
  await expect(dialog).toContainText('This cannot be undone');
  await dialog.locator('button:has-text("Confirm merge")').click();

  await expect(dupeRow).toHaveCount(0);
  const after = await (await request.get(`${API_BASE}/instruments/${moved.id}`)).json();
  expect(after.location).toBe(keep);
});

test('delete is blocked while a place is in use and says what it deletes when it is empty', async ({ page, request }) => {
  const uni = `E2E Del Uni ${Date.now()}`;
  await makeUnit(request, 'd', uni, 'Used room');
  const inst = await (await request.get(`${API_BASE}/places`)).json();
  const parent = inst.find((p: { name: string; kind: string }) => p.name === uni && p.kind === 'institution');
  expect((await request.post(`${API_BASE}/places`, { data: { kind: 'room', name: 'Empty room', parent_id: parent.id } })).ok()).toBeTruthy();

  await openPlaces(page);
  await placeRow(page, uni, 'Institution').locator('.row-menu-button').click();
  await expect(page.locator('[role="menuitem"]:has-text("Delete")')).toBeDisabled();
  await page.keyboard.press('Escape');

  const empty = page.locator('.place-row.template-row-body', { hasText: 'Empty room' }).filter({ hasText: uni });
  await empty.locator('.row-menu-button').click();
  await page.click('[role="menuitem"]:has-text("Delete")');
  const dialog = page.locator('[role="alertdialog"][aria-label="Confirm delete place"]');
  await expect(dialog).toContainText('Delete the room “Empty room”? This deletes only the place record; nothing is inside it and no instrument is in it.');
  await dialog.locator('button:has-text("Confirm delete")').click();
  await expect(empty).toHaveCount(0);
});

test('the instrument form says whether the institution and room are new or existing', async ({ page, request }) => {
  const uni = `E2E Form Uni ${Date.now()}`;
  await makeUnit(request, 'f', uni, 'Lab 7');

  await page.goto('/');
  await page.click('.view-tab:has-text("Instruments")');
  await page.click('button:has-text("+ New instrument")');
  const inst = page.locator('.schema-form-label', { hasText: 'Institution' }).locator('input');
  const room = page.locator('.schema-form-label', { hasText: 'Room name' }).locator('input');
  await inst.fill(uni);
  await expect(page.locator('#place-hint')).toContainText('Existing institution · 1 instrument');
  await room.fill('Lab 7');
  await expect(page.locator('#place-hint')).toContainText('Existing room · 1 instrument');
  await room.fill('Lab 8');
  await expect(page.locator('#place-hint')).toContainText('New room · it will be added to Places');
  await inst.fill(`${uni} other`);
  await expect(page.locator('#place-hint')).toContainText('New institution · it will be added to Places');
});

test('phone: the Places list has no sideways scroll and keeps captions', async ({ page, request }) => {
  await makeUnit(request, 'p', `E2E Phone Uni ${Date.now()}`, 'P1');
  await page.setViewportSize({ width: 390, height: 844 });
  await openPlaces(page);
  const row = page.locator('.place-row.template-row-body').first();
  await expect(row.locator('[data-label="Kind"]')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
