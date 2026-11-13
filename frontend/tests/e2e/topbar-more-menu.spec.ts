import { test, expect } from './coverage';

// The top bar's tabs never wrap or get cut off: the ones that do not fit leave from the right into a More menu.

test('tabs fold into More when narrow and come back when wide', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/#/home');
  await expect(page.getByTestId('tab-admin')).toBeVisible();
  await expect(page.getByTestId('topbar-more')).toBeHidden();

  await page.setViewportSize({ width: 900, height: 900 });
  await expect(page.getByTestId('topbar-more')).toBeVisible();
  await expect(page.getByTestId('tab-admin')).toBeHidden();
  // The first tabs stay; the row never scrolls sideways or wraps.
  await expect(page.getByTestId('tab-home')).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Main' });
  expect(await nav.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(page.getByTestId('topbar-more')).toBeHidden();
  await expect(page.getByTestId('tab-admin')).toBeVisible();
});

test('the More menu opens with the keyboard, opens a view and closes on Escape', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await page.goto('/#/home');
  const more = page.getByTestId('topbar-more');
  await expect(more).toBeVisible();
  await expect(more).toHaveAttribute('aria-haspopup', 'menu');
  await expect(more).toHaveAttribute('aria-expanded', 'false');

  await more.focus();
  await page.keyboard.press('Enter');
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();
  await expect(more).toHaveAttribute('aria-expanded', 'false');

  // Click outside closes it too.
  await more.click();
  await expect(menu).toBeVisible();
  await page.mouse.click(10, 400);
  await expect(menu).toBeHidden();

  // Pick Admin with the keyboard.
  await more.focus();
  await page.keyboard.press('Enter');
  const admin = page.getByRole('menuitem', { name: 'Admin' });
  await expect(admin).toBeVisible();
  await admin.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/admin/);
  await expect(menu).toBeHidden();

  // Admin is hidden in More, so More shows as active and the menu marks Admin as current.
  await expect(more).toHaveClass(/active/);
  await more.click();
  await expect(page.getByRole('menuitem', { name: 'Admin' })).toHaveAttribute('aria-current', 'page');
});

test('a phone keeps its bottom bar and has no top-bar More button', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/#/home');
  await expect(page.getByTestId('tab-more')).toBeVisible();
  await expect(page.getByTestId('topbar-more')).toBeHidden();
});
