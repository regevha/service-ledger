import { test, expect } from '../e2e/coverage';
import { seedReport } from '../e2e/helpers/api';

// The shared password in front of the whole app, as a browser meets it on the built page.
// (playwright.built.config.ts runs these with the right password already set; a spec that needs
// none, or a wrong one, opens its own context.)

const ORIGIN = process.env.API_BASE_URL!;
const BUILT_PASSWORD = process.env.BUILT_PASSWORD!;

test('without a password the page and the API both answer 401 with a Basic challenge', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: ORIGIN, httpCredentials: undefined });
  try {
    const page = await context.newPage();
    const response = await page.goto('/');
    expect(response?.status()).toBe(401);
    expect(await response?.headerValue('www-authenticate')).toContain('Basic');

    const api = await context.request.get('/reports');
    expect(api.status()).toBe(401);
  } finally {
    await context.close();
  }
});

test('a wrong password is refused', async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: ORIGIN,
    httpCredentials: { username: 'tester', password: 'not-the-password-0000', send: 'always' },
  });
  try {
    const page = await context.newPage();
    expect((await page.goto('/'))?.status()).toBe(401);
    expect((await context.request.get('/instruments')).status()).toBe(401);
  } finally {
    await context.close();
  }
});

test('the right password reaches the app, and any user name will do', async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: ORIGIN,
    httpCredentials: { username: 'someone-else', password: BUILT_PASSWORD, send: 'always' },
  });
  try {
    const page = await context.newPage();
    expect((await page.goto('/'))?.status()).toBe(200);
    await page.click('.view-tab:has-text("New report")');
    await expect(page.getByTestId('intake-dropzone')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('/health stays open without a password and reveals nothing else', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: ORIGIN, httpCredentials: undefined });
  try {
    const res = await context.request.get('/health');
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  } finally {
    await context.close();
  }
});

test('a scan downloads through the gate, and not without the password', async ({ request, browser }) => {
  const { attachmentId } = await seedReport(request, {
    model: 'LSRFortessa',
    reportType: 'repair',
    technician: `E2E-Gate-${Date.now()}`,
    extract: false,
  });
  const ok = await request.get(`/attachments/${attachmentId}/file`);
  expect(ok.status()).toBe(200);
  expect(ok.headers()['content-type']).toContain('pdf');
  expect((await ok.body()).subarray(0, 4).toString()).toBe('%PDF');

  const context = await browser.newContext({ baseURL: ORIGIN, httpCredentials: undefined });
  try {
    expect((await context.request.get(`/attachments/${attachmentId}/file`)).status()).toBe(401);
  } finally {
    await context.close();
  }
});
