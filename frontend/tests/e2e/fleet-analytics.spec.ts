import { type APIRequestContext } from '@playwright/test';
import { test, expect } from './coverage';
import { uniquePdf } from './unique-upload';
import { BACKEND_PORT } from '../../playwright.config';

// The Analytics tab (GET /analytics/fleet) — a smoke check that the tab
// renders real numbers end to end through the UI. The aggregation math
// itself (parts merging by part_number, labor-hours roll-ups, pass/fail
// bucketing including missing/non-binary results) is already exhaustively
// covered by backend/tests/test_analytics.py; this only proves the frontend
// actually fetches and displays what that endpoint returns.
//
// This suite has no per-test truncation (like reports-search.spec.ts and
// field-editing.spec.ts), so other specs' seeded reports may already be
// finalized by the time this runs — assertions check that this test's own
// known values appear somewhere in the totals/charts, not exact fleet-wide
// totals, which would be flaky depending on run order.

const API_BASE = `http://localhost:${BACKEND_PORT}`;
const UNIQUE_PART_QTY = 5000;

async function seedFinalizedReport(
  request: APIRequestContext,
  opts: { model: string; reportType: string; extractedFields: Record<string, unknown> }
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

  // A real attachment + extract cycle is what moves the report into
  // "extracted" status (a prerequisite for finalize) — the stub's own
  // extracted values don't matter since the PATCH below overwrites them
  // with this test's exact, deterministic fields.
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

  await request.patch(`${API_BASE}/reports/${report.id}/fields`, { data: { extracted_fields: opts.extractedFields } });
  await request.post(`${API_BASE}/reports/${report.id}/finalize`);
  return report.id as string;
}

test('the Analytics tab shows this run\'s own labor hours, parts, and pass/fail counts', async ({ page, request }) => {
  const uniquePart = `E2E-Part-${Date.now()}`;

  await seedFinalizedReport(request, {
    model: 'FACSAria III',
    reportType: 'repair',
    extractedFields: {
      labor_hours: 4,
      fault_category: 'fluidics',
      retest_result: 'pass',
      components_replaced: [{ part_name: uniquePart, part_number: 'E2E-1', qty: UNIQUE_PART_QTY }],
    },
  });
  await seedFinalizedReport(request, {
    model: 'LSRFortessa',
    reportType: 'preventive_maintenance',
    extractedFields: { labor_hours: 2.5, verification_result: 'fail' },
  });

  await page.goto('/');
  await page.click('.view-tab:has-text("Analytics")');

  await expect(page.locator('.section-title')).toContainText('Fleet analytics');
  await expect(page.locator('.stat-tile')).toHaveCount(3, { timeout: 15_000 });

  // This run added at least 4 + 2.5 = 6.5 hours — the fleet-wide total may
  // be higher if other specs already finalized reports in this same run.
  // Polled: the tile can show its placeholder before the rollup has loaded.
  await expect
    .poll(async () => parseFloat((await page.locator('.stat-tile').nth(0).locator('.stat-value').textContent()) ?? '0'))
    .toBeGreaterThanOrEqual(6.5);

  // The uniquely-named part from this run's repair report shows up in the
  // parts chart with the right unit count. The chart lists only the top 8
  // parts by units, so this part's quantity (UNIQUE_PART_QTY) is far above
  // anything another spec seeds: with a small quantity it was pushed out of
  // the chart whenever enough other specs had already finalized reports with
  // parts (found by running the specs in a shuffled order).
  const partRow = page.locator('.bar-row', { hasText: uniquePart });
  await expect(partRow).toBeVisible();
  await expect(partRow.locator('.bar-value')).toContainText(`${UNIQUE_PART_QTY} units`);

  // Labor hours by instrument includes this run's FACSAria III report. The
  // row itself is always present (one per seeded instrument, regardless of
  // data — see AnalyticsScreen.tsx's LaborHoursByInstrumentChart), so
  // checking visibility alone would pass even if this report's hours never
  // made it into the rollup; check it doesn't show the no-hours label.
  const ariaBar = page.locator('.labor-bar', { hasText: 'FACSAria III' });
  await expect(ariaBar).toBeVisible();
  await expect(ariaBar.locator('.bar-value')).not.toHaveText('none');

  // Pass/fail section shows both report types this run touched.
  await expect(page.locator('.stack-row', { hasText: 'Malfunction / repair' })).toBeVisible();
  await expect(page.locator('.stack-row', { hasText: 'Preventive maintenance' })).toBeVisible();
});
