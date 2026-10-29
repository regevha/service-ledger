import { test, expect } from './coverage';
import { BACKEND_PORT } from '../../playwright.config';
import { TIMEOUT } from './timeouts';

// Phone review of 2026-10-25, item 8 and 19: controls are big enough for a thumb, the tab labels are
// readable, and the keyboard leaves serial and part numbers alone.

const TABS = ['New report', 'Reports', 'Analytics', 'Templates', 'Instruments'];

async function tooSmall(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const sel = "button, select, input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]):not(.date-input-native)";
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || s.visibility === 'hidden' || s.display === 'none') continue;
      if (el.closest('.tag-chip')) continue; // the tiny remove x inside a chip is not a primary control
      if (r.height < 43.5) out.push(`${el.tagName.toLowerCase()} ${Math.round(r.width)}x${Math.round(r.height)} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 24)}"`);
    }
    return out;
  });
}

test.describe('on a phone', () => {
  test.use({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true });

  test('buttons, selects and text boxes are at least 44px high on every tab', async ({ page, request }) => {
    // A report in the list, so the sort buttons above the cards are measured too.
    await request.post(`http://localhost:${BACKEND_PORT}/reports`, { data: { technician_name: `E2E-Touch-${Date.now()}` } });
    await page.goto('/');
    for (const tab of TABS) {
      await page.click(`.view-tab:has-text("${tab}")`);
      // The tab is selected and its data has arrived, so every control is on the page to be measured.
      await expect(page.locator('.view-tab.active')).toContainText(tab);
      await page.waitForLoadState('networkidle');
      // Open the filters where there are some, so their controls are measured too.
      const show = page.locator('button:has-text("Show filters")');
      if (await show.count()) await show.first().click();
      if (tab === 'Reports') await expect(page.locator('.sort-select').first()).toBeVisible();
      expect(await tooSmall(page), tab).toEqual([]);
    }
  });

  test('the tab labels are readable and all five still fit without the page scrolling sideways', async ({ page }) => {
    await page.goto('/');
    const size = await page.locator('.view-tab').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThanOrEqual(12);
    const fits = await page.evaluate(() => {
      const tabs = document.querySelector('.view-tabs')!;
      return { scroll: tabs.scrollWidth, client: tabs.clientWidth, doc: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth };
    });
    expect(fits.scroll).toBeLessThanOrEqual(fits.client + 1);
    expect(fits.doc).toBeLessThanOrEqual(fits.vw);
  });

  test('a serial number box asks the keyboard for capitals and no correction', async ({ page }) => {
    await page.goto('/#/instruments');
    await page.click('button:has-text("New instrument")');
    const serial = page.locator('label', { hasText: 'Serial number' }).locator('input');
    await expect(serial).toHaveAttribute('autocapitalize', 'characters');
    await expect(serial).toHaveAttribute('autocorrect', 'off');
    await expect(serial).toHaveAttribute('spellcheck', 'false');
  });
});

test('on a wide screen the compact buttons are unchanged', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/#/templates');
  const small = page.locator('.btn.small').first();
  await expect(small).toBeVisible({ timeout: TIMEOUT.ui });
  expect((await small.boundingBox())!.height).toBeLessThan(40);
});
