import { type APIRequestContext } from '@playwright/test';
import { test, expect } from './coverage';
import { createNumericModel } from './numeric-fixture';
import { TIMEOUT } from './timeouts';
import { seedReport } from './helpers/api';

// Phone review 2 (2026-10-26): the Fields | Scan switch in dark mode, the toast, the instrument's report
// history rows, Cancel while editing a finalized report, and how a read-only report looks.

const PHONE = { width: 412, height: 915 };
const LONG_NAME = 'Demo - FACSAria III preventive maintenance with a rather long title (WO-04271950)';

async function seed(request: APIRequestContext): Promise<{ reportId: string; instrumentId: string }> {
  const model = await createNumericModel(request, 'E2E-PhoneBugs');
  const { reportId, instrumentId } = await seedReport(request, {
    model,
    reportType: 'installation_upgrade',
    technician: LONG_NAME,
    fields: { cst_beads_lot: 'LOT-ORIG' },
    reportDate: '2026-05-09',
    finalize: true,
  });
  return { reportId, instrumentId };
}

test.describe('on a phone', { tag: '@phone' }, () => {

  test('dark mode: the selected Fields | Scan button is readable', async ({ browser, request }) => {
    const { reportId } = await seed(request);
    const context = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true, colorScheme: 'dark' });
    const page = await context.newPage();
    await page.goto(`/#/reports/${reportId}`);
    const active = page.locator('.view-switch-button.active');
    await expect(active).toBeVisible({ timeout: TIMEOUT.ui });
    const lum = (rgb: string) => {
      const [r, g, b] = (rgb.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map((v) => {
        const c = Number(v) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const { fg, bg } = await active.evaluate((el) => ({ fg: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor }));
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    expect((hi + 0.05) / (lo + 0.05)).toBeGreaterThan(4.5);
    // …and the idle button too, against the switch's own background.
    const idle = page.locator('.view-switch-button:not(.active)');
    const sw = await page.locator('.view-switch').evaluate((el) => getComputedStyle(el).backgroundColor);
    const idleFg = await idle.evaluate((el) => getComputedStyle(el).color);
    const [h2, l2] = [lum(idleFg), lum(sw)].sort((a, b) => b - a);
    expect((h2 + 0.05) / (l2 + 0.05)).toBeGreaterThan(4.5);
    await context.close();
  });

  test('the Saved toast does not cover the save bar', async ({ page, request }) => {
    const { reportId } = await seed(request);
    await page.goto(`/#/reports/${reportId}`);
    await page.click('.review-actions button:has-text("Edit")');
    await page.click('.review-actions button:has-text("Save corrections")');
    const toast = page.locator('.toast');
    await expect(toast).toBeVisible();
    const [t, bar] = await Promise.all([toast.boundingBox(), page.locator('.review-actions').boundingBox()]);
    const overlap = t!.y < bar!.y + bar!.height && t!.y + t!.height > bar!.y;
    expect(overlap).toBe(false);
  });

  test("an instrument's report history keeps the type and the date on one line each", async ({ page, request }) => {
    const { instrumentId } = await seed(request);
    await page.goto(`/#/reports/instrument/${instrumentId}`);
    const row = page.locator('.instrument-report-row-body').first();
    await expect(row).toBeVisible({ timeout: TIMEOUT.ui });
    const type = await row.locator('[data-label="Type"]').boundingBox();
    const date = await row.locator('[data-label="Report date"]').boundingBox();
    const tech = await row.locator('[data-label="Lab manager"]').boundingBox();
    expect(type!.height).toBeLessThan(26); // "Installation / upgrade" is one line
    expect(date!.height).toBeLessThan(24); // 2026-05-09 is not split
    expect(tech!.height).toBeLessThan(24); // the long lab-manager text is cut with an ellipsis, not wrapped
    expect(tech!.y).toBeGreaterThan(date!.y); // under the date
  });

  test('Cancel while editing a finalized report throws the changes away', async ({ page, request }) => {
    const { reportId } = await seed(request);
    let patches = 0;
    page.on('request', (r) => r.method() === 'PATCH' && r.url().includes('/fields') && patches++);
    await page.goto(`/#/reports/${reportId}`);
    const lot = page.locator('.field', { hasText: 'Cst beads lot' }).locator('input, textarea').first();
    await expect(lot).toHaveValue('LOT-ORIG', { timeout: TIMEOUT.ui });
    await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
    await page.click('.review-actions button:has-text("Edit")');
    await lot.fill('LOT-CHANGED');
    await page.click('.review-actions button:has-text("Cancel")');
    await expect(page.locator('.review-actions button:has-text("Edit")')).toBeVisible();
    await expect(lot).toHaveValue('LOT-ORIG');
    expect(patches).toBe(0);
  });

  test('a finalized report reads as text: no calendar button and no extraction notes, until Edit', async ({ page, request }) => {
    const { reportId } = await seed(request);
    await page.goto(`/#/reports/${reportId}`);
    await expect(page.locator('.field-list.read-only')).toBeVisible({ timeout: TIMEOUT.ui });
    await expect(page.locator('.field-list .date-input-pick')).toBeHidden();
    await expect(page.locator('.field-list .field-note').first()).toBeHidden();
    await page.click('.review-actions button:has-text("Edit")');
    await expect(page.locator('.field-list .date-input-pick')).toBeVisible();
    await expect(page.locator('.field-list .field-note').first()).toBeVisible();
  });
});
