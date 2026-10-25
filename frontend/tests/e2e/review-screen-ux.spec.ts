import { type APIRequestContext } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './coverage';
import { uniqueFixture, uniquePdf } from './unique-upload';
import { fieldLabel } from '../../src/fieldLabels';
import { BACKEND_PORT } from '../../playwright.config';
import { createNumericModel } from './numeric-fixture';

// The review screen as the 2026-10-24 UI review asked for it: the scan beside the fields, an action
// bar that stays in view, readable field names, a finalized report that is read-only until Edit,
// and the parts table readable on a phone.

const API_BASE = `http://localhost:${BACKEND_PORT}`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function seedReport(
  request: APIRequestContext,
  opts: { model: string; reportType: string; technician: string; finalize?: boolean }
): Promise<string> {
  const report = await (await request.post(`${API_BASE}/reports`, { data: { technician_name: opts.technician } })).json();
  const instruments = await (await request.get(`${API_BASE}/instruments`)).json();
  const instrument = instruments.find((i: { model: string }) => i.model === opts.model);
  const templates = await (
    await request.get(`${API_BASE}/report-templates`, { params: { report_type: opts.reportType, model: opts.model } })
  ).json();
  await request.patch(`${API_BASE}/reports/${report.id}/template`, {
    data: { instrument_id: instrument.id, template_id: templates[0].id },
  });
  const attachment = await (
    await request.post(`${API_BASE}/reports/${report.id}/attachments`, {
      multipart: { file: { name: 'seed.pdf', mimeType: 'application/pdf', buffer: uniquePdf('%PDF-1.4 seed') } },
    })
  ).json();
  const job = await (await request.post(`${API_BASE}/attachments/${attachment.id}/extract`)).json();
  for (let i = 0; i < 150; i++) {
    const j = await (await request.get(`${API_BASE}/extraction-jobs/${job.id}`)).json();
    if (j.status === 'succeeded' || j.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (opts.finalize) await request.post(`${API_BASE}/reports/${report.id}/finalize`);
  return report.id as string;
}

async function openFromList(page: import('@playwright/test').Page, marker: string) {
  await page.goto('/');
  await page.click('.view-tab:has-text("Reports")');
  await page.waitForSelector('.report-table');
  await page.click(`.report-row-body:has-text("${marker}")`);
  await expect(page.locator('.field-list')).toBeVisible({ timeout: 15_000 });
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
  await openFromList(page, marker);
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
    await openFromList(page, marker);

    const scan = page.locator('.review-scan');
    await expect(scan).toBeVisible();
    await expect(scan.locator('iframe')).toHaveAttribute('src', /\/attachments\/.+\/file\?inline=1/);
    const [scanBox, listBox] = await Promise.all([scan.boundingBox(), page.locator('.field-list').boundingBox()]);
    expect(scanBox!.x + scanBox!.width).toBeLessThanOrEqual(listBox!.x);

    await page.click('button:has-text("Hide scan")');
    await expect(scan).toHaveCount(0);
    await page.reload();
    await page.click('.view-tab:has-text("Reports")');
    await page.click(`.report-row-body:has-text("${marker}")`);
    await expect(page.locator('.field-list')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.review-scan')).toHaveCount(0);
    await page.click('button:has-text("Show scan")');
    await expect(page.locator('.review-scan')).toBeVisible();
  });

  test('narrow screen: no scan pane, just the link', async ({ page, request }) => {
    const marker = `E2E-ScanNarrow-${Date.now()}`;
    await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: marker });
    await page.setViewportSize({ width: 900, height: 900 });
    await openFromList(page, marker);
    await expect(page.locator('.review-scan')).toHaveCount(0);
    await expect(page.locator('a:has-text("View original scan")')).toBeVisible();
    await expect(page.locator('button:has-text("Hide scan")')).toHaveCount(0);
  });
});

test('the action bar stays in view while a long form scrolls', async ({ page, request }) => {
  const marker = `E2E-Sticky-${Date.now()}`;
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: marker });
  await page.setViewportSize({ width: 1000, height: 500 });
  await openFromList(page, marker);
  const bar = page.locator('.review-actions');
  const box = await bar.boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(500);
  await expect(page.locator('button:has-text("Save corrections")')).toBeInViewport();
});

test('"Next" jumps to the fields that need attention', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles(uniqueFixture(path.join(__dirname, 'fixtures', 'confident-scan.pdf')));
  await page.click('button:has-text("Upload & classify")');
  await page.waitForSelector('.field-list', { timeout: 30_000 });
  const flagged = page.locator('.field.pending');
  const n = await flagged.count();
  test.skip(n === 0, 'the stub flagged nothing on this run');
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
  await openFromList(page, marker);

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
  // Below 1100px the scan pane is gone and the fields use the full width, so the two edges compare directly.
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles(uniqueFixture(path.join(__dirname, 'fixtures', 'confident-scan.pdf')));
  await page.click('button:has-text("Upload & classify")');
  await page.waitForSelector('.field-list', { timeout: 30_000 });
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
  await openFromList(page, marker);
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
  await openFromList(page, marker);
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
