import { test, expect } from './coverage';

// The offline notice on a phone: readable inside the screen, nothing scrolls sideways.
test.describe('Offline on a phone', { tag: '@phone' }, () => {
  test('the banner fits the screen and goes when the connection is back', async ({ page, context }) => {
    await page.goto('/#/reports');
    await context.setOffline(true);
    const banner = page.getByTestId('offline-banner');
    await expect(banner).toBeVisible();
    const box = (await banner.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(-0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 0.5);
    const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    expect(scroll, 'the page scrolls sideways').toBeLessThanOrEqual(client + 1);
    await context.setOffline(false);
    await expect(banner).toHaveCount(0);
  });
});
