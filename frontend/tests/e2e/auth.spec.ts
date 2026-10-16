import { request as playwrightRequest, type Page } from '@playwright/test';
import { test, expect } from './coverage';
import { ADMIN, API, SIGNED_OUT_STATE, TECHNICIAN, VIEWER } from './auth-setup';

// Required sign-in and the three roles. Every other spec runs signed in as the
// admin (the default storageState); these start signed out, or as a lesser role.

const signedOut = { storageState: SIGNED_OUT_STATE };

async function signIn(page: Page, account: { username: string; password: string }) {
  await page.goto('/');
  await page.getByLabel('Username').fill(account.username);
  await page.getByLabel('Password').fill(account.password);
  await page.click('button:has-text("Sign in")');
}

const tabs = (page: Page) => page.locator('.view-tab');

test.describe('signed out', () => {
  test.use(signedOut);

  test('the app shows only the sign-in screen, and a wrong password is refused', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.login-form .section-title')).toHaveText('Sign in');
    await expect(tabs(page)).toHaveCount(0);

    await signIn(page, { username: ADMIN.username, password: 'not the password' });
    await expect(page.getByRole('alert')).toHaveText('Wrong username or password.');
    await expect(tabs(page)).toHaveCount(0);
  });

  test('an admin signs in, sees every tab, and signing out returns to the sign-in screen', async ({ page }) => {
    await signIn(page, ADMIN);

    await expect(tabs(page)).toHaveText(['New report', 'Reports', 'Analytics', 'Templates', 'Instruments']);
    await expect(page.locator('#current-user')).toHaveText('e2e-admin · admin');

    // A reload keeps the session (the cookie), then Sign out ends it.
    await page.reload();
    await expect(page.locator('#current-user')).toBeVisible();
    await page.click('button:has-text("Sign out")');
    await expect(page.locator('.login-form .section-title')).toHaveText('Sign in');
    await page.reload();
    await expect(page.locator('.login-form .section-title')).toHaveText('Sign in');
  });

  test('a technician has no Templates or Instruments tab and cannot delete a report', async ({ page }) => {
    const marker = `E2E-Auth-Tech-${Date.now()}`;
    // Make the report as the technician, and check the API refuses them a delete.
    const tech = await playwrightRequest.newContext({ baseURL: API });
    await tech.post('/auth/login', { data: TECHNICIAN });
    const created = await tech.post('/reports', { data: { technician_name: marker } });
    expect(created.status()).toBe(201);
    expect((await tech.delete(`/reports/${(await created.json()).id}`)).status()).toBe(403);
    await tech.dispose();

    await signIn(page, TECHNICIAN);
    await expect(tabs(page)).toHaveText(['New report', 'Reports', 'Analytics']);
    await expect(page.locator('#current-user')).toHaveText('e2e-technician · technician');

    await page.click('.view-tab:has-text("Reports")');
    await page.click(`.report-row-body:has-text("${marker}")`);
    await expect(page.locator('button:has-text("Back to reports")')).toBeVisible();
    await expect(page.locator('button:has-text("Delete report")')).toHaveCount(0);
  });

  test('a viewer lands on Reports and can read a report but not change it', async ({ page }) => {
    const marker = `E2E-Auth-View-${Date.now()}`;
    const admin = await playwrightRequest.newContext({ baseURL: API });
    await admin.post('/auth/login', { data: ADMIN });
    const instruments = await (await admin.get('/instruments')).json();
    const instrument = instruments.find((i: { model: string }) => i.model === 'LSRFortessa');
    const templates = await (await admin.get('/report-templates', { params: { report_type: 'repair', model: 'LSRFortessa' } })).json();
    const report = await (await admin.post('/reports', { data: { technician_name: marker } })).json();
    await admin.patch(`/reports/${report.id}/template`, { data: { instrument_id: instrument.id, template_id: templates[0].id } });
    await admin.dispose();

    try {
      await signIn(page, VIEWER);
      await expect(tabs(page)).toHaveText(['Reports', 'Analytics']);
      await expect(page.locator('.section-title').first()).toHaveText('Reports');

      await page.click(`.report-row-body:has-text("${marker}")`);
      await expect(page.locator('.field-list')).toBeVisible();
      await expect(page.locator('#review-report-date')).toBeDisabled();
      await expect(page.locator('button:has-text("Save corrections")')).toHaveCount(0);
      await expect(page.locator('button:has-text("Delete report")')).toHaveCount(0);
    } finally {
      // The suite shares one database and other specs count reports by
      // status, so don't leave a "classified" report behind.
      const cleanup = await playwrightRequest.newContext({ baseURL: API });
      await cleanup.post('/auth/login', { data: ADMIN });
      await cleanup.delete(`/reports/${report.id}`);
      await cleanup.dispose();
    }
  });

  test('a viewer can use the Analytics filters and the saved-filter picker but cannot save or delete one', async ({ page }) => {
    await signIn(page, VIEWER);
    await expect(page.locator('#current-user')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save this filter' })).toHaveCount(0);

    await page.click('.view-tab:has-text("Analytics")');
    await expect(page.getByTestId('analytics-filters')).toBeVisible({ timeout: 15_000 });
    await page.getByLabel('Report type').selectOption({ label: 'Preventive maintenance' });
    await expect(page.getByTestId('analytics-basis')).toContainText('matching the filters');
  });

  test('a technician can save a filter and add an instrument, but not edit one', async ({ page }) => {
    await signIn(page, TECHNICIAN);
    await page.click('.view-tab:has-text("Reports")');
    await expect(page.getByRole('button', { name: 'Save this filter' })).toBeVisible();

    const tech = await playwrightRequest.newContext({ baseURL: API });
    await tech.post('/auth/login', { data: TECHNICIAN });
    const serial = `E2E-ROLE-${Date.now()}`;
    const created = await tech.post('/instruments', {
      data: { name: 'Role test unit', model: 'RoleTest', manufacturer: 'Acme', serial_number: serial },
    });
    expect(created.status()).toBe(201);
    expect((await tech.patch(`/instruments/${(await created.json()).id}`, { data: { name: 'x' } })).status()).toBe(403);
    await tech.dispose();

    const admin = await playwrightRequest.newContext({ baseURL: API });
    await admin.post('/auth/login', { data: ADMIN });
    const id = (await (await admin.get('/instruments')).json()).find((i: { serial_number: string }) => i.serial_number === serial).id;
    await admin.delete(`/instruments/${id}`);
    await admin.dispose();
  });

  test('when the session ends mid-use the app returns to sign-in with a notice', async ({ page, context }) => {
    await signIn(page, VIEWER);
    await expect(page.locator('#current-user')).toBeVisible();

    // The session is ended behind the page's back (e.g. signed out in another tab).
    expect((await context.request.post(`${API}/auth/logout`)).status()).toBe(204);
    // The next request the page makes is answered 401. The Reports tab's own
    // debounced fetch may already have done that, so the click is best-effort.
    await page.click('.view-tab:has-text("Analytics")', { timeout: 3000 }).catch(() => undefined);

    await expect(page.locator('.banner-warn')).toContainText('Your session ended');
    await expect(page.locator('.login-form .section-title')).toHaveText('Sign in');
  });
});
