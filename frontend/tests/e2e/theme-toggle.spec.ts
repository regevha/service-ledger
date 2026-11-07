import { test, expect } from './coverage';

// Light / dark: starts in the device's setting, the top-bar button and Admin > Appearance change it,
// and the choice is kept in this browser.

const bg = (page: import('@playwright/test').Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test('the first visit follows the device; the toggle then keeps the choice', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/#/new');
  const html = page.locator('html');
  await expect(html).not.toHaveAttribute('data-theme', /.+/);
  const darkBg = await bg(page);
  const toggle = page.getByTestId('theme-toggle');
  await expect(toggle).toHaveAccessibleName('Switch to light mode');

  await toggle.click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expect(toggle).toHaveAccessibleName('Switch to dark mode');
  expect(await bg(page)).not.toBe(darkBg);

  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expect(page.getByTestId('theme-toggle')).toHaveAccessibleName('Switch to dark mode');
});

test('a light device can be switched to dark, and Admin shows the same choice', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/#/admin/appearance');
  const group = page.getByRole('radiogroup', { name: 'Colour mode' });
  await expect(group.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
  await group.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(group.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('theme-toggle')).toHaveAccessibleName('Switch to light mode');
});
