import { test, expect } from './coverage';
import { seedReport } from './helpers/api';

test('Today shows waiting reports and opens the new-report screen', async ({ page, request }) => {
  const tech = `today-${Date.now()}`;
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: tech });

  await page.goto('/#/home');
  await expect(page.getByTestId('today-screen')).toBeVisible();
  await expect(page.getByTestId('tab-home')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('today-tile-review')).toBeVisible();
  await expect(page.getByTestId('today-waiting-row').first()).toBeVisible();
  await expect(page.getByTestId('today-tile-review').locator('.stat-value')).not.toHaveText('–');

  await page.getByTestId('today-waiting-row').first().getByRole('button', { name: 'Review' }).click();
  await expect(page).toHaveURL(/#\/reports\//);

  await page.goto('/#/home');
  await page.getByTestId('today-new-report').click();
  await expect(page.getByTestId('tab-new')).toHaveAttribute('aria-current', 'page');
});

test('Today is reachable from More on a phone-width screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/');
  await page.getByTestId('tab-more').click();
  await page.getByRole('button', { name: /Today/ }).first().click();
  await expect(page.getByTestId('today-screen')).toBeVisible();
});
