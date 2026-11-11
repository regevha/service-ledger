import { test, expect } from './coverage';
import type { Page } from '@playwright/test';
import { seedReport } from './helpers/api';
import { askInSheet } from './helpers/askSheet';

// The pinned search line on a phone: in view, inside the screen, thumb-sized, and working by tap.

async function noSideScroll(page: Page) {
  const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(scroll, 'the page scrolls sideways').toBeLessThanOrEqual(client + 1);
}

async function askByTap(page: Page, text: string) {
  await askInSheet(page, text);
  await expect(page.getByTestId('active-search')).toBeVisible();
}

test.describe('The search line on a phone', { tag: '@phone' }, () => {
  test('chips and Clear are thumb-sized and inside the screen, and nothing scrolls sideways', async ({ page }) => {
    await page.goto('/#/reports');
    await askByTap(page, 'maintenance in 2025 at Bar-Ilan University');
    const width = page.viewportSize()!.width;
    const chips = page.getByTestId('active-search-chip');
    expect(await chips.count()).toBeGreaterThanOrEqual(2);
    for (const el of [chips.first(), page.getByTestId('active-search-clear')]) {
      const b = (await el.boundingBox())!;
      expect(b.height).toBeGreaterThanOrEqual(43.5);
    }
    const clear = (await page.getByTestId('active-search-clear').boundingBox())!;
    expect(clear.x + clear.width).toBeLessThanOrEqual(width + 0.5);
    await noSideScroll(page);
  });

  test('the line stays at the top while the page scrolls, on Home and on Analytics', async ({ page }) => {
    await page.goto('/#/reports');
    await askByTap(page, 'maintenance in 2025');
    for (const route of ['home', 'analytics']) {
      await page.evaluate((r) => { window.location.hash = `#/${r}`; }, route);
      const line = page.getByTestId('active-search');
      await expect(line).toBeVisible();
      await page.evaluate(() => {
        const pad = document.createElement('div');
        pad.style.height = '3000px';
        (document.querySelector('.wrap') ?? document.body).appendChild(pad);
        window.scrollTo(0, 1500);
      });
      expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(200);
      const b = (await line.boundingBox())!;
      expect(b.y).toBeGreaterThanOrEqual(-1);
      expect(b.y).toBeLessThanOrEqual(2);
      await page.evaluate(() => window.scrollTo(0, 0));
    }
  });

  test('tapping a chip takes that condition out; Clear search ends the search', async ({ page, request }) => {
    const tech = 'Phone Lineson';
    await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: tech });
    await seedReport(request, { model: 'LSRFortessa', reportType: 'preventive_maintenance', technician: tech });
    await page.goto('/#/reports');
    await askByTap(page, `repairs by ${tech.toLowerCase()}`);
    const chips = page.getByTestId('active-search-chip');
    await expect(chips).toHaveCount(2);
    await chips.filter({ hasText: 'Repair' }).tap();
    await expect(chips).toHaveCount(1);
    await expect(page.getByTestId('report-group').first()).toBeVisible();
    await page.getByTestId('active-search-clear').tap();
    await expect(page.getByTestId('active-search')).toHaveCount(0);
    await noSideScroll(page);
  });
});
