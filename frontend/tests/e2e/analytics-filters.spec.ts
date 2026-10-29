import { type APIRequestContext, type Page } from '@playwright/test';
import { test, expect } from './coverage';
import { uniquePdf } from './unique-upload';
import { BACKEND_PORT } from '../../playwright.config';
import { TIMEOUT } from './timeouts';

// The filter bar on the Analytics tab (instrument, report type, date range),
// which applies to the whole page. The filtering itself is covered by
// backend/tests/test_analytics_filters.py; this proves the controls are wired
// to it and that the page keeps working while figures refresh.
//
// Two finalized reports with unique, huge-quantity parts in a year no other
// spec uses (2001), so a date range isolates them from whatever else this
// run has already finalized.

const API_BASE = `http://localhost:${BACKEND_PORT}`;
const QTY = 7000;

async function seedFinalizedReport(
  request: APIRequestContext,
  opts: { model: string; reportType: string; reportDate: string; fields: Record<string, unknown> }
): Promise<string> {
  const report = await (await request.post(`${API_BASE}/reports`, { data: {} })).json();
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
  for (let waited = 0; waited < 30_000; waited += 200) {
    const polled = await (await request.get(`${API_BASE}/extraction-jobs/${job.id}`)).json();
    if (polled.status === 'succeeded' || polled.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await request.patch(`${API_BASE}/reports/${report.id}/fields`, {
    data: { extracted_fields: opts.fields, report_date: opts.reportDate },
  });
  await request.post(`${API_BASE}/reports/${report.id}/finalize`);
  return instrument.id as string;
}

async function openAnalytics(page: Page) {
  await page.goto('/');
  await page.click('.view-tab:has-text("Analytics")');
  await expect(page.getByTestId('analytics-filters')).toBeVisible({ timeout: TIMEOUT.ui });
}

test('the filters narrow the whole Analytics page and can be cleared', async ({ page, request }) => {
  const repairPart = `E2E-Filter-Repair-${Date.now()}`;
  const pmPart = `E2E-Filter-PM-${Date.now()}`;
  const ariaId = await seedFinalizedReport(request, {
    model: 'FACSAria III',
    reportType: 'repair',
    reportDate: '2001-03-01',
    fields: { labor_hours: 4, components_replaced: [{ part_name: repairPart, part_number: 'F-1', qty: QTY }] },
  });
  await seedFinalizedReport(request, {
    model: 'LSRFortessa',
    reportType: 'preventive_maintenance',
    reportDate: '2001-05-01',
    fields: { labor_hours: 2.5, components_replaced: [{ part_name: pmPart, part_number: 'F-2', qty: QTY + 1 }] },
  });

  await openAnalytics(page);
  const filters = page.getByTestId('analytics-filters');
  const part = (name: string) => page.locator('.bar-row', { hasText: name });
  const basis = page.getByTestId('analytics-basis');

  // A date range around 2001 isolates this test's two reports.
  await filters.getByLabel('From date').fill('2001-01-01');
  await filters.getByLabel('To date').fill('2001-12-31');
  await expect(basis).toContainText('Based on 2 finalized reports matching the filters');
  await expect(part(repairPart)).toBeVisible();
  await expect(part(pmPart)).toBeVisible();
  await expect(page.locator('.stat-tile').nth(0).locator('.stat-value')).toHaveText('6.5h');
  // The filter bar stayed on the page through the reload.
  await expect(filters).toBeVisible();

  // Report type.
  await filters.getByLabel('Report type').selectOption({ label: 'Preventive maintenance' });
  await expect(basis).toContainText('Based on 1 finalized report matching the filters');
  await expect(part(pmPart)).toBeVisible();
  await expect(part(repairPart)).toHaveCount(0);
  await expect(page.locator('.stat-tile').nth(0).locator('.stat-value')).toHaveText('2.5h');

  // Instrument: the repair report belongs to a FACSAria III, so with the PM type still set nothing matches.
  await filters.getByLabel('Instrument').selectOption(ariaId);
  await expect(page.getByText('No finalized reports match these filters.')).toBeVisible();
  await expect(basis).toContainText('Based on 0 finalized reports');

  // Back to repair: only the Aria's report, and the comparison lists just the chosen unit.
  await filters.getByLabel('Report type').selectOption({ label: 'Malfunction / repair' });
  await expect(part(repairPart)).toBeVisible();
  await expect(part(pmPart)).toHaveCount(0);
  await expect(page.locator('.labor-bar', { hasText: 'FACSAria III' }).first()).toBeVisible();

  // Dates the wrong way round are explained instead of sent to the server.
  await filters.getByLabel('From date').fill('2002-01-01');
  await expect(page.getByText('The "from" date is after the "to" date.')).toBeVisible();
  await filters.getByLabel('From date').fill('2001-01-01');
  await expect(part(repairPart)).toBeVisible();

  // Clear filters puts everything back.
  await filters.getByRole('button', { name: 'Clear filters' }).click();
  await expect(filters.getByLabel('Instrument')).toHaveValue('');
  await expect(filters.getByLabel('Report type')).toHaveValue('');
  await expect(filters.getByLabel('From date')).toHaveValue('');
  await expect(basis).not.toContainText('matching the filters');
  await expect(part(repairPart)).toBeVisible();
  await expect(part(pmPart)).toBeVisible();
});

test('the model comparison follows the filters too', async ({ page, request }) => {
  await seedFinalizedReport(request, {
    model: 'LSRFortessa',
    reportType: 'preventive_maintenance',
    reportDate: '2001-07-01',
    fields: { labor_hours: 3 },
  });
  await openAnalytics(page);
  const filters = page.getByTestId('analytics-filters');
  const table = page.locator('#model-comparison .compare-table');

  await filters.getByLabel('From date').fill('2090-01-01');
  await expect(page.getByText('No finalized reports match these filters.')).toBeVisible();
  // Units stay listed, every one at zero reports.
  const counts = table.locator('tbody tr td:nth-child(3)');
  await expect(counts.first()).toHaveText('0');
  for (const text of await counts.allTextContents()) expect(text).toBe('0');
});

test('the manufacturer filter limits the page to that maker and the instrument list follows it', async ({ page, request }) => {
  const instruments = await (await request.get(`${API_BASE}/instruments`)).json();
  const makers: string[] = Array.from(new Set(instruments.map((i: { manufacturer: string | null }) => i.manufacturer?.trim()).filter(Boolean)));
  // The seeded fleet has BD, Cytek and Beckman Coulter units, so this holds on every run.
  expect(makers.length, 'the seeded fleet has instruments from several manufacturers').toBeGreaterThan(1);
  const [maker] = makers;
  const ofMaker = instruments.filter((i: { manufacturer: string | null }) => i.manufacturer?.trim() === maker);

  await openAnalytics(page);
  const filters = page.getByTestId('analytics-filters');
  await filters.getByLabel('Manufacturer').selectOption(maker);

  // Only that maker's units are listed in the labor-by-instrument chart...
  await expect(page.getByTestId('analytics-basis')).toContainText('matching the filters');
  const section = page.locator('.chart-section', { hasText: 'Labor hours by instrument' });
  await expect(section.locator('.labor-bar')).toHaveCount(ofMaker.length);
  // ...and in the instrument dropdown (plus its "All" entry).
  await expect(filters.getByLabel('Instrument').locator('option')).toHaveCount(ofMaker.length + 1);

  // Choosing a maker the selected instrument is not from clears that instrument.
  await filters.getByLabel('Manufacturer').selectOption('');
  await filters.getByLabel('Instrument').selectOption(ofMaker[0].id);
  const other = makers.find((m) => m !== maker)!;
  await filters.getByLabel('Manufacturer').selectOption(other);
  await expect(filters.getByLabel('Instrument')).toHaveValue('');
});
