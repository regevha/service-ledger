import { test, expect } from './coverage';

// The top bar's tabs never wrap or get cut off: the ones that do not fit leave from the right into a More menu.
// The current view's tab never folds (user decision, #322), and Admin sits at the right end on wide screens.

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

test('Admin sits at the right end of the tab row on a wide screen', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/#/home');
  const admin = (await page.getByTestId('tab-admin').boundingBox())!;
  const instruments = (await page.getByTestId('tab-instruments').boundingBox())!;
  const nav = (await page.getByRole('navigation', { name: 'Main' }).boundingBox())!;
  // A wide gap after Instruments, and Admin ends at the row's right edge.
  expect(admin.x - (instruments.x + instruments.width)).toBeGreaterThan(100);
  expect(Math.abs(nav.x + nav.width - (admin.x + admin.width))).toBeLessThan(2);
});

test("the current view's tab never folds into More", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/#/admin');
  await expect(page.getByTestId('tab-admin')).toBeVisible();

  // Narrow enough that Admin, the last tab, would be the first to fold.
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(page.getByTestId('topbar-more')).toBeVisible();
  await expect(page.getByTestId('tab-admin')).toBeVisible();
  await expect(page.getByTestId('tab-admin')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('topbar-more')).not.toHaveClass(/active/);
  await page.getByTestId('topbar-more').click();
  await expect(page.getByRole('menuitem', { name: 'Admin' })).toHaveCount(0);
  await expect(page.getByRole('menuitem').first()).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Main' });
  expect(await nav.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
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
  await expect(page.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('End');
  await expect(admin).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/admin/);
  await expect(menu).toBeHidden();

  // Admin is now the current view, so it comes back into the row and another tab folds instead.
  await expect(page.getByTestId('tab-admin')).toBeVisible();
  await expect(page.getByTestId('tab-admin')).toHaveAttribute('aria-current', 'page');
  await expect(more).not.toHaveClass(/active/);
  await more.click();
  await expect(page.getByRole('menuitem', { name: 'Admin' })).toHaveCount(0);
});

test('a phone keeps its bottom bar and has no top-bar More button', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/#/home');
  await expect(page.getByTestId('tab-more')).toBeVisible();
  await expect(page.getByTestId('topbar-more')).toBeHidden();
});
