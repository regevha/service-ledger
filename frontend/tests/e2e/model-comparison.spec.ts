import { type APIRequestContext, type Page } from '@playwright/test';
import { test, expect } from './coverage';
import { BACKEND_PORT } from '../../playwright.config';

// "Compare units of the same model" on the Analytics tab: the side-by-side
// table of every serial of a model and the one-line-per-unit trend chart.
// Each test makes its own brand-new model (two units, or one), so exact
// counts and values hold regardless of what other specs left in the shared
// database.

const API_BASE = `http://localhost:${BACKEND_PORT}`;

async function createUnit(request: APIRequestContext, model: string, serial: string, name: string) {
  const res = await request.post(`${API_BASE}/instruments`, { data: { name, model, serial_number: serial } });
  expect(res.status()).toBe(201);
  return (await res.json()).id as string;
}

async function finalizedCalibration(
  request: APIRequestContext,
  opts: { instrumentId: string; model: string; pressure: number; reportDate: string },
) {
  const report = await (await request.post(`${API_BASE}/reports`, { data: {} })).json();
  const templates = await (
    await request.get(`${API_BASE}/report-templates`, { params: { report_type: 'calibration', model: opts.model } })
  ).json();
  await request.patch(`${API_BASE}/reports/${report.id}/template`, {
    data: { instrument_id: opts.instrumentId, template_id: templates[0].id },
  });
  const attachment = await (
    await request.post(`${API_BASE}/reports/${report.id}/attachments`, {
      multipart: {
        file: {
          name: 'seed.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from(`%PDF-1.4 seed ${Date.now()}-${Math.random()}`),
        },
      },
    })
  ).json();
  const job = await (await request.post(`${API_BASE}/attachments/${attachment.id}/extract`)).json();
  for (let waited = 0; waited < 30_000; waited += 200) {
    const polled = await (await request.get(`${API_BASE}/extraction-jobs/${job.id}`)).json();
    if (polled.status === 'succeeded' || polled.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await request.patch(`${API_BASE}/reports/${report.id}/fields`, {
    data: { extracted_fields: { fluidics_pressure_psi: opts.pressure }, report_date: opts.reportDate },
  });
  expect((await request.post(`${API_BASE}/reports/${report.id}/finalize`)).status()).toBe(200);
}

async function openComparison(page: Page, model: string) {
  await page.goto('/');
  await page.click('.view-tab:has-text("Analytics")');
  const picker = page.getByLabel('Model to compare');
  await expect(picker).toBeVisible({ timeout: 15_000 });
  await picker.selectOption(model);
}

test('two units of one model are compared in a table and on one chart', async ({ page, request }) => {
  const model = `CMP-${Date.now()}`;
  const a = await createUnit(request, model, `${model}-A`, 'Unit A');
  const b = await createUnit(request, model, `${model}-B`, 'Unit B');
  await finalizedCalibration(request, { instrumentId: a, model, pressure: 12, reportDate: '2026-01-10' });
  await finalizedCalibration(request, { instrumentId: a, model, pressure: 14, reportDate: '2026-02-10' });
  await finalizedCalibration(request, { instrumentId: b, model, pressure: 9, reportDate: '2026-01-20' });

  await openComparison(page, model);

  const rows = page.locator('.compare-table tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText(`${model}-A`);
  await expect(rows.nth(0)).toContainText('2'); // two finalized reports
  await expect(rows.nth(1)).toContainText(`${model}-B`);

  // One chart, a line per unit: three dated points in total, a legend entry per serial.
  await page.getByLabel('Field to compare').selectOption('fluidics_pressure_psi');
  const chart = page.locator('#model-comparison svg[role="img"]');
  await expect(chart).toBeVisible();
  await expect(chart.locator('circle')).toHaveCount(3);
  await expect(page.locator('#model-comparison .legend-item')).toHaveCount(2);

  // Every value is also reachable as text.
  await page.click('#model-comparison button:has-text("View as table")');
  const valueRows = page.locator('#model-comparison .trend-table').last().locator('tbody tr');
  await expect(valueRows).toHaveCount(3);
  await expect(valueRows.first()).toContainText(`${model}-A`);
  await expect(page.locator('#model-comparison .hint-text', { hasText: 'Only one' })).toHaveCount(0);
});

test('a model with a single unit says there is nothing to compare yet', async ({ page, request }) => {
  const model = `CMP-Solo-${Date.now()}`;
  await createUnit(request, model, `${model}-A`, 'Only unit');

  await openComparison(page, model);

  await expect(page.locator('#model-comparison .hint-text')).toContainText('nothing to compare');
  await expect(page.locator('.compare-table tbody tr')).toHaveCount(1);
  await expect(page.locator('#model-comparison')).toContainText('No numeric fields have recorded data yet');
});
