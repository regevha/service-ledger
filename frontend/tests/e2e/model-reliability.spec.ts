import { type APIRequestContext } from '@playwright/test';
import { test, expect } from './coverage';
import { uniquePdf } from './unique-upload';
import { BACKEND_PORT } from '../../playwright.config';

// Models plan step 4, part B: the model page's Reliability section — days between
// repairs, fault categories, parts — and its honest limits (no averages below 3
// repairs, undated repairs named).

const API_BASE = `http://localhost:${BACKEND_PORT}`;

async function unit(request: APIRequestContext, model: string, tag: string) {
  const r = await request.post(`${API_BASE}/instruments`, {
    data: { name: `E2E Rel ${tag} ${model}`, model, manufacturer: 'E2E Maker', serial_number: `SN-REL-${tag}-${model}` },
  });
  expect(r.ok()).toBeTruthy();
  return r.json();
}

async function template(request: APIRequestContext, model: string) {
  const r = await request.post(`${API_BASE}/report-templates`, {
    data: {
      instrument_type: 'facs',
      report_type: 'repair',
      model,
      fields: [
        { name: 'fault_category', type: 'text' },
        { name: 'labor_hours', type: 'number' },
      ],
    },
  });
  expect(r.ok()).toBeTruthy();
  return r.json();
}

async function repair(request: APIRequestContext, instrumentId: string, templateId: string, day: string | null, fault: string, hours: number) {
  const report = await (await request.post(`${API_BASE}/reports`, { data: { technician_name: 'Dana Levi' } })).json();
  await request.patch(`${API_BASE}/reports/${report.id}/template`, { data: { instrument_id: instrumentId, template_id: templateId } });
  const attachment = await (
    await request.post(`${API_BASE}/reports/${report.id}/attachments`, {
      multipart: { file: { name: 'seed.pdf', mimeType: 'application/pdf', buffer: uniquePdf('%PDF-1.4 reliability') } },
    })
  ).json();
  const job = await (await request.post(`${API_BASE}/attachments/${attachment.id}/extract`)).json();
  for (let waited = 0; waited < 30_000; waited += 200) {
    const polled = await (await request.get(`${API_BASE}/extraction-jobs/${job.id}`)).json();
    if (polled.status === 'succeeded' || polled.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const data: Record<string, unknown> = { extracted_fields: { fault_category: fault, labor_hours: hours } };
  if (day) data.report_date = day;
  await request.patch(`${API_BASE}/reports/${report.id}/fields`, { data });
  const fin = await request.post(`${API_BASE}/reports/${report.id}/finalize`);
  expect(fin.status()).toBe(200);
}

async function openModelPage(page: import('@playwright/test').Page, model: string) {
  await page.goto('/');
  await page.click('.view-tab:has-text("Instruments")');
  await page.click('.sub-switch button:has-text("Models")');
  await page.locator('.model-name', { hasText: new RegExp(`^${model}$`) }).click();
  await expect(page.locator('#model-page')).toBeVisible();
}

test('with enough repairs the model page shows days between repairs, faults and what it counted', async ({ page, request }) => {
  const model = `E2E-Rel-${Date.now()}`;
  const a = await unit(request, model, 'a');
  const t = await template(request, model);
  await repair(request, a.id, t.id, '2026-01-01', 'Fluidics', 2);
  await repair(request, a.id, t.id, '2026-01-11', 'Fluidics', 4);
  await repair(request, a.id, t.id, '2026-01-31', 'Laser', 6);

  await openModelPage(page, model);
  const rel = page.locator('#model-reliability');
  await expect(rel).toContainText('From 3 finalized repair reports');
  await expect(page.locator('#rel-mean-gap')).toHaveText('15 days');
  await expect(page.locator('#rel-avg-labor')).toHaveText('4.0 h');
  await expect(rel).toContainText('3 of 3 repairs have a fault category');
  const fluidics = rel.locator('.model-rel-row.template-row-body', { hasText: 'Fluidics' });
  await expect(fluidics).toContainText('repeat fault');
});

test('with fewer than 3 repairs it shows counts but no averages', async ({ page, request }) => {
  const model = `E2E-RelFew-${Date.now()}`;
  const a = await unit(request, model, 'a');
  const t = await template(request, model);
  await repair(request, a.id, t.id, '2026-01-01', 'Fluidics', 2);

  await openModelPage(page, model);
  await expect(page.locator('#model-reliability')).toContainText('Averages appear from 3 repairs');
  await expect(page.locator('#rel-mean-gap')).toHaveCount(0);
});

test('a model with no repairs says so', async ({ page, request }) => {
  const model = `E2E-RelNone-${Date.now()}`;
  await unit(request, model, 'a');
  await openModelPage(page, model);
  await expect(page.locator('#model-reliability')).toContainText('No finalized repair reports for this model yet');
});
