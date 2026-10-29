import { type APIRequestContext } from '@playwright/test';
import { test, expect } from './coverage';
import { uniqueFixture } from './unique-upload';
import { createNumericTemplate } from './numeric-fixture';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIMEOUT } from './timeouts';
import { seedReport, API_BASE } from './helpers/api';

// Phone review of 2026-10-25, items 9, 10, 12 and 13: long notices fold to two lines, the save bar
// is one row, the report header is compact and says what the report is.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'confident-scan.pdf');
const PHONE = { width: 412, height: 915 };

async function reachReview(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.click('.view-tab:has-text("New report")');
  await page.locator('input[type="file"]').setInputFiles(uniqueFixture(FIXTURE));
  await page.click('button:has-text("Upload & classify")');
  await page.waitForSelector('.field-list, .banner-crit', { timeout: TIMEOUT.flow });
  await expect(page.locator('#placeholder-notice')).toBeVisible();
}

async function seedFinalized(request: APIRequestContext, marker: string): Promise<{ reportId: string; instrumentName: string }> {
  await request.post(`${API_BASE}/instruments`, {
    data: { name: marker, model: marker, manufacturer: 'E2E Maker', serial_number: `SN-${marker}` },
  });
  await createNumericTemplate(request, marker);
  const { reportId } = await seedReport(request, {
    model: marker,
    reportType: 'installation_upgrade',
    fields: { fluidics_pressure_psi: 6 },
    reportDate: '2026-09-08',
    finalize: true,
  });
  return { reportId, instrumentName: marker };
}

test.describe('on a phone', { tag: '@phone' }, () => {

  test('a long notice shows two lines and a More button that opens it', async ({ page }) => {
    // A narrow phone, so the notice is more than two lines whatever the fonts of the machine are.
    await page.setViewportSize({ width: 360, height: 800 });
    await reachReview(page);
    const text = page.locator('#placeholder-notice .notice-text');
    const more = page.locator('#placeholder-notice .notice-more');
    const folded = await text.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
    expect(folded.scroll).toBeGreaterThan(folded.client + 1);
    await expect(more).toHaveText('More');
    await more.click();
    await expect(more).toHaveText('Less');
    const open = await text.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
    expect(open.scroll).toBeLessThanOrEqual(open.client + 1);
    await more.click();
    await expect(more).toHaveText('More');
  });

  test('the save bar is one row: the attention count, Save corrections and Save & finalize', async ({ page }) => {
    await reachReview(page);
    const bar = page.locator('.review-actions');
    await expect(bar).toBeVisible();
    const boxes = await Promise.all([
      bar.boundingBox(),
      bar.locator('button:has-text("Save corrections")').boundingBox(),
      bar.locator('button:has-text("Save & finalize report")').boundingBox(),
    ]);
    const [barBox, saveBox, finalBox] = boxes as NonNullable<(typeof boxes)[number]>[];
    expect(Math.abs(saveBox.y - finalBox.y)).toBeLessThan(3);
    expect(barBox.height).toBeLessThan(70);
    expect(finalBox.x + finalBox.width).toBeLessThanOrEqual(PHONE.width);
    const next = bar.locator('button', { hasText: '↓' });
    if (await next.count()) {
      const nb = (await next.first().boundingBox())!;
      expect(Math.abs(nb.y + nb.height / 2 - (saveBox.y + saveBox.height / 2))).toBeLessThan(3); // on the same row as the two buttons
      await expect(next.first().locator('.next-short')).toBeVisible();
    }
  });

  test('a saved report: Back and the ⋯ menu share a row, the instrument is a link in the heading, the heading says what it is', async ({ page, request }) => {
    const { reportId, instrumentName } = await seedFinalized(request, `E2E-Phone-Head-${Date.now()}`);
    await page.goto(`/#/reports/${reportId}`);
    const del = page.locator('.detail-nav-row').getByRole('button', { name: 'Report actions' });
    await expect(del).toBeVisible({ timeout: TIMEOUT.ui });
    const [back, delBox] = await Promise.all([page.locator('.detail-nav-row .back-link').boundingBox(), del.boundingBox()]);
    expect(Math.abs(back!.y - delBox!.y)).toBeLessThan(3);
    // No full-width button any more: the instrument is a link on the line under the heading.
    await expect(page.locator('.detail-nav-row button:has-text("View instrument")')).toHaveCount(0);
    await expect(page.locator('.report-heading-meta .link-button')).toBeVisible();
    await expect(page.locator('.report-heading')).toContainText(instrumentName);
    await expect(page.locator('.report-heading-meta')).toContainText('2026-09-08 · Finalized');
  });
});

test('on a wide screen the notice is whole, there is no More button, and the full "Next" label shows', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await reachReview(page);
  const text = page.locator('#placeholder-notice .notice-text');
  const m = await text.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  expect(m.scroll).toBeLessThanOrEqual(m.client + 1);
  await expect(page.locator('#placeholder-notice .notice-more')).toBeHidden();
  const next = page.locator('.review-actions button', { hasText: 'Next ↓' });
  if (await next.count()) await expect(next.locator('.next-long')).toBeVisible();
});
