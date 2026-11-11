import { type APIRequestContext } from '@playwright/test';
import { test, expect } from './coverage';
import { createNumericTemplate } from './numeric-fixture';
import { seedReport, API_BASE } from './helpers/api';
import { showTrendChart } from './helpers/ui';

// The instrument detail page's trend chart (InstrumentTrendChart.tsx) — the
// real, generalized version of docs/instrument-timeline-demo.html's
// hardcoded per-detector drift mockup. Covers: the field picker populating
// from GET .../trend-fields, a number[detector] field rendering as a
// multi-series line chart with a legend, hover tooltip and table fallback,
// switching to a flat "number" field (single series, no legend, a direct
// end-value label), the single-report fallback message, and the
// no-numeric-fields-yet empty state.
//
// Every test here creates a brand-new instrument of its own, so "exactly N
// reports" is guaranteed regardless of what other specs do to the shared
// fleet: this suite has no per-test truncation, and the stub classifier gives
// other specs' uploads a hash-picked instrument and report type, so no model
// in the seeded fleet is safe to assert exact counts on.

async function createInstrument(request: APIRequestContext, marker: string): Promise<{ id: string; name: string }> {
  const instrument = await (
    await request.post(`${API_BASE}/instruments`, {
      data: { name: marker, model: marker, manufacturer: 'E2E Maker', serial_number: `SN-${marker}` },
    })
  ).json();
  await createNumericTemplate(request, marker);
  return { id: instrument.id as string, name: instrument.name as string };
}

async function openInstrumentDetail(page: import('@playwright/test').Page, instrumentId: string) {
  await page.goto('/#/new');
  await page.getByTestId('tab-reports').click();
  await page.getByLabel('Instrument', { exact: true }).selectOption(instrumentId);
  await page.click('button:has-text("View instrument details")');
  await expect(page.locator('.trend-section')).toBeVisible();
}

async function seedNumericReport(
  request: APIRequestContext,
  opts: { instrumentId: string; model: string; extractedFields: Record<string, unknown>; reportDate: string }
): Promise<void> {
  await seedReport(request, {
    instrumentId: opts.instrumentId,
    model: opts.model,
    reportType: 'installation_upgrade',
    fields: opts.extractedFields,
    reportDate: opts.reportDate,
    finalize: true,
  });
}

test('trend chart: multi-series detector map, hover tooltip, table view, and switching to a flat field', async ({
  page,
  request,
}) => {
  // Its own brand-new instrument (like the two tests below): the stub
  // classifier gives every other spec's upload a hash-picked instrument and
  // report type, so some run can finalize a report on FACSAria III and
  // an exact point count there is not guaranteed.
  const marker = `E2E-Trend-Multi-${Date.now()}`;
  const facsAria = await createInstrument(request, marker);
  const dates = ['2026-01-10', '2026-03-10', '2026-05-10', '2026-07-10'];
  const detector1 = [2.1, 2.3, 2.5, 2.7];
  const detector2 = [3.0, 3.2, 3.4, 3.6];
  const detector3 = [1.4, 1.5, 1.6, 1.7];
  const pressure = [4.9, 5.0, 5.1, 5.2]; // 5.0 is the regression case: must render "5.0 psi", not "5 psi"

  for (let i = 0; i < dates.length; i++) {
    await seedNumericReport(request, {
      instrumentId: facsAria.id,
      model: marker,
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
  await expect(picker.locator('option', { hasText: 'Baseline CV (%)' })).toHaveCount(1);
  await expect(picker.locator('option', { hasText: 'Fluidics pressure (psi)' })).toHaveCount(1);
  // Alphabetically first trendable field ("baseline_cv_percent") is selected by default.
  await expect(picker).toHaveValue('baseline_cv_percent');

  // ---- Multi-series chart: legend, one entry per detector ----
  const legend = page.locator('.legend-row');
  await expect(legend).toBeVisible();
  await expect(legend.locator('.legend-item', { hasText: 'detector 1' })).toBeVisible();
  await expect(legend.locator('.legend-item', { hasText: 'detector 2' })).toBeVisible();
  await expect(legend.locator('.legend-item', { hasText: 'detector 3' })).toBeVisible();

  // The trend opens as a table; switch to the chart for the chart checks.
  await showTrendChart(page);
  const svg = page.locator('.trend-chart-wrap svg');
  await expect(svg).toHaveAttribute('aria-label', 'Baseline CV across 4 reports');

  // ---- Hover near the last point shows a crosshair tooltip for every series ----
  const box = await svg.boundingBox();
  expect(box).not.toBeNull();
  // The chart scales with the page, so aim in chart units (640 wide, 16 of right margin), not pixels:
  // 4 units inside the plot's right edge, i.e. near the last point at any page width.
  await page.mouse.move(box!.x + box!.width * ((640 - 16 - 4) / 640), box!.y + box!.height / 2);
  const tooltip = page.locator('.trend-tooltip');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText('Jul 10');
  await expect(tooltip.locator('.trend-tooltip-row', { hasText: 'detector 1' })).toContainText('2.7%');
  await expect(tooltip.locator('.trend-tooltip-row', { hasText: 'detector 2' })).toContainText('3.6%');
  await expect(tooltip.locator('.trend-tooltip-row', { hasText: 'detector 3' })).toContainText('1.7%');

  // ---- Table view: same data, every row reachable without hovering ----
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  const table = page.locator('.trend-table');
  await expect(table.locator('th', { hasText: 'detector 1' })).toBeVisible();
  const julRow = table.locator('tr', { hasText: 'Jul 10' });
  await expect(julRow).toContainText('2.7%');
  await expect(julRow).toContainText('3.6%');
  await expect(julRow).toContainText('1.7%');
  // The table can scroll sideways, so the keyboard must be able to reach it.
  const scroller = page.getByRole('region', { name: 'Trend values, as a table' });
  await scroller.focus();
  await expect(scroller).toBeFocused();
  await page.getByRole('button', { name: 'Chart', exact: true }).click();

  // ---- Switching to a flat "number" field: single series, no legend, a direct end-value label ----
  await picker.selectOption('fluidics_pressure_psi');
  await expect(page.locator('.legend-row')).toHaveCount(0);
  await expect(svg).toHaveAttribute('aria-label', 'Fluidics pressure across 4 reports');
  await expect(page.locator('.trend-end-label')).toContainText('5.2 psi');

  // Regression check: a whole-number reading (5.0) must not lose its
  // trailing zero next to 5.1/5.2 in the same column.
  await page.getByRole('button', { name: 'Table', exact: true }).click();
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
  await seedNumericReport(request, {
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

  // With no numeric field the picker still offers the work dates, and with no report there is nothing to show.
  await expect(page.locator('[aria-label="Field to chart"]')).toHaveValue('__work_dates__');
  await expect(page.locator('.trend-section')).toContainText('No report with a work date yet');
});

test('trend: "Work dates (timeline)" lists the dates of work as a table and draws them on a timeline', async ({ page, request }) => {
  const marker = `E2E-Trend-Dates-${Date.now()}`;
  const instrument = await createInstrument(request, marker);
  for (const [reportDate, reportType] of [
    ['2026-01-10', 'installation_upgrade'],
    ['2026-03-05', 'preventive_maintenance'],
    ['2026-03-05', 'repair'],
    ['2026-06-20', 'repair'],
  ] as const) {
    await seedReport(request, { instrumentId: instrument.id, model: marker, reportType, reportDate, fields: {}, finalize: true });
  }

  await openInstrumentDetail(page, instrument.id);
  await page.locator('[aria-label="Field to chart"]').selectOption('__work_dates__');

  // It opens as a table, oldest first.
  const rows = page.locator('.trend-table tbody tr');
  await expect(rows).toHaveCount(4);
  await expect(rows.first()).toContainText('Jan 10, 2026');
  await expect(rows.first()).toContainText('Installation / upgrade');
  await expect(rows.last()).toContainText('Jun 20, 2026');

  // One marker per report, two of them on the same day, and a legend entry per report type.
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await expect(page.getByTestId('timeline-dot')).toHaveCount(4);
  await expect(page.locator('.legend-row .legend-item')).toHaveCount(3);
});

test('timeline: ticks sit on round dates, and a dot opens a card with an Open link', async ({ page, request }) => {
  const marker = `E2E-Timeline-Card-${Date.now()}`;
  const instrument = await createInstrument(request, marker);
  for (const [reportDate, reportType] of [
    ['2024-02-27', 'repair'],
    ['2025-09-02', 'preventive_maintenance'],
    ['2025-09-08', 'installation_upgrade'],
  ] as const) {
    await seedReport(request, { instrumentId: instrument.id, model: marker, reportType, reportDate, fields: {}, finalize: true });
  }

  await openInstrumentDetail(page, instrument.id);
  await page.locator('[aria-label="Field to chart"]').selectOption('__work_dates__');
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();

  // Regular, round labels (years here), never the padded edge dates of the data.
  const ticks = page.getByTestId('timeline-tick');
  await expect(ticks.first()).toHaveText(/^\d{4}$/);

  // A tap on a dot shows a card first; its Open link goes to that report.
  const dots = page.getByTestId('timeline-dot');
  await expect(dots).toHaveCount(3);
  await dots.last().click();
  const card = page.getByTestId('timeline-card');
  await expect(card).toContainText('Sep 8, 2025');
  await expect(card).toContainText('Installation / upgrade');
  await expect(card.getByTestId('timeline-open')).toHaveAttribute('href', /#\/reports\/.+/);

  // Escape closes it; the keyboard opens it again.
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await dots.first().focus();
  await page.keyboard.press('Enter');
  await expect(card).toContainText('Feb 27, 2024');
});

test('timeline: zoom in separates close dots, and Reset brings every report back', async ({ page, request }) => {
  const marker = `E2E-Timeline-Zoom-${Date.now()}`;
  const instrument = await createInstrument(request, marker);
  for (const reportDate of ['2023-01-10', '2025-09-02', '2025-09-08']) {
    await seedReport(request, { instrumentId: instrument.id, model: marker, reportType: 'repair', reportDate, fields: {}, finalize: true });
  }

  await openInstrumentDetail(page, instrument.id);
  await page.locator('[aria-label="Field to chart"]').selectOption('__work_dates__');
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();

  const dots = page.getByTestId('timeline-dot');
  await expect(dots).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Zoom out' })).toBeDisabled();

  // Zoomed in on the middle of the range, the 2023 report falls outside the window.
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(dots).toHaveCount(2);

  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(dots).toHaveCount(3);
});

test('reports list: a Trend link opens the instrument page with the Trend section', async ({ page, request }) => {
  const marker = `E2E-Trend-Link-${Date.now()}`;
  const instrument = await createInstrument(request, marker);
  await seedReport(request, { instrumentId: instrument.id, model: marker, reportType: 'repair', reportDate: '2026-02-01', fields: {}, finalize: true });

  await page.goto('/#/reports');
  const group = page.getByTestId('report-group').filter({ hasText: marker });
  await group.getByTestId('group-trend-link').click();
  await expect(page).toHaveURL(new RegExp(`#/reports/instrument/${instrument.id}/trend$`));
  await expect(page.getByTestId('trend-section')).toBeVisible();

  // The instruments tab has the same shortcut.
  await page.getByTestId('tab-instruments').click();
  await page.getByTestId('instrument-row').filter({ hasText: marker }).getByTestId('instrument-trend-link').click();
  await expect(page.getByTestId('trend-section')).toBeVisible();
});
