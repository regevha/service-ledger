import { test, expect } from './coverage';
import { seedReport } from './helpers/api';

test('Home shows waiting reports and opens the new-report screen', async ({ page, request }) => {
  const tech = `home-${Date.now()}`;
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: tech });

  await page.goto('/#/home');
  await expect(page.getByTestId('home-screen')).toBeVisible();
  await expect(page.getByTestId('tab-home')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('home-tile-review')).toBeVisible();
  await expect(page.getByTestId('home-waiting-row').first()).toBeVisible();
  await expect(page.getByTestId('home-tile-review').locator('.stat-value')).not.toHaveText('–');

  await page.getByTestId('home-waiting-row').first().getByRole('button', { name: 'Review' }).click();
  await expect(page).toHaveURL(/#\/reports\//);

  await page.goto('/#/home');
  await page.getByTestId('home-new-report').click();
  await expect(page.getByTestId('tab-new')).toHaveAttribute('aria-current', 'page');
});

test('Home is reachable from More on a phone-width screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/#/new');
  await page.getByTestId('tab-more').click();
  await page.getByRole('button', { name: /Home/ }).first().click();
  await expect(page.getByTestId('home-screen')).toBeVisible();
});
