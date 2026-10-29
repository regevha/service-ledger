import { test, expect, request as playwrightRequest } from '@playwright/test';
import { seedReport } from '../e2e/helpers/api';

// Is the deployment up, closed to strangers, and keeping files? Works against live Claude as well
// as the stub: nothing here waits on an extraction unless SMOKE_STUB=1.

const BASE_URL = process.env.API_BASE_URL!;
const marker = () => `SMOKE-${Date.now()}`;

test('/health is open and answers ok', async () => {
  const anonymous = await playwrightRequest.newContext({ baseURL: BASE_URL, httpCredentials: undefined });
  try {
    const res = await anonymous.get('/health');
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  } finally {
    await anonymous.dispose();
  }
});

test('without the password the app and the API answer 401', async () => {
  const anonymous = await playwrightRequest.newContext({ baseURL: BASE_URL, httpCredentials: undefined });
  try {
    expect((await anonymous.get('/')).status()).toBe(401);
    expect((await anonymous.get('/reports')).status()).toBe(401);
  } finally {
    await anonymous.dispose();
  }
});

test('with the password the page loads', async ({ request }) => {
  const res = await request.get('/');
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain('<div id="root">');
});

test('a scan that was uploaded comes back with the same bytes, then is removed', async ({ request }) => {
  // This is what proves the storage behind the deployment (the Cloud Storage mount) keeps files.
  const bytes = Buffer.from(`%PDF-1.4\n% ${marker()}\n${'x'.repeat(2048)}\n%%EOF\n`);
  const report = await (await request.post('/reports', { data: { technician_name: marker() } })).json();
  try {
    const instruments = await (await request.get('/instruments')).json();
    expect(instruments.length, 'the deployment has no instruments to attach a report to').toBeGreaterThan(0);
    const templates = await (await request.get('/report-templates')).json();
    expect(templates.length, 'the deployment has no report templates').toBeGreaterThan(0);
    const upload = await request.post(`/reports/${report.id}/attachments`, {
      multipart: { file: { name: 'smoke.pdf', mimeType: 'application/pdf', buffer: bytes } },
    });
    expect(upload.status(), await upload.text()).toBeLessThan(300);
    const attachment = await upload.json();

    const download = await request.get(`/attachments/${attachment.id}/file`);
    expect(download.status()).toBe(200);
    expect((await download.body()).equals(bytes), 'the downloaded file differs from what was uploaded').toBe(true);
  } finally {
    const removed = await request.delete(`/reports/${report.id}`, { params: { force: 'true' } });
    expect(removed.status(), 'the smoke report could not be removed').toBeLessThan(300);
  }
  expect((await request.get(`/reports/${report.id}`)).status()).toBe(404);
});

test('a scan is read and finalized end to end (stub deployments only)', async ({ request }) => {
  test.skip(process.env.SMOKE_STUB !== '1', 'live Claude is slow and costs money: set SMOKE_STUB=1 for a stub deployment');
  const { reportId } = await seedReport(request, {
    model: 'LSRFortessa',
    reportType: 'repair',
    technician: marker(),
    finalize: true,
  });
  const removed = await request.delete(`/reports/${reportId}`, { params: { force: 'true' } });
  expect(removed.status()).toBeLessThan(300);
});
