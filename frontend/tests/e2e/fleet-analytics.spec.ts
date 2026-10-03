import { type APIRequestContext } from '@playwright/test';
import { test, expect } from './coverage';
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
      multipart: { file: { name: 'seed.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 seed') } },
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
      components_replaced: [{ part_name: uniquePart, part_number: 'E2E-1', qty: 3 }],
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
  const totalHoursText = await page.locator('.stat-tile').nth(0).locator('.stat-value').textContent();
  const totalHours = parseFloat(totalHoursText ?? '0');
  expect(totalHours).toBeGreaterThanOrEqual(6.5);

  // The uniquely-named part from this run's repair report shows up in the
  // parts chart with the right unit count.
  const partRow = page.locator('.bar-row', { hasText: uniquePart });
  await expect(partRow).toBeVisible();
  await expect(partRow.locator('.bar-value')).toContainText('3 units');

  // Labor hours by instrument includes this run's FACSAria III report. The
  // row itself is always present (one per seeded instrument, regardless of
  // data — see AnalyticsScreen.tsx's LaborHoursByInstrumentChart), so
  // checking visibility alone would pass even if this report's hours never
  // made it into the rollup; check it doesn't show the zero-reports label.
  const ariaRow = page.locator('.bar-row', { hasText: 'FACSAria III' });
  await expect(ariaRow).toBeVisible();
  await expect(ariaRow.locator('.bar-value')).not.toHaveText('No repair/PM reports yet');

  // Pass/fail section shows both report types this run touched.
  await expect(page.locator('.stack-row', { hasText: 'Malfunction / repair' })).toBeVisible();
  await expect(page.locator('.stack-row', { hasText: 'Preventive maintenance' })).toBeVisible();
});
