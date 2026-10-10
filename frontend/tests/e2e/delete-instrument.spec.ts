import { test, expect } from './coverage';
import { uniquePdf } from './unique-upload';
import { BACKEND_PORT } from '../../playwright.config';

// "Delete" on the Instruments tab: a confirmation that says how many reports go
// with the instrument, then the instrument and all its reports are gone. Each
// test makes its own uniquely named instrument.

const API_BASE = `http://localhost:${BACKEND_PORT}`;

async function createInstrument(request: import('@playwright/test').APIRequestContext, name: string) {
  const res = await request.post(`${API_BASE}/instruments`, {
    data: { name, model: 'E2E-Delete-Model', serial_number: `SN-${name}` },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string };
}

async function reportOn(request: import('@playwright/test').APIRequestContext, instrumentId: string, technician: string) {
  const report = await (await request.post(`${API_BASE}/reports`, { data: { technician_name: technician } })).json();
  const templates = await (
    await request.get(`${API_BASE}/report-templates`, { params: { report_type: 'repair', model: 'E2E-Delete-Model' } })
  ).json();
  await request.patch(`${API_BASE}/reports/${report.id}/template`, {
    data: { instrument_id: instrumentId, template_id: templates[0].id },
  });
  await request.post(`${API_BASE}/reports/${report.id}/attachments`, {
    multipart: { file: { name: 'seed.pdf', mimeType: 'application/pdf', buffer: uniquePdf('%PDF-1.4 seed') } },
  });
  return report.id as string;
}

async function openInstruments(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.click('.view-tab:has-text("Instruments")');
  await expect(page.locator('.section-title')).toContainText('Instruments');
}

test('an instrument with no reports is deleted after a confirm step', async ({ page, request }) => {
  const name = `E2E-Del-${Date.now()}`;
  const { id } = await createInstrument(request, name);
  await openInstruments(page);
  const row = page.locator('.instrument-row.template-row-body', { hasText: name });

  await row.locator('button:has-text("Delete")').click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('It has no reports');

  // Cancel keeps it.
  await dialog.locator('button:has-text("Cancel")').click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toBeVisible();

  await row.locator('button:has-text("Delete")').click();
  await page.getByRole('alertdialog').locator('button:has-text("Confirm delete")').click();

  await expect(row).toHaveCount(0);
  expect((await request.get(`${API_BASE}/instruments/${id}`)).status()).toBe(404);

  // Gone from the Reports tab's instrument filter too (same shared list).
  await page.click('.view-tab:has-text("Reports")');
  await expect(page.locator('.filter-row select').first().locator('option', { hasText: name })).toHaveCount(0);
});

test('deleting an instrument also deletes all of its reports, and says how many', async ({ page, request }) => {
  const name = `E2E-Del-Used-${Date.now()}`;
  const { id } = await createInstrument(request, name);
  const reportIds = [await reportOn(request, id, name), await reportOn(request, id, name)];
  // A retired instrument is deleted the same way as an active one.
  expect((await request.patch(`${API_BASE}/instruments/${id}`, { data: { status: 'retired' } })).status()).toBe(200);

  await openInstruments(page);
  const row = page.locator('.instrument-row.template-row-body', { hasText: name });
  await row.locator('button:has-text("Delete")').click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('also permanently deletes its 2 reports');
  await dialog.locator('button:has-text("Confirm delete")').click();

  await expect(row).toHaveCount(0);
  expect((await request.get(`${API_BASE}/instruments/${id}`)).status()).toBe(404);
  for (const reportId of reportIds) {
    expect((await request.get(`${API_BASE}/reports/${reportId}`)).status()).toBe(404);
  }
  const left = await (await request.get(`${API_BASE}/reports`, { params: { technician: name } })).json();
  expect(left).toHaveLength(0);
});
