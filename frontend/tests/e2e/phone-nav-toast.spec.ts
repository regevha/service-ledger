import { test, expect } from './coverage';
import { uniqueFixture } from './unique-upload';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIMEOUT } from './timeouts';

// The phone's five tabs are a bar at the bottom of the screen with icons; a save shows a short "Saved" message.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'confident-scan.pdf');
const PHONE = { width: 412, height: 915 };

test.describe('on a phone', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test('the tabs are a bar at the bottom, five equal buttons with an icon and a label', async ({ page }) => {
    await page.goto('/');
    const bar = page.locator('.view-tabs');
    await expect(bar).toBeVisible();
    const barBox = (await bar.boundingBox())!;
    expect(Math.round(barBox.y + barBox.height)).toBe(PHONE.height); // flush with the bottom edge
    expect(barBox.width).toBe(PHONE.width);
    const tabs = page.locator('.view-tab');
    expect(await tabs.count()).toBe(5);
    const widths = await tabs.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)));
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    for (let i = 0; i < 5; i++) {
      await expect(tabs.nth(i).locator('svg.tab-icon')).toBeVisible();
      expect((await tabs.nth(i).boundingBox())!.height).toBeGreaterThanOrEqual(55);
    }
    // It stays put while the page scrolls.
    await page.click('.view-tab:has-text("Instruments")');
    await page.mouse.wheel(0, 600);
    const after = (await bar.boundingBox())!;
    expect(Math.round(after.y + after.height)).toBe(PHONE.height);
    await expect(page.locator('.view-tab.active')).toContainText('Instruments');
  });

  test('content is never hidden behind the bar: the last thing on a page can be scrolled clear of it', async ({ page }) => {
    await page.goto('/#/templates');
    await expect(page.locator('.view-tabs')).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const lastBottom = await page.evaluate(() => document.querySelector('.app-shell')!.getBoundingClientRect().bottom);
    const barTop = (await page.locator('.view-tabs').boundingBox())!.y;
    expect(lastBottom).toBeLessThanOrEqual(barTop);
  });

  test('saving corrections shows "Saved" for a moment, then it goes', async ({ page }) => {
    await page.goto('/');
    await page.click('.view-tab:has-text("New report")');
    await page.locator('input[type="file"]').setInputFiles(uniqueFixture(FIXTURE));
    await page.click('button:has-text("Upload & classify")');
    await page.waitForSelector('.field-list', { timeout: TIMEOUT.flow });
    await page.click('button:has-text("Save corrections")');
    const toast = page.locator('.toast');
    await expect(toast).toHaveText('Saved');
    // It sits above the bottom bar, not under it.
    const [t, bar] = await Promise.all([toast.boundingBox(), page.locator('.view-tabs').boundingBox()]);
    expect(t!.y + t!.height).toBeLessThanOrEqual(bar!.y);
    await expect(toast).toHaveCount(0, { timeout: 8000 });
  });
});

test('on a wide screen the tabs stay at the top as text, with no icons', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const bar = page.locator('.view-tabs');
  await expect(bar).toBeVisible();
  expect((await bar.boundingBox())!.y).toBeLessThan(200);
  await expect(page.locator('svg.tab-icon').first()).toBeHidden();
});
