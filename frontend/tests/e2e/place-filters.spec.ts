import { type APIRequestContext } from '@playwright/test';
import { test, expect } from './coverage';
import { API_BASE, seedReport } from './helpers/api';

// Places plan, step 3: filter by place (an institution, faculty or room, with everything inside it)
// on the Instruments list, the Reports list and the Analytics page, and see figures per place.

async function unit(request: APIRequestContext, model: string, tag: string, institution: string, room: string) {
  const r = await request.post(`${API_BASE}/instruments`, {
    data: { name: `E2E PF ${tag} ${model}`, model, manufacturer: 'E2E Maker', serial_number: `SN-PF-${tag}-${model}`, institution, location: room },
  });
  expect(r.ok()).toBeTruthy();
  return r.json();
}

async function repair(request: APIRequestContext, model: string, instrumentId: string, hours: number) {
  const found = await (await request.get(`${API_BASE}/report-templates`, { params: { report_type: 'repair', model } })).json();
  let templateId = found.find((t: { model: string | null }) => t.model === model)?.id;
  if (!templateId) {
    const made = await (
      await request.post(`${API_BASE}/report-templates`, {
        data: { instrument_type: 'facs', report_type: 'repair', model, fields: [{ name: 'labor_hours', type: 'number' }] },
      })
    ).json();
    templateId = made.id;
  }
  await seedReport(request, {
    instrumentId,
    templateId,
    model,
    reportType: 'repair',
    technician: 'Dana Levi',
    fields: { labor_hours: hours },
    // 1999: a year no other spec dates reports in. analytics-filters.spec.ts isolates its own reports by the
    // year 2001 and counts them, so these must stay out of it, whichever spec runs first.
    reportDate: '1999-03-03',
    finalize: true,
  });
}

test('the Instruments list filters by institution and by room', async ({ page, request }) => {
  const stamp = Date.now();
  const model = `E2E-PF-${stamp}`;
  const uniA = `E2E PF Uni A ${stamp}`;
  const uniB = `E2E PF Uni B ${stamp}`;
  await unit(request, model, 'a', uniA, 'Room 1');
  await unit(request, model, 'b', uniA, 'Room 2');
  await unit(request, model, 'c', uniB, 'Room 1');

  await page.goto('/');
  await page.click('.view-tab:has-text("Instruments")');
  const rows = page.locator('.instrument-row.template-row-body', { hasText: model });
  await expect(rows).toHaveCount(3);
  await page.getByLabel('Filter by place').selectOption({ label: uniA });
  await expect(rows).toHaveCount(2);
  await page.getByLabel('Filter by place').selectOption({ label: `${uniA} › Room 2` });
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(`E2E PF b ${model}`);
  await page.getByLabel('Filter by place').selectOption({ label: `${uniB} › Room 1` });
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(`E2E PF c ${model}`);
});

test('the Reports list filters by place and the instrument choices follow', async ({ page, request }) => {
  const stamp = Date.now();
  const model = `E2E-PFR-${stamp}`;
  const uniA = `E2E PFR Uni A ${stamp}`;
  const uniB = `E2E PFR Uni B ${stamp}`;
  const a = await unit(request, model, 'a', uniA, 'Room 1');
  const b = await unit(request, model, 'b', uniB, 'Room 1');
  await repair(request, model, a.id, 2);
  await repair(request, model, b.id, 3);

  await page.goto('/');
  await page.click('.view-tab:has-text("Reports")');
  const reportRows = page.locator('.report-row-body', { hasText: model });
  await expect(reportRows).toHaveCount(2);
  await page.getByLabel('Place', { exact: true }).selectOption({ label: uniA });
  await expect(reportRows).toHaveCount(1);
  await expect(reportRows.first()).toContainText(a.serial_number);
  // the Instrument list now only offers the units in that place
  const options = page.getByLabel('Instrument', { exact: true }).locator('option', { hasText: model });
  await expect(options).toHaveCount(1);
});

test('Analytics shows reports and hours per place and narrows by place', async ({ page, request }) => {
  const stamp = Date.now();
  const model = `E2E-PFA-${stamp}`;
  const uniA = `E2E PFA Uni A ${stamp}`;
  const uniB = `E2E PFA Uni B ${stamp}`;
  const a = await unit(request, model, 'a', uniA, 'Room 1');
  const b = await unit(request, model, 'b', uniB, 'Room 1');
  await repair(request, model, a.id, 2);
  await repair(request, model, a.id, 3);
  await repair(request, model, b.id, 7);

  await page.goto('/');
  await page.click('.view-tab:has-text("Analytics")');
  const chart = page.getByTestId('place-chart');
  await expect(chart).toContainText(uniA);
  await expect(chart.locator('.count-bar', { hasText: uniA })).toContainText('2');
  await expect(chart.locator('.count-bar', { hasText: uniB })).toContainText('1');
  await page.getByRole('tab', { name: 'Work hours' }).click();
  await expect(chart.locator('.count-bar', { hasText: uniA })).toContainText('5h');
  await expect(chart.locator('.count-bar', { hasText: uniB })).toContainText('7h');

  await page.getByLabel('Place', { exact: true }).selectOption({ label: uniB });
  await expect(chart.locator('.count-bar', { hasText: uniA })).toHaveCount(0);
  await expect(chart.locator('.count-bar', { hasText: uniB })).toContainText('7h');
});
