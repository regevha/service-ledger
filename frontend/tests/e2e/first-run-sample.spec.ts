import { test, expect, type Page } from './coverage';
import { API_BASE } from './helpers/api';
import { TIMEOUT } from './timeouts';

// The first-run sample (SL-79, docs/features/first-run-sample/PRODUCT.md): a new user opens a stored sample
// report from New report and lands on the review screen with fields filled in and some flagged, without
// uploading anything. Everything below the first request is the real backend.
//
// The e2e database is shared and other specs finalize reports in it, so the "ledger has no finalized
// reports" check the button depends on is answered as empty here (the one request that asks it).
async function ledgerLooksEmpty(page: Page) {
  await page.route(/\/reports\?.*status=finalized/, (route) =>
    route.fulfill({
      status: 200,
      json: [],
      headers: { 'x-total-count': '0', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'X-Total-Count' },
    })
  );
}

test.afterEach(async ({ request }) => {
  await request.delete(`${API_BASE}/sample-report`);
});

test('the sample opens on the review screen with fields and flags, and stays out of real data', async ({ page, request }) => {
  await ledgerLooksEmpty(page);
  await page.goto('/#/new');
  const button = page.getByTestId('try-sample');
  await expect(button).toBeVisible({ timeout: TIMEOUT.ui });

  const started = Date.now();
  await button.click();
  await expect(page.getByTestId('sample-banner')).toContainText('Sample report. Not part of your ledger.', { timeout: TIMEOUT.ui });
  expect(Date.now() - started, 'AC-01: under 5 seconds').toBeLessThan(5_000);

  // Fields are filled in, two are flagged, and the counter works.
  await expect(page.getByText('Worn nozzle O-ring').first()).toBeVisible();
  await expect(page.getByTestId('checked-count')).toContainText(/\d+ of \d+ checked/);
  await expect(page.getByTestId('checked-count')).not.toContainText(/^7 of 7/);

  // It is a stored result: never labelled as a stub placeholder, whatever mode the server runs in.
  await expect(page.getByText(/placeholders, not read from the document/)).toHaveCount(0);
  await expect(page.getByText('placeholder', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('sample-banner')).toBeVisible();

  // A sample cannot be finalized and has nothing to save.
  await expect(page.getByRole('button', { name: /finalize/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save corrections' })).toHaveCount(0);

  // Not part of the ledger: no sample in the reports list or the instruments list.
  const reports = await (await request.get(`${API_BASE}/reports`)).json();
  expect(JSON.stringify(reports)).not.toContain('DEMO-0001');
  const instruments = await (await request.get(`${API_BASE}/instruments`)).json();
  expect(JSON.stringify(instruments)).not.toContain('DEMO-0001');
});

test('Delete removes the sample, its instrument and place, and returns to the upload screen', async ({ page, request }) => {
  await ledgerLooksEmpty(page);
  await page.goto('/#/new');
  await page.getByTestId('try-sample').click();
  await expect(page.getByTestId('sample-banner')).toBeVisible({ timeout: TIMEOUT.ui });

  await page.getByTestId('delete-sample').click();
  await expect(page.getByTestId('intake-dropzone')).toBeVisible({ timeout: TIMEOUT.ui });
  await expect(page.getByTestId('sample-banner')).toHaveCount(0);

  // Opening it again after deleting makes a fresh one (the sample instrument and place are gone and come back).
  const again = await request.post(`${API_BASE}/sample-report`);
  expect(again.status()).toBe(201);
});

test('the sample button is not offered once the ledger has a finalized report', async ({ page }) => {
  await page.route(/\/reports\?.*status=finalized/, (route) =>
    route.fulfill({
      status: 200,
      json: [],
      headers: { 'x-total-count': '3', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'X-Total-Count' },
    })
  );
  await page.goto('/#/new');
  await expect(page.getByTestId('intake-dropzone')).toBeVisible({ timeout: TIMEOUT.ui });
  await expect(page.getByTestId('try-sample')).toHaveCount(0);
});
