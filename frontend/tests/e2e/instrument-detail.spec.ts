import { test, expect, type APIRequestContext } from '@playwright/test';
import { BACKEND_PORT } from '../../playwright.config';

// The instrument detail page (App.tsx's InstrumentDetailScreen) — reached
// from the Reports tab's instrument filter via "View instrument details",
// and from a report's own detail view via "View instrument: ...". Neither
// path existed before this: GET /instruments/{id}/trend and
// docs/instrument-timeline-demo.html were the only prior hints this screen
// should exist, and nothing wired either into the running app.
//
// This suite has no per-test truncation, so a unique technician marker
// identifies this test's own seeded report regardless of what other specs
// (or earlier runs of this one) left behind on the fixed 3-instrument fleet
// — assertions check that this run's report appears, not exact fleet-wide
// counts, which would be flaky depending on run order.

const API_BASE = `http://localhost:${BACKEND_PORT}`;

async function seedFinalizedReport(
  request: APIRequestContext,
  opts: { model: string; reportType: string; technician: string; extractedFields: Record<string, unknown> }
): Promise<{ reportId: string; instrumentId: string }> {
  const report = await (
    await request.post(`${API_BASE}/reports`, { data: { technician_name: opts.technician } })
  ).json();
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
  return { reportId: report.id as string, instrumentId: instrument.id as string };
}

test('instrument detail page: reached from the reports filter, shows history, and nav stack unwinds correctly', async ({
  page,
  request,
}) => {
  const technician = `E2E-Tech-${Date.now()}`;
  const { instrumentId } = await seedFinalizedReport(request, {
    model: 'FACSAria III',
    reportType: 'repair',
    technician,
    extractedFields: { labor_hours: 2, fault_category: 'electronics', retest_result: 'pass' },
  });

  await page.goto('/');
  await page.click('.view-tab:has-text("Reports")');

  // Filter to this instrument, then follow the new "View instrument
  // details" link the filter row only shows once an instrument is picked.
  await page.locator('.filter-row select').first().selectOption(instrumentId);
  await expect(page.locator('button:has-text("View instrument details")')).toBeVisible();
  await page.click('button:has-text("View instrument details")');

  // ---- Instrument header + stats ----
  // .section-title also now labels the trend chart and the "Report history"
  // heading below it (InstrumentTrendChart.tsx), so the instrument's own
  // name — always the page's first .section-title — needs .first() here.
  await expect(page.locator('.section-title').first()).toContainText('FACSAria III');
  await expect(page.locator('.instrument-meta')).toContainText('FACSAria III');
  await expect(page.locator('.instrument-meta')).toContainText('A47291');
  await expect(page.locator('.status-pill.instrument-status-active')).toContainText('Active');

  const reportsOnFile = page.locator('.stat-tile').first().locator('.stat-value');
  await expect(reportsOnFile).toBeVisible();
  expect(Number(await reportsOnFile.textContent())).toBeGreaterThanOrEqual(1);

  // ---- This run's report shows up in the instrument's own history table ----
  const row = page.locator('.instrument-report-row-body', { hasText: technician });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Malfunction / repair');
  await expect(row.locator('.status-pill')).toContainText('Finalized');

  // ---- Opening it, "back" returns to the instrument page, not the list ----
  await row.click();
  await expect(page.locator('.field-list')).toBeVisible();
  await expect(page.locator('button:has-text("View instrument: FACSAria III")')).toBeVisible();

  await page.click('button:has-text("← Back to reports")');
  await expect(page.locator('.instrument-meta')).toContainText('A47291');
  await expect(page.locator('.instrument-report-row-body', { hasText: technician })).toBeVisible();

  // One more "back" from the instrument page returns to the top-level list.
  await page.click('button:has-text("← Back to reports")');
  await expect(page.locator('.filter-row')).toBeVisible();
});

test('a report opened straight from the list still returns to the list, not an instrument page', async ({
  page,
  request,
}) => {
  const technician = `E2E-Tech-List-${Date.now()}`;
  await seedFinalizedReport(request, {
    model: 'LSRFortessa',
    reportType: 'preventive_maintenance',
    technician,
    extractedFields: { labor_hours: 1.5, verification_result: 'pass' },
  });

  await page.goto('/');
  await page.click('.view-tab:has-text("Reports")');

  const row = page.locator('.report-row-body', { hasText: technician });
  await expect(row).toBeVisible();
  await row.click();

  await expect(page.locator('button:has-text("View instrument: LSRFortessa")')).toBeVisible();
  await page.click('button:has-text("← Back to reports")');

  // Back at the plain list, not an instrument page.
  await expect(page.locator('.filter-row')).toBeVisible();
  await expect(page.locator('.instrument-meta')).toHaveCount(0);
});
