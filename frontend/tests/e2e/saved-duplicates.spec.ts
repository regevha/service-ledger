import { type APIRequestContext, type Page } from '@playwright/test';
import { test, expect } from './coverage';
import { textPdf } from './text-pdf';
import { BACKEND_PORT } from '../../playwright.config';
import { TIMEOUT } from './timeouts';

// The persistent duplicate indicator on a saved report's screen: whenever a
// report is opened later (not only during intake), a banner names any other
// report that holds the same scan, or the same work-order number on the same
// instrument, and offers to open it. Each test uses its own unique marker.

const API_BASE = `http://localhost:${BACKEND_PORT}`;

// Every unit a test makes is removed afterwards (deleting an instrument deletes
// its reports). These reports are confirmed to a template but never extracted,
// i.e. they sit in "classified", a status reports-search.spec.ts relies on
// nothing else being in; the extra units would also make later uploads of
// their model need a manual pick.
const createdUnits: string[] = [];

test.afterEach(async ({ request }) => {
  while (createdUnits.length) {
    await request.delete(`${API_BASE}/instruments/${createdUnits.pop()}`);
  }
});

async function createUnit(request: APIRequestContext, model: string, serial: string) {
  const res = await request.post(`${API_BASE}/instruments`, { data: { name: serial, model, manufacturer: 'E2E Maker', serial_number: serial } });
  expect(res.status()).toBe(201);
  const id = (await res.json()).id as string;
  createdUnits.push(id);
  return id;
}

// A report on `instrumentId` whose scan carries `workOrder` (read from the PDF's own text layer).
async function reportWithWorkOrder(
  request: APIRequestContext,
  opts: { instrumentId: string; model: string; workOrder: string; technician: string; extraLine?: string },
) {
  const report = await (await request.post(`${API_BASE}/reports`, { data: { technician_name: opts.technician } })).json();
  const templates = await (
    await request.get(`${API_BASE}/report-templates`, { params: { report_type: 'repair', model: opts.model } })
  ).json();
  await request.patch(`${API_BASE}/reports/${report.id}/template`, {
    data: { instrument_id: opts.instrumentId, template_id: templates[0].id },
  });
  // A real one-page PDF whose text layer names the work order, the way a service report does.
  const pdf = textPdf(['Service Report', `WORK ORDER NUMBER: WO-${opts.workOrder}`, `Technician: ${opts.technician}`, ...(opts.extraLine ? [opts.extraLine] : [])]);
  const upload = await request.post(`${API_BASE}/reports/${report.id}/attachments`, {
    multipart: { file: { name: 'wo.pdf', mimeType: 'application/pdf', buffer: pdf } },
  });
  expect(upload.status()).toBe(201);
  return report.id as string;
}

async function openReport(page: Page, technician: string) {
  await page.goto('/');
  await page.click('.view-tab:has-text("Reports")');
  await page.waitForSelector('.report-table, .empty-hint');
  await page.click(`.report-row-body:has-text("${technician}")`);
}

test('a saved report with the same work order on the same instrument shows a duplicate banner that opens the other one', async ({ page, request }) => {
  const model = `DUP-${Date.now()}`;
  const unit = await createUnit(request, model, `${model}-A`);
  const wo = `${Date.now()}`.slice(-8);
  const first = `E2E-First-${Date.now()}`;
  const second = `E2E-Second-${Date.now()}`;
  const firstId = await reportWithWorkOrder(request, { instrumentId: unit, model, workOrder: wo, technician: first });
  const secondId = await reportWithWorkOrder(request, { instrumentId: unit, model, workOrder: wo, technician: second, extraLine: 'rescan' });
  expect((await (await request.get(`${API_BASE}/reports/${secondId}/duplicates`)).json()).length).toBe(1);

  await openReport(page, second);

  const banner = page.locator('#saved-duplicate-notice');
  await expect(banner).toContainText('Possible duplicate');
  await expect(banner).toContainText(first);
  await expect(banner).toContainText(`same work order (${wo}) on this instrument`);

  // The button opens the other report, which flags this one in turn.
  await banner.locator('button:has-text("Open that report")').click();
  await expect(page.locator('#saved-duplicate-notice')).toContainText(second);
  expect(firstId).not.toEqual(secondId);

  // Deleting one clears the indicator on the other.
  await page.click('button:has-text("Delete report")');
  await page.click('button:has-text("Confirm delete")');
  await page.waitForSelector('.report-table, .empty-hint');
  await page.click(`.report-row-body:has-text("${second}")`);
  await expect(page.locator('.field-list, .empty-hint').first()).toBeVisible({ timeout: TIMEOUT.ui });
  await expect(page.locator('#saved-duplicate-notice')).toHaveCount(0);
});

test('the same work order on a different instrument shows no banner', async ({ page, request }) => {
  const model = `DUP-Other-${Date.now()}`;
  const a = await createUnit(request, model, `${model}-A`);
  const b = await createUnit(request, model, `${model}-B`); // same model, different serial
  const wo = `${Date.now()}`.slice(-8);
  const technician = `E2E-Solo-${Date.now()}`;
  await reportWithWorkOrder(request, { instrumentId: a, model, workOrder: wo, technician: `E2E-OnA1-${Date.now()}` });
  // Precondition: the work order really is read from the PDFs — a second report on the SAME instrument is flagged.
  const onA2 = await reportWithWorkOrder(request, { instrumentId: a, model, workOrder: wo, technician: `E2E-OnA2-${Date.now()}`, extraLine: 'again' });
  expect((await (await request.get(`${API_BASE}/reports/${onA2}/duplicates`)).json()).length).toBe(1);
  // …but the same work order on the other unit is not.
  const onB = await reportWithWorkOrder(request, { instrumentId: b, model, workOrder: wo, technician, extraLine: 'other unit' });
  expect(await (await request.get(`${API_BASE}/reports/${onB}/duplicates`)).json()).toEqual([]);

  await openReport(page, technician);

  await expect(page.locator('.field-list, .empty-hint').first()).toBeVisible({ timeout: TIMEOUT.ui });
  await expect(page.locator('#saved-duplicate-notice')).toHaveCount(0);
});
