import { test, expect } from './coverage';

// The Instruments tab (InstrumentManager.tsx) replaces "POST /instruments
// from a script or curl, then edit the DB by hand for anything else" as the
// only way to add or fix an instrument — this drives the full create ->
// edit cycle through the real UI, including that a save here is reflected
// immediately in the Reports tab's instrument filter (both are fed by the
// same top-level `instruments` list in App.tsx), and that the backend's
// duplicate-serial-number conflict (PATCH /instruments/{id} -> 409) surfaces
// as a real error banner rather than silently failing.
//
// This suite has no per-test truncation, so every instrument this test
// creates uses a unique name/serial number (never one of the 3 fixed seeded
// instruments) to avoid colliding with rows other specs — or a previous run
// of this same spec — may have left behind.

test('create an instrument, see it in the Reports filter, then edit it', async ({ page }) => {
  const uniqueName = `E2E-Instrument-${Date.now()}`;
  const serial = `E2E-SN-${Date.now()}`;

  await page.goto('/');
  await page.click('.view-tab:has-text("Instruments")');
  await expect(page.locator('.section-title')).toContainText('Instruments');

  // ---- Create ----
  await page.click('button:has-text("+ New instrument")');
  await expect(page.locator('.section-title').first()).toContainText('New instrument');

  // A fresh create form has no Status field — an instrument is always
  // created active (schemas.py's InstrumentCreate has no status field).
  await expect(page.locator('.schema-form-label', { hasText: 'Status' })).toHaveCount(0);

  await page.locator('.schema-form-label', { hasText: 'Name' }).locator('input').fill(uniqueName);
  await page.locator('.schema-form-label', { hasText: 'Model' }).locator('input').fill('E2E-Model');
  await page.locator('.schema-form-label', { hasText: 'Serial number' }).locator('input').fill(serial);
  await page.locator('.schema-form-label', { hasText: 'Location' }).locator('input').fill('E2E Bench');
  await page.click('button:has-text("Create instrument")');

  // ---- Verify it landed in the list, active by default ----
  await expect(page.locator('.section-title').first()).toContainText('Instruments');
  const listRow = page.locator('.instrument-row.template-row-body', { hasText: uniqueName });
  await expect(listRow).toBeVisible();
  await expect(listRow).toContainText('E2E-Model');
  await expect(listRow).toContainText(serial);
  await expect(listRow).toContainText('E2E Bench');
  await expect(listRow.locator('.status-pill.instrument-status-active')).toContainText('Active');

  // ---- The Reports tab's instrument filter picks up the new instrument
  // immediately, with no reload — proves the create flowed through the
  // shared top-level `instruments` list, not just this tab's own view.
  // (The filter's own option text is "model (serial number)" — App.tsx's
  // filter-row select — not the instrument's name.) ----
  await page.click('.view-tab:has-text("Reports")');
  await expect(page.locator('.filter-row select').first().locator('option', { hasText: serial })).toHaveCount(1);
  await page.click('.view-tab:has-text("Instruments")');

  // ---- Edit: rename, relocate, and retire it ----
  await listRow.locator('button:has-text("Edit")').click();
  await expect(page.locator('.section-title').first()).toContainText('Edit instrument');

  const nameInput = page.locator('.schema-form-label', { hasText: 'Name' }).locator('input');
  await nameInput.fill(`${uniqueName}-Renamed`);
  await page.locator('.schema-form-label', { hasText: 'Location' }).locator('input').fill('New Bench');
  await page.locator('.schema-form-label', { hasText: 'Status' }).locator('select').selectOption('maintenance');
  await page.click('button:has-text("Save changes")');

  await expect(page.locator('.section-title').first()).toContainText('Instruments');
  const renamedRow = page.locator('.instrument-row.template-row-body', { hasText: `${uniqueName}-Renamed` });
  await expect(renamedRow).toBeVisible();
  await expect(renamedRow).toContainText('New Bench');
  await expect(renamedRow.locator('.status-pill.instrument-status-maintenance')).toContainText('In maintenance');
  // The row was updated in place, not superseded by a second new row — an
  // exact-text lookup so the renamed row's own (superstring) name doesn't
  // make this pass for the wrong reason.
  await expect(page.getByText(uniqueName, { exact: true })).toHaveCount(0);
});

test('editing an instrument to reuse another one\'s serial number shows an error, not a silent failure', async ({
  page,
}) => {
  const nameA = `E2E-Conflict-A-${Date.now()}`;
  const nameB = `E2E-Conflict-B-${Date.now()}`;
  const serialA = `E2E-SN-A-${Date.now()}`;
  const serialB = `E2E-SN-B-${Date.now()}`;

  async function createInstrument(name: string, serial: string) {
    await page.click('button:has-text("+ New instrument")');
    await page.locator('.schema-form-label', { hasText: 'Name' }).locator('input').fill(name);
    await page.locator('.schema-form-label', { hasText: 'Model' }).locator('input').fill('E2E-Model');
    await page.locator('.schema-form-label', { hasText: 'Serial number' }).locator('input').fill(serial);
    await page.click('button:has-text("Create instrument")');
    await expect(page.locator('.instrument-row.template-row-body', { hasText: name })).toBeVisible();
  }

  await page.goto('/');
  await page.click('.view-tab:has-text("Instruments")');
  await createInstrument(nameA, serialA);
  await createInstrument(nameB, serialB);

  await page.locator('.instrument-row.template-row-body', { hasText: nameB }).locator('button:has-text("Edit")').click();
  await page.locator('.schema-form-label', { hasText: 'Serial number' }).locator('input').fill(serialA);
  await page.click('button:has-text("Save changes")');

  await expect(page.locator('.banner-crit')).toContainText('already exists');
  // Still on the edit form — the conflicting save did not silently navigate
  // away or apply.
  await expect(page.locator('.section-title').first()).toContainText('Edit instrument');

  await page.click('button:has-text("Cancel")');
  const rowB = page.locator('.instrument-row.template-row-body', { hasText: nameB });
  await expect(rowB).toContainText(serialB);
});
