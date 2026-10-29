import { test, expect } from './coverage';
import { BACKEND_PORT } from '../../playwright.config';
import { TIMEOUT } from './timeouts';

// Phone review 2 (2026-10-26), the third group: one sort menu, the page without a card inside a card,
// Delete in a menu on Instruments, a tidy Templates header, Analytics bars with the number on the name's line,
// and the wording of the upload box.

const API_BASE = `http://localhost:${BACKEND_PORT}`;
const PHONE = { width: 412, height: 915 };

test.describe('on a phone', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test('Reports: one Sort by menu replaces the row of column names, and it sorts', async ({ page, request }) => {
    await request.post(`${API_BASE}/reports`, { data: { technician_name: `E2E-Sort-${Date.now()}` } });
    await page.goto('/#/reports');
    const select = page.getByTestId('sort-select');
    await expect(select).toBeVisible({ timeout: TIMEOUT.ui });
    await expect(page.locator('.report-row-head')).toBeHidden();
    await select.selectOption('date:desc');
    await expect(page.locator('[data-testid="result-count"]')).toContainText('sorted by report date');
    await select.selectOption('');
    await expect(page.locator('[data-testid="result-count"]')).not.toContainText('sorted by');
  });

  test('the page is not a card inside a card: the content uses the whole width', async ({ page }) => {
    await page.goto('/#/reports');
    const box = await page.locator('.app-shell').boundingBox();
    expect(box!.x).toBeLessThan(1);
    expect(box!.width).toBeGreaterThan(PHONE.width - 1);
  });

  test('Instruments: Delete is in a ⋯ menu, and still asks before deleting', async ({ page }) => {
    await page.goto('/#/instruments');
    await expect(page.locator('.instrument-row.template-row-body').first()).toBeVisible({ timeout: TIMEOUT.ui });
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: /^More actions for/ }).first().click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(page.locator('.banner-warn, [role="alertdialog"]').first()).toBeVisible();
  });

  test('Templates: the title has its own line and Compare / Field aliases are in a menu', async ({ page }) => {
    await page.goto('/#/templates');
    const title = page.locator('.templates-head .section-title');
    await expect(title).toBeVisible({ timeout: TIMEOUT.ui });
    const newBtn = page.getByRole('button', { name: '+ New template' });
    const [t, n] = await Promise.all([title.boundingBox(), newBtn.boundingBox()]);
    expect(n!.y).toBeGreaterThan(t!.y + t!.height - 1); // under the title, not beside it
    await expect(page.locator('#compare-templates')).toHaveCount(0);
    await page.getByRole('button', { name: 'More template actions' }).click();
    await expect(page.getByRole('menuitem')).toHaveText(['Compare templates', 'Field aliases']);
  });

  test('Analytics bars: the number is on the name line, the bar under it, and an empty bar is just "none"', async ({ page }) => {
    await page.goto('/#/analytics');
    const toggle = page.locator('.chart-toggle', { hasText: 'Finalized reports per instrument' }).first();
    await expect(toggle).toBeVisible({ timeout: TIMEOUT.ui });
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    const row = page.locator('.bar-row').first();
    await expect(row).toBeVisible();
    const [label, value, track] = await Promise.all([
      row.locator('.bar-row-label').boundingBox(),
      row.locator('.bar-value').boundingBox(),
      row.locator('.bar-track').boundingBox(),
    ]);
    expect(Math.abs(label!.y - value!.y)).toBeLessThan(label!.height); // same line
    expect(value!.x).toBeGreaterThan(label!.x);
    if (track) expect(track.y).toBeGreaterThan(label!.y + 8);
    const empty = page.locator('.bar-row-empty .bar-track');
    for (let i = 0; i < (await empty.count()); i++) await expect(empty.nth(i)).toBeHidden();
  });

  test('New report: the upload box talks about taking a photo', async ({ page }) => {
    await page.goto('/#/new');
    await expect(page.locator('.dropzone .primary')).toHaveText('Take a photo or choose a file');
  });
});

test('on a wide screen: Delete stays a button, the sort row stays, the old wording stays', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/#/instruments');
  await expect(page.getByRole('button', { name: 'Delete', exact: true }).first()).toBeVisible({ timeout: TIMEOUT.ui });
  await page.goto('/#/reports');
  await expect(page.locator('.sort-select-wrap')).toBeHidden();
  await expect(page.getByTestId('sort-date')).toBeVisible({ timeout: TIMEOUT.ui });
  await page.goto('/#/new');
  await expect(page.locator('.dropzone .primary')).toHaveText('Click to choose a scan or PDF, or drop it here');
});
