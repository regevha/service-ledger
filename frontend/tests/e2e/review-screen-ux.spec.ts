import { type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './coverage';
import { uniqueFixture } from './unique-upload';
import { fieldLabel } from '../../src/fieldLabels';
import { reviewSnapshot } from '../../src/reviewSnapshot';
import { finalizeFromReview } from './finalize-helper';
import { createNumericModel } from './numeric-fixture';
import { TIMEOUT } from './timeouts';
import { seedReport } from './helpers/api';
import { openReviewFromList } from './helpers/ui';

// The review screen as the 2026-10-24 UI review asked for it: the scan beside the fields, an action
// bar that stays in view, readable field names, a finalized report that is read-only until Edit,
// and the parts table readable on a phone.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A scan whose stub read always has flagged fields. For an ordinary scan the stub's confidence per
// field comes from a hash of the stored file's unique name, so how many fields are flagged changes
// from run to run (a test that needs flagged fields could not rely on it). For the sample work order
// the stub always flags root_cause and components_replaced, which are blank on the real document.
// It lands on the manual-confirm step first, because its report type is below the threshold.
async function readSampleWorkOrder(page: Page) {
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles(uniqueFixture(path.join(__dirname, 'fixtures', 'sample-work-order.pdf')));
  await page.click('button:has-text("Upload & classify")');
  await page.waitForSelector('.class-row', { timeout: TIMEOUT.flow });
  await page.click('button:has-text("Confirm & continue")');
  await expect(page.locator('.field-list')).toBeVisible({ timeout: TIMEOUT.flow });
}

test('fieldLabel: readable names, abbreviations in capitals, no unit said twice', () => {
  expect(fieldLabel('cst_beads_lot')).toBe('CST beads lot');
  expect(fieldLabel('pmt_voltages', 'V')).toBe('PMT voltages');
  expect(fieldLabel('baseline_cv_percent', '%')).toBe('Baseline CV');
  expect(fieldLabel('fluidics_pressure_psi', 'psi')).toBe('Fluidics pressure');
  expect(fieldLabel('labor_hours', 'hours')).toBe('Labor');
  expect(fieldLabel('fault_description')).toBe('Fault description');
  expect(fieldLabel('detector_1')).toBe('Detector 1');
  // A unit that is not the last word is left alone, and a single word is never emptied.
  expect(fieldLabel('psi_reading', 'psi')).toBe('Psi reading');
  expect(fieldLabel('psi', 'psi')).toBe('Psi');
});

test('field names read as words, not as stored names', async ({ page, request }) => {
  const marker = `E2E-Labels-${Date.now()}`;
  const model = await createNumericModel(request, 'E2E-Labels');
  await seedReport(request, { model, reportType: 'installation_upgrade', technician: marker });
  await openReviewFromList(page, marker);
  const list = page.locator('.field-list');
  await expect(list).toContainText('CST beads lot');
  await expect(list).toContainText('PMT voltages');
  await expect(list).toContainText('Fluidics pressure');
  await expect(list).not.toContainText('Fluidics pressure psi');
  await expect(list).not.toContainText('cst_beads_lot');
});

test.describe('scan beside the fields', () => {
  test('wide screen: the scan sits next to the fields, can be hidden, and stays hidden', async ({ page, request }) => {
    const marker = `E2E-Scan-${Date.now()}`;
    await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: marker });
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('sl.review.showScan', 'on');
      }
    });
    await openReviewFromList(page, marker);

    const scan = page.locator('.review-scan');
    await expect(scan).toBeVisible();
    await expect(scan.locator('iframe')).toHaveAttribute('src', /\/attachments\/.+\/file\?inline=1/);
    const [scanBox, listBox] = await Promise.all([scan.boundingBox(), page.locator('.field-list').boundingBox()]);
    expect(scanBox!.x + scanBox!.width).toBeLessThanOrEqual(listBox!.x);
    // The scan takes the left half: it is as wide as the fields column (within a pixel or two).
    const fieldsBox = await page.locator('.review-fields').boundingBox();
    expect(Math.abs(scanBox!.width - fieldsBox!.width)).toBeLessThanOrEqual(2);

    await page.click('button:has-text("Hide scan")');
    await expect(scan).toHaveCount(0);
    await page.reload();
    await page.click('.view-tab:has-text("Reports")');
    await page.click(`.report-row-body:has-text("${marker}")`);
    await expect(page.locator('.field-list')).toBeVisible({ timeout: TIMEOUT.ui });
    await expect(page.locator('.review-scan')).toHaveCount(0);
    await page.click('button:has-text("Show scan")');
    await expect(page.locator('.review-scan')).toBeVisible();
  });

  test('narrow screen: no scan pane, just the link', async ({ page, request }) => {
    const marker = `E2E-ScanNarrow-${Date.now()}`;
    await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: marker });
    await page.setViewportSize({ width: 800, height: 900 });
    await openReviewFromList(page, marker);
    await expect(page.locator('.review-scan')).toHaveCount(0);
    await expect(page.locator('a:has-text("View original scan")')).toBeVisible();
    await expect(page.locator('button:has-text("Hide scan")')).toHaveCount(0);
  });
});

test('the action bar stays in view while a long form scrolls', async ({ page, request }) => {
  const marker = `E2E-Sticky-${Date.now()}`;
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: marker });
  await page.setViewportSize({ width: 1000, height: 500 });
  await openReviewFromList(page, marker);
  const bar = page.locator('.review-actions');
  const box = await bar.boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(500);
  await expect(page.locator('button:has-text("Save corrections")')).toBeInViewport();
});

test('"Next" jumps to the fields that need attention', async ({ page }) => {
  await readSampleWorkOrder(page);
  const flagged = page.locator('.field.pending');
  const n = await flagged.count();
  expect(n, 'the sample work order always has flagged fields').toBeGreaterThanOrEqual(2);
  await expect(page.locator('.review-actions-status')).toContainText(`${n} field`);
  for (let i = 0; i < n; i++) {
    await page.click('.review-actions button:has-text("Next")');
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest('.field')?.className ?? ''))
      .toContain('pending');
  }
});

test('a finalized report is read-only until Edit, and locks again after saving', async ({ page, request }) => {
  const marker = `E2E-ReadOnly-${Date.now()}`;
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: marker, finalize: true });
  await openReviewFromList(page, marker);

  const firstText = page.locator('.field-list textarea').first();
  await expect(firstText).toBeDisabled();
  await expect(page.locator('button:has-text("Save corrections")')).toHaveCount(0);
  await expect(page.locator('.review-actions')).toContainText('Finalized');

  await page.click('.review-actions button:has-text("Edit")');
  await expect(firstText).toBeEnabled();
  await firstText.fill('Corrected after finalizing');
  await page.click('button:has-text("Save corrections")');
  // Saving locks the form again; wait for that rather than for the progress panel, which may not have appeared yet.
  await expect(page.locator('.review-actions button:has-text("Edit")')).toBeVisible({ timeout: 20_000 });

  await expect(page.locator('.field-list textarea').first()).toBeDisabled();
  await expect(page.locator('.field-list textarea').first()).toHaveValue('Corrected after finalizing');
  await expect(page.locator('.review-actions button:has-text("Edit")')).toBeVisible();
});

test('the banner lines up with the fields instead of being inset twice', async ({ page }) => {
  // Below 900px the scan pane is gone and the fields use the full width, so the two edges compare directly.
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles(uniqueFixture(path.join(__dirname, 'fixtures', 'confident-scan.pdf')));
  await page.click('button:has-text("Upload & classify")');
  await page.waitForSelector('.field-list', { timeout: TIMEOUT.flow });
  const banner = page.locator('#placeholder-notice');
  await expect(banner).toBeVisible();
  const [b, l] = await Promise.all([banner.boundingBox(), page.locator('.field-list').boundingBox()]);
  expect(Math.round(b!.x)).toBe(Math.round(l!.x));
  expect(Math.round(b!.width)).toBe(Math.round(l!.width));
});

test('phone: each part is a small labelled card, not a row of squeezed boxes', async ({ page, request }) => {
  const marker = `E2E-PhoneParts-${Date.now()}`;
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: marker });
  await page.setViewportSize({ width: 390, height: 844 });
  await openReviewFromList(page, marker);
  const field = page.locator('.field', { hasText: 'Components replaced' });
  await expect(field.locator('.object-array-head')).toBeHidden();
  const cell = field.locator('.object-array-row > span[data-label]').first();
  const label = await cell.evaluate((el) => getComputedStyle(el, '::before').content);
  expect(label.replace(/"/g, '')).toBe('Part name');
  const input = await cell.locator('input').boundingBox();
  expect(input!.width).toBeGreaterThan(150);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(overflow).toBe(true);
});

test('the per-detector rows stay compact and each can be removed by name', async ({ page, request }) => {
  const marker = `E2E-Detectors-${Date.now()}`;
  const model = await createNumericModel(request, 'E2E-Detectors');
  await seedReport(request, { model, reportType: 'installation_upgrade', technician: marker });
  await page.setViewportSize({ width: 1400, height: 900 });
  await openReviewFromList(page, marker);
  const row = page.locator('.field', { hasText: 'Baseline CV' }).locator('.number-map-row').first();
  const [label, input, remove] = await Promise.all([
    row.locator('label, span').first().boundingBox(),
    row.locator('input').boundingBox(),
    row.locator('button[aria-label^="Remove detector"]').boundingBox(),
  ]);
  expect(input!.width).toBeLessThanOrEqual(210);
  // Label, input and × sit together instead of being spread across the card.
  expect(remove!.x + remove!.width - label!.x).toBeLessThanOrEqual(420);
  await expect(row.locator('button[aria-label^="Remove detector"]')).toBeVisible();
});

test('text "Remove" buttons in the template editor stay inside their card', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await page.goto('/');
  await page.click('.view-tab:has-text("Templates")');
  await page.locator('.template-row-body', { hasText: 'Preventive maintenance' }).first().locator('button:has-text("Edit")').click();
  const row = page.locator('.schema-field-row').first();
  await expect(row).toBeVisible();
  const [card, remove] = await Promise.all([row.boundingBox(), row.locator('.row-remove').first().boundingBox()]);
  expect(remove!.x + remove!.width).toBeLessThanOrEqual(card!.x + card!.width);
  expect(remove!.width).toBeGreaterThan(40); // the word, not a 28px circle
});

test('flagged fields are listed above the fields and clear only when marked as checked', async ({ page }) => {
  await readSampleWorkOrder(page);
  const n = await page.locator('.field.pending').count();
  expect(n, 'the sample work order always has flagged fields').toBeGreaterThanOrEqual(2);

  const strip = page.getByTestId('attention-strip');
  await expect(strip).toContainText(`${n} field`);
  const stripBox = await strip.boundingBox();
  const listBox = await page.locator('.field-list').boundingBox();
  expect(stripBox!.y).toBeLessThan(listBox!.y);

  // Typing over a flagged value does not clear the flag.
  const first = page.locator('.field.pending').first();
  const input = first.locator('input, textarea').first();
  if (await input.count()) await input.fill('1');
  await expect(page.locator('.field.pending')).toHaveCount(n);

  await first.getByRole('button', { name: 'Mark as checked' }).click();
  await expect(page.locator('.field.pending')).toHaveCount(n - 1);
  if (n === 1) await expect(strip).toHaveCount(0);
  else await expect(strip).toContainText(`${n - 1} field`);
});

// Saving without leaving the screen, and not losing edits (PR 1 of the review-and-finalize plan).

const CONFIDENT_SCAN = path.join(__dirname, 'fixtures', 'confident-scan.pdf');

async function openIntakeReview(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles(uniqueFixture(CONFIDENT_SCAN));
  await page.click('button:has-text("Upload & classify")');
  await page.waitForSelector('.field-list', { timeout: 30_000 });
}

// Whether the stub flags any field varies from run to run. Reporting the service date at 10% confidence
// makes at least one field flagged every time, for specs that need something to be flagged.
async function flagServiceDate(page: import('@playwright/test').Page) {
  await page.route('**/extraction-jobs/*', async (route) => {
    const response = await route.fetch();
    const job = await response.json();
    if (job && typeof job === 'object') job.field_confidences = { ...(job.field_confidences ?? {}), report_date: 0.1 };
    await route.fulfill({ response, json: job });
  });
}

// The first text box or number box among the fields: something safe to type into.
const editable = (page: import('@playwright/test').Page) =>
  page.locator('.field-list textarea, .field-list input[type="number"]').first();

// What the browser would do on reload or close: is leaving being questioned?
async function leavingIsGuarded(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

test('reviewSnapshot: same content is equal in any key order; a changed value or date is not', () => {
  expect(reviewSnapshot({ a: 1, b: { x: 1, y: 2 } }, '2026-10-01')).toBe(reviewSnapshot({ b: { y: 2, x: 1 }, a: 1 }, '2026-10-01'));
  expect(reviewSnapshot({ a: 1 }, null)).toBe(reviewSnapshot({ a: 1 }, null));
  expect(reviewSnapshot({ a: 1 }, null)).not.toBe(reviewSnapshot({ a: 2 }, null));
  expect(reviewSnapshot({ a: 1 }, '2026-10-01')).not.toBe(reviewSnapshot({ a: 1 }, '2026-10-02'));
  expect(reviewSnapshot({ a: [1, 2] }, null)).not.toBe(reviewSnapshot({ a: [2, 1] }, null));
  // A key that is not set counts the same as one set to undefined.
  expect(reviewSnapshot({ a: 1, b: undefined }, null)).toBe(reviewSnapshot({ a: 1 }, null));
});

test('saving corrections keeps the review screen: typed values and checked marks survive', async ({ page }) => {
  await flagServiceDate(page);
  await openIntakeReview(page);
  const flagged = await page.locator('.field.pending').count();
  expect(flagged).toBeGreaterThan(0);
  await page.locator('.field.pending').first().getByRole('button', { name: 'Mark as checked' }).click();
  await editable(page).fill('12');

  await page.click('button:has-text("Save corrections")');
  await expect(page.locator('.toast')).toHaveText('Saved');
  await expect(page.locator('.working-panel')).toHaveCount(0);
  // The mark is still there (the field did not come back flagged) and so is what was typed.
  await expect(page.locator('.field.pending')).toHaveCount(flagged - 1);
  await expect(editable(page)).toHaveValue('12');
});

test('a failed save stays on the screen with the reason and a Try again; nothing typed is lost', async ({ page }) => {
  let failNext = true;
  await page.route('**/reports/*/fields', (route) => {
    if (route.request().method() === 'PATCH' && failNext) {
      failNext = false;
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'Simulated save failure' }) });
    }
    return route.continue();
  });
  await openIntakeReview(page);
  await editable(page).fill('12');

  await page.click('button:has-text("Save corrections")');
  const error = page.locator('#save-error');
  await expect(error).toContainText('Simulated save failure');
  await expect(page.locator('.field-list')).toBeVisible();
  await expect(page.locator('button:has-text("Start over")')).toHaveCount(0);
  await expect(editable(page)).toHaveValue('12');
  await expect(page.locator('button:has-text("Save corrections")')).toBeEnabled();
  expect(await leavingIsGuarded(page)).toBe(true); // still unsaved

  await error.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.toast')).toHaveText('Saved');
  await expect(page.locator('#save-error')).toHaveCount(0);
  await expect(editable(page)).toHaveValue('12');
  expect(await leavingIsGuarded(page)).toBe(false);
});

test('a failed finalize stays on the screen, and Try again finalizes', async ({ page }) => {
  await flagServiceDate(page);
  let failNext = true;
  await page.route('**/reports/*/finalize', (route) => {
    if (failNext) {
      failNext = false;
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'Simulated finalize failure' }) });
    }
    return route.continue();
  });
  await openIntakeReview(page);
  await editable(page).fill('12');

  await finalizeFromReview(page);
  await expect(page.locator('#save-error')).toContainText('Simulated finalize failure');
  await expect(page.locator('.field-list')).toBeVisible();
  await expect(editable(page)).toHaveValue('12');

  await page.locator('#save-error').getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.success-panel')).toBeVisible({ timeout: 15_000 });
});

test('reloading or closing the page asks first only while there are unsaved edits', async ({ page }) => {
  await openIntakeReview(page);
  expect(await leavingIsGuarded(page)).toBe(false);

  await editable(page).fill('12');
  expect(await leavingIsGuarded(page)).toBe(true);

  await page.click('button:has-text("Save corrections")');
  await expect(page.locator('.toast')).toHaveText('Saved');
  expect(await leavingIsGuarded(page)).toBe(false);

  // Marking a flagged field as checked changes no value, so it is not an unsaved edit.
  const flagged = page.locator('.field.pending');
  if ((await flagged.count()) > 0) {
    await flagged.first().getByRole('button', { name: 'Mark as checked' }).click();
    expect(await leavingIsGuarded(page)).toBe(false);
  }
});

test('a saved draft: edits are guarded until saved, and saving keeps the screen', async ({ page, request }) => {
  const marker = `E2E-Guard-${Date.now()}`;
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: marker });
  await openReviewFromList(page, marker);
  expect(await leavingIsGuarded(page)).toBe(false);

  const text = page.locator('.field-list textarea').first();
  await text.fill('Edited on the saved report');
  expect(await leavingIsGuarded(page)).toBe(true);

  await page.click('button:has-text("Save corrections")');
  await expect(page.locator('.toast')).toHaveText('Saved');
  await expect(page.locator('.working-panel')).toHaveCount(0);
  await expect(text).toHaveValue('Edited on the saved report');
  expect(await leavingIsGuarded(page)).toBe(false);
});

test('a finalized report being edited: guarded until saved, then read-only again', async ({ page, request }) => {
  const marker = `E2E-GuardFinal-${Date.now()}`;
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: marker, finalize: true });
  await openReviewFromList(page, marker);
  await page.click('.review-actions button:has-text("Edit")');
  await page.locator('.field-list textarea').first().fill('Changed after finalizing');
  expect(await leavingIsGuarded(page)).toBe(true);

  await page.click('button:has-text("Save corrections")');
  await expect(page.locator('.review-actions button:has-text("Edit")')).toBeVisible({ timeout: 20_000 });
  expect(await leavingIsGuarded(page)).toBe(false);

  // Cancelling an edit throws the changes away, so there is nothing left to guard.
  await page.click('.review-actions button:has-text("Edit")');
  await page.locator('.field-list textarea').first().fill('Never saved');
  expect(await leavingIsGuarded(page)).toBe(true);
  await page.click('.review-actions button:has-text("Cancel")');
  expect(await leavingIsGuarded(page)).toBe(false);
});

// Finalizing with fields still flagged asks first (PR 2 of the review-and-finalize plan).

test('finalizing with flagged fields asks first; Review them goes to the first flagged field', async ({ page }) => {
  await flagServiceDate(page);
  await openIntakeReview(page);
  const flagged = await page.locator('.field.pending').count();
  expect(flagged).toBeGreaterThan(0);

  await page.click('button:has-text("Save & finalize report")');
  const confirm = page.locator('#finalize-confirm');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(`${flagged} field${flagged === 1 ? '' : 's'} still need${flagged === 1 ? 's' : ''} attention`);
  await expect(page.locator('.success-panel')).toHaveCount(0); // nothing was finalized yet

  await confirm.getByRole('button', { name: 'Review them' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.locator('.field-list')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest('.field')?.className ?? ''))
    .toContain('pending');
  await expect(page.locator('.field.pending')).toHaveCount(flagged); // reviewing does not check anything off
});

test('Escape closes the question, and "Finalize anyway" finalizes', async ({ page }) => {
  await flagServiceDate(page);
  await openIntakeReview(page);
  expect(await page.locator('.field.pending').count()).toBeGreaterThan(0);

  await page.click('button:has-text("Save & finalize report")');
  await expect(page.locator('#finalize-confirm')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#finalize-confirm')).toHaveCount(0);
  await expect(page.locator('.success-panel')).toHaveCount(0);

  await page.click('button:has-text("Save & finalize report")');
  await page.getByRole('button', { name: 'Finalize anyway' }).click();
  await expect(page.locator('.success-panel')).toBeVisible({ timeout: 15_000 });
});

test('with nothing flagged, finalizing goes straight through with no question', async ({ page }) => {
  await flagServiceDate(page); // flagged at first, so the check-off loop below is exercised on every run
  await openIntakeReview(page);
  // Check every flagged field off, one at a time (each press removes one from the list).
  while ((await page.locator('.field.pending').count()) > 0) {
    await page.locator('.field.pending').first().getByRole('button', { name: 'Mark as checked' }).click();
  }
  await page.click('button:has-text("Save & finalize report")');
  await expect(page.locator('#finalize-confirm')).toHaveCount(0);
  await expect(page.locator('.success-panel')).toBeVisible({ timeout: 15_000 });
});

test('finalizing twice at the API returns the report quietly, so a retry after a lost reply works', async ({ request }) => {
  const marker = `E2E-Twice-${Date.now()}`;
  const id = await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: marker, finalize: true });
  const again = await request.post(`${API_BASE}/reports/${id}/finalize`);
  expect(again.status()).toBe(200);
  expect((await again.json()).status).toBe('finalized');
});
