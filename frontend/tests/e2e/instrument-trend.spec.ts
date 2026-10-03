import { type APIRequestContext } from '@playwright/test';
import { test, expect } from './coverage';
import { BACKEND_PORT } from '../../playwright.config';

// The instrument detail page's trend chart (InstrumentTrendChart.tsx) — the
// real, generalized version of docs/instrument-timeline-demo.html's
// hardcoded per-detector drift mockup. Covers: the field picker populating
// from GET .../trend-fields, a number[detector] field rendering as a
// multi-series line chart with a legend, hover tooltip and table fallback,
// switching to a flat "number" field (single series, no legend, a direct
// end-value label), the single-report fallback message, and the
// no-numeric-fields-yet empty state.
//
// The multi-report test seeds calibration reports for FACSAria III — no
// other spec in this suite finalizes a *calibration* report for that model
// (only 'repair', in instrument-detail.spec.ts / fleet-analytics.spec.ts),
// so exact point counts and values are safe to assert here despite this
// suite having no per-test truncation. The single-point and empty-state
// tests instead create a brand-new instrument each, so "exactly one
// report" / "exactly zero reports" is guaranteed regardless of what other
// specs are doing concurrently to the shared fleet.

const API_BASE = `http://localhost:${BACKEND_PORT}`;

async function seedCalibrationReport(
  request: APIRequestContext,
  opts: { instrumentId: string; model: string; extractedFields: Record<string, unknown>; reportDate: string }
): Promise<void> {
  const report = await (await request.post(`${API_BASE}/reports`, { data: {} })).json();
  const templates = await (
    await request.get(`${API_BASE}/report-templates`, { params: { report_type: 'calibration', model: opts.model } })
  ).json();
  await request.patch(`${API_BASE}/reports/${report.id}/template`, {
    data: { instrument_id: opts.instrumentId, template_id: templates[0].id },
  });
  const attachment = await (
    await request.post(`${API_BASE}/reports/${report.id}/attachments`, {
      multipart: { file: { name: 'seed.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 seed') } },
    })
  ).json();
  const job = await (await request.post(`${API_BASE}/attachments/${attachment.id}/extract`)).json();
  for (let waited = 0; waited < 30_000; waited += 200) {
    const polled = await (await request.get(`${API_BASE}/extraction-jobs/${job.id}`)).json();
    if (polled.status === 'succeeded' || polled.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await request.patch(`${API_BASE}/reports/${report.id}/fields`, {
    data: { extracted_fields: opts.extractedFields, report_date: opts.reportDate },
  });
  await request.post(`${API_BASE}/reports/${report.id}/finalize`);
}

async function createInstrument(request: APIRequestContext, marker: string): Promise<{ id: string; name: string }> {
  const instrument = await (
    await request.post(`${API_BASE}/instruments`, {
      data: { name: marker, model: marker, serial_number: `SN-${marker}` },
    })
  ).json();
  return { id: instrument.id as string, name: instrument.name as string };
}

async function openInstrumentDetail(page: import('@playwright/test').Page, instrumentId: string) {
  await page.goto('/');
  await page.click('.view-tab:has-text("Reports")');
  await page.locator('.filter-row select').first().selectOption(instrumentId);
  await page.click('button:has-text("View instrument details")');
  await expect(page.locator('.trend-section')).toBeVisible();
}

test('trend chart: multi-series detector map, hover tooltip, table view, and switching to a flat field', async ({
  page,
  request,
}) => {
  const instruments = await (await request.get(`${API_BASE}/instruments`)).json();
  const facsAria = instruments.find((i: { model: string; id: string }) => i.model === 'FACSAria III');
  const dates = ['2026-01-10', '2026-03-10', '2026-05-10', '2026-07-10'];
  const detector1 = [2.1, 2.3, 2.5, 2.7];
  const detector2 = [3.0, 3.2, 3.4, 3.6];
  const detector3 = [1.4, 1.5, 1.6, 1.7];
  const pressure = [4.9, 5.0, 5.1, 5.2]; // 5.0 is the regression case: must render "5.0 psi", not "5 psi"

  for (let i = 0; i < dates.length; i++) {
    await seedCalibrationReport(request, {
      instrumentId: facsAria.id,
      model: 'FACSAria III',
      reportDate: dates[i],
      extractedFields: {
        baseline_cv_percent: { detector_1: detector1[i], detector_2: detector2[i], detector_3: detector3[i] },
        fluidics_pressure_psi: pressure[i],
      },
    });
  }

  await openInstrumentDetail(page, facsAria.id);

  // ---- Field picker ----
  const picker = page.locator('[aria-label="Field to chart"]');
  await expect(picker).toBeVisible();
  await expect(picker.locator('option', { hasText: 'baseline cv percent (%)' })).toHaveCount(1);
  await expect(picker.locator('option', { hasText: 'fluidics pressure psi (psi)' })).toHaveCount(1);
  // Alphabetically first trendable field ("baseline_cv_percent") is selected by default.
  await expect(picker).toHaveValue('baseline_cv_percent');

  // ---- Multi-series chart: legend, one entry per detector ----
  const legend = page.locator('.legend-row');
  await expect(legend).toBeVisible();
  await expect(legend.locator('.legend-item', { hasText: 'detector 1' })).toBeVisible();
  await expect(legend.locator('.legend-item', { hasText: 'detector 2' })).toBeVisible();
  await expect(legend.locator('.legend-item', { hasText: 'detector 3' })).toBeVisible();

  const svg = page.locator('.trend-chart-wrap svg');
  await expect(svg).toHaveAttribute('aria-label', 'baseline cv percent across 4 reports');

  // ---- Hover near the last point shows a crosshair tooltip for every series ----
  const box = await svg.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width - 20, box!.y + box!.height / 2);
  const tooltip = page.locator('.trend-tooltip');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText('Jul 10');
  await expect(tooltip.locator('.trend-tooltip-row', { hasText: 'detector 1' })).toContainText('2.7%');
  await expect(tooltip.locator('.trend-tooltip-row', { hasText: 'detector 2' })).toContainText('3.6%');
  await expect(tooltip.locator('.trend-tooltip-row', { hasText: 'detector 3' })).toContainText('1.7%');

  // ---- Table view: same data, every row reachable without hovering ----
  await page.click('button:has-text("View as table")');
  const table = page.locator('.trend-table');
  await expect(table.locator('th', { hasText: 'detector 1' })).toBeVisible();
  const julRow = table.locator('tr', { hasText: 'Jul 10' });
  await expect(julRow).toContainText('2.7%');
  await expect(julRow).toContainText('3.6%');
  await expect(julRow).toContainText('1.7%');
  await page.click('button:has-text("Hide table")');

  // ---- Switching to a flat "number" field: single series, no legend, a direct end-value label ----
  await picker.selectOption('fluidics_pressure_psi');
  await expect(page.locator('.legend-row')).toHaveCount(0);
  await expect(svg).toHaveAttribute('aria-label', 'fluidics pressure psi across 4 reports');
  await expect(page.locator('.trend-end-label')).toContainText('5.2 psi');

  // Regression check: a whole-number reading (5.0) must not lose its
  // trailing zero next to 5.1/5.2 in the same column.
  await page.click('button:has-text("View as table")');
  const marRow = page.locator('.trend-table tr', { hasText: 'Mar 10' });
  await expect(marRow).toContainText('5.0 psi');
  await expect(marRow).not.toContainText('5 psi');
});

test('trend chart: a single finalized report shows the "needs at least two" fallback, not a chart', async ({
  page,
  request,
}) => {
  const marker = `E2E-Trend-Single-${Date.now()}`;
  const instrument = await createInstrument(request, marker);
  await seedCalibrationReport(request, {
    instrumentId: instrument.id,
    model: marker,
    reportDate: '2026-06-01',
    extractedFields: { baseline_cv_percent: { detector_1: 4.2 }, fluidics_pressure_psi: 6.3 },
  });

  await openInstrumentDetail(page, instrument.id);

  const single = page.locator('.trend-single-point');
  await expect(single).toBeVisible();
  await expect(single).toContainText('detector_1: 4.2%');
  await expect(single).toContainText('Only one report');
  await expect(single).toContainText('Jun 1');
  await expect(page.locator('.trend-chart-wrap')).toHaveCount(0);

  await page.locator('[aria-label="Field to chart"]').selectOption('fluidics_pressure_psi');
  await expect(single).toContainText('6.3 psi');
});

test('trend chart: an instrument with no finalized reports shows the empty state', async ({ page, request }) => {
  const marker = `E2E-Trend-Empty-${Date.now()}`;
  const instrument = await createInstrument(request, marker);

  await openInstrumentDetail(page, instrument.id);

  await expect(page.locator('.trend-section')).toContainText('No numeric fields have recorded data yet');
});
