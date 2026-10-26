import { type APIRequestContext, type Page } from '@playwright/test';
import { test, expect } from './coverage';
import { uniquePdf } from './unique-upload';
import { createNumericTemplate } from './numeric-fixture';
import { BACKEND_PORT } from '../../playwright.config';

// Phone review of 2026-10-25 (Galaxy A55, 412 x 915): bugs and filter defaults.

const API_BASE = `http://localhost:${BACKEND_PORT}`;
const PHONE = { width: 412, height: 915 };

async function seedFinalized(
  request: APIRequestContext,
  opts: { instrumentId: string; model: string; fields: Record<string, unknown>; reportDate: string }
): Promise<string> {
  const report = await (await request.post(`${API_BASE}/reports`, { data: {} })).json();
  const templates = await (
    await request.get(`${API_BASE}/report-templates`, { params: { report_type: 'installation_upgrade', model: opts.model } })
  ).json();
  await request.patch(`${API_BASE}/reports/${report.id}/template`, {
    data: { instrument_id: opts.instrumentId, template_id: templates[0].id },
  });
  const attachment = await (
    await request.post(`${API_BASE}/reports/${report.id}/attachments`, {
      multipart: { file: { name: 'seed.pdf', mimeType: 'application/pdf', buffer: uniquePdf('%PDF-1.4 phone') } },
    })
  ).json();
  const job = await (await request.post(`${API_BASE}/attachments/${attachment.id}/extract`)).json();
  for (let waited = 0; waited < 30_000; waited += 200) {
    const polled = await (await request.get(`${API_BASE}/extraction-jobs/${job.id}`)).json();
    if (polled.status === 'succeeded' || polled.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await request.patch(`${API_BASE}/reports/${report.id}/fields`, {
    data: { extracted_fields: opts.fields, report_date: opts.reportDate },
  });
  await request.post(`${API_BASE}/reports/${report.id}/finalize`);
  return report.id as string;
}

async function newInstrument(request: APIRequestContext, marker: string): Promise<string> {
  const res = await request.post(`${API_BASE}/instruments`, {
    data: { name: marker, model: marker, manufacturer: 'E2E Maker', serial_number: `SN-${marker}` },
  });
  expect(res.status()).toBe(201);
  await createNumericTemplate(request, marker);
  return (await res.json()).id as string;
}

async function openInstrument(page: Page, instrumentId: string) {
  await page.goto('/');
  await page.click('.view-tab:has-text("Reports")');
  const bar = page.locator('button:has-text("Show filters")');
  if (await bar.count()) await bar.click();
  await page.locator('.filter-row select').first().selectOption(instrumentId);
  await page.click('button:has-text("View instrument details")');
}

test.describe('filters on a phone', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test('Reports and Analytics start with the filters folded, and From / To are labelled when opened', async ({ page }) => {
    for (const tab of ['reports', 'analytics']) {
      await page.goto(`/#/${tab}`);
      await expect(page.locator('.filters-summary-text')).toHaveText('No filters', { timeout: 15_000 });
      await expect(page.getByLabel('Lab manager', { exact: true })).toHaveCount(0);
    }
    await page.goto('/#/reports');
    await page.click('button:has-text("Show filters")');
    const labels = page.locator('.date-pair-label');
    await expect(labels).toHaveText(['From', 'To']);
    await expect(labels.first()).toBeVisible();
  });

  test('a choice made on the phone is kept: opened stays opened after a reload', async ({ page }) => {
    await page.goto('/#/reports');
    await page.click('button:has-text("Show filters")');
    await page.reload();
    await expect(page.getByLabel('Lab manager', { exact: true })).toBeVisible();
  });
});

test('on a wide screen the filters still start open and the From / To captions are not shown', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/#/reports');
  await expect(page.getByLabel('Lab manager', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.date-pair-label').first()).toBeHidden();
});

test.describe('a finalized report on a phone', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test('the date is drawn once and a long text is shown whole', async ({ page, request }) => {
    const marker = `E2E-Phone-Read-${Date.now()}`;
    const instrumentId = await newInstrument(request, marker);
    const longText = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of a long maintenance narrative`).join(' ');
    const reportId = await seedFinalized(request, {
      instrumentId,
      model: marker,
      fields: { cst_beads_lot: longText },
      reportDate: '2026-09-08',
    });
    await page.goto(`/#/reports/${reportId}`);
    await expect(page.locator('.field-list.read-only').first()).toBeVisible({ timeout: 15_000 });

    // The browser's own date box stays invisible, so only the app's YYYY-MM-DD text shows.
    const native = page.locator('.date-input-native').first();
    expect(await native.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
    await expect(page.locator('.date-input input[type="text"]').first()).toHaveValue('2026-09-08');

    // Nothing is cut off: the box is as tall as its text.
    const box = page.locator('.field-list.read-only textarea').first();
    await expect(box).toHaveValue(longText);
    const { scroll, client } = await box.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
    expect(scroll).toBeLessThanOrEqual(client + 1);
    expect(client).toBeGreaterThan(100);

    // Editing brings the normal, resizable box back.
    await page.click('button:has-text("Edit")');
    const editBox = page.locator('.field-list textarea').first();
    const editHeight = await editBox.evaluate((el) => el.clientHeight);
    expect(editHeight).toBeLessThan(client);
  });
});

test.describe('the instrument page on a phone', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test('the date in the "Most recent activity" tile stays on one line', async ({ page, request }) => {
    const marker = `E2E-Phone-Tile-${Date.now()}`;
    const instrumentId = await newInstrument(request, marker);
    await seedFinalized(request, { instrumentId, model: marker, fields: { fluidics_pressure_psi: 6 }, reportDate: '2026-10-25' });
    await openInstrument(page, instrumentId);
    const tile = page.locator('.stat-tile', { hasText: 'Most recent activity' }).locator('.stat-value');
    await expect(tile).toContainText('2026-10-25');
    // One line, whatever the font: all the text's pieces share the same top edge.
    const lines = await tile.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
    });
    expect(lines).toBe(1);
  });
});

for (const [name, first, second, below] of [
  ['falls into', 10, 6, true],
  ['rises into', 6, 10, false],
] as const) {
  test(`trend chart: the end label is not on the line when the line ${name} the last point`, async ({ page, request }) => {
    const marker = `E2E-Phone-Label-${name.replace(' ', '')}-${Date.now()}`;
    const instrumentId = await newInstrument(request, marker);
    await seedFinalized(request, { instrumentId, model: marker, fields: { fluidics_pressure_psi: first }, reportDate: '2026-05-01' });
    await seedFinalized(request, { instrumentId, model: marker, fields: { fluidics_pressure_psi: second }, reportDate: '2026-06-01' });
    await openInstrument(page, instrumentId);
    await page.locator('[aria-label="Field to chart"]').selectOption('fluidics_pressure_psi');
    const label = page.locator('.trend-end-label');
    await expect(label).toBeVisible();
    const lastDot = page.locator('.trend-chart-wrap svg circle').last();
    const [l, d] = await Promise.all([label.boundingBox(), lastDot.boundingBox()]);
    const labelMid = l!.y + l!.height / 2;
    const dotMid = d!.y + d!.height / 2;
    if (below) expect(labelMid).toBeGreaterThan(dotMid);
    else expect(labelMid).toBeLessThan(dotMid);
  });
}

test('a table that scrolls sideways shows soft edges (a hint that there is more)', async ({ page, request }) => {
  const marker = `E2E-Phone-Hint-${Date.now()}`;
  const instrumentId = await newInstrument(request, marker);
  await seedFinalized(request, { instrumentId, model: marker, fields: { fluidics_pressure_psi: 5 }, reportDate: '2026-05-01' });
  await seedFinalized(request, { instrumentId, model: marker, fields: { fluidics_pressure_psi: 6 }, reportDate: '2026-06-01' });
  await openInstrument(page, instrumentId);
  await page.click('button:has-text("View as table")');
  const wrap = page.locator('.trend-table-wrap').first();
  await expect(wrap).toBeVisible();
  expect(await wrap.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain('gradient');
});
