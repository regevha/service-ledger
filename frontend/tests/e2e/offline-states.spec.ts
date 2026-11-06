import type { Page } from '@playwright/test';
import { test, expect } from './coverage';
import { API_BASE, seedReport } from './helpers/api';
import { finalizeFromReview } from './finalize-helper';
import { TIMEOUT } from './timeouts';

// What a person sees when the backend cannot be reached (server down, network drop), screen by screen.
// The intake flow's own case is in error-states.spec.ts. Here: the lists and pages that load data.
// For each: the failure is said on the page in plain words (not a blank page, a spinner that never ends,
// server commands or a false "none yet"), there is a Try again button, and the screen recovers once the
// backend is back.

const API_ORIGIN = new RegExp('^' + API_BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

/** Every request to the backend fails as if the server were not running, until up() is called. */
async function backendDown(page: Page) {
  const handler = (route: import('@playwright/test').Route) => route.abort('connectionrefused');
  await page.route(API_ORIGIN, handler);
  return { up: () => page.unroute(API_ORIGIN, handler) };
}

const UNREACHABLE = /Could not reach the backend|Cannot reach the server/;

const SCREENS = [
  { name: 'Reports', hash: '#/reports', loading: 'Loading reports…', recovered: '[data-testid="report-row"]' },
  { name: 'Analytics', hash: '#/analytics', loading: 'Loading fleet analytics…', recovered: '#model-comparison, .chart-section, [data-testid="fleet-analytics"]' },
  { name: 'Instruments', hash: '#/instruments', loading: 'Loading', recovered: 'table tbody tr, .instrument-row' },
  { name: 'Templates', hash: '#/templates', loading: 'Loading', recovered: '.template-row, table tbody tr, [data-testid="template-row"]' },
] as const;

for (const screen of SCREENS) {
  test(`${screen.name}: with the backend down the page says so, stops loading, and recovers on reload`, async ({ page, request }) => {
    // Something to show once the backend is back, so recovery is visible and not just "no error".
    await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: `E2E-Offline-${Date.now()}`, finalize: true });
    const backend = await backendDown(page);

    await page.goto(`/${screen.hash}`);
    await expect(page.getByText(UNREACHABLE).first()).toBeVisible({ timeout: TIMEOUT.ui });
    await expect(page.getByText(screen.loading), 'no spinner left running').toHaveCount(0);

    await backend.up();
    await page.reload();
    await expect(page.getByText(UNREACHABLE)).toHaveCount(0);
    await expect(page.locator(screen.recovered).first(), 'the data is back').toBeVisible({ timeout: TIMEOUT.ui });
  });
}

test('Review: saving while the backend is down shows the error with Try again, and Try again saves once it is back', async ({ page, request }) => {
  const technician = `E2E-OfflineSave-${Date.now()}`;
  const seeded = await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician });
  await page.goto('/#/reports');
  await page.getByTestId('report-row').filter({ hasText: technician }).first().click();
  await expect(page.getByTestId('field-list')).toBeVisible({ timeout: TIMEOUT.ui });

  const backend = await backendDown(page);
  await finalizeFromReview(page);
  const alert = page.getByRole('alert').filter({ has: page.locator('#save-error') });
  await expect(alert).toBeVisible({ timeout: TIMEOUT.ui });
  await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByTestId('field-list'), 'the form and what was typed stay on screen').toBeVisible();
  expect((await (await request.get(`${API_BASE}/reports/${seeded.reportId}`)).json()).status, 'nothing was saved').not.toBe('finalized');

  await backend.up();
  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('#save-error')).toHaveCount(0, { timeout: TIMEOUT.ui });
  await expect.poll(async () => (await (await request.get(`${API_BASE}/reports/${seeded.reportId}`)).json()).status, { timeout: TIMEOUT.ui }).toBe('finalized');
});

// ---- The failure itself, per screen ----

for (const screen of SCREENS) {
  test(`${screen.name}: the failure is in plain words (no server commands or settings names)`, async ({ page }) => {
    await backendDown(page);
    await page.goto(`/${screen.hash}`);
    await expect(page.getByText(UNREACHABLE).first()).toBeVisible({ timeout: TIMEOUT.ui });
    await expect(page.locator('body')).not.toContainText(/uvicorn|VITE_API_BASE_URL/);
  });
}

for (const screen of [SCREENS[2], SCREENS[3]]) {
  test(`${screen.name}: a failed load does not also say there are none ("No ${screen.name.toLowerCase()} yet.")`, async ({ page }) => {
    await backendDown(page);
    await page.goto(`/${screen.hash}`);
    await expect(page.getByText(UNREACHABLE).first()).toBeVisible({ timeout: TIMEOUT.ui });
    await expect(page.getByText(/^No (instruments|templates) yet/)).toHaveCount(0);
  });
}

for (const screen of SCREENS) {
  test(`${screen.name}: the failure comes with a Try again button that loads it once the backend is back`, async ({ page }) => {
    const backend = await backendDown(page);
    await page.goto(`/${screen.hash}`);
    await expect(page.getByText(UNREACHABLE).first()).toBeVisible({ timeout: TIMEOUT.ui });
    await backend.up();
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByText(UNREACHABLE)).toHaveCount(0);
  });
}
