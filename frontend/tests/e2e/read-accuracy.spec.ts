import { test, expect } from './coverage';

// Admin: Reading accuracy (how much of the reading was approved without an edit). The suite shares one
// database, so the check accepts either an empty period or real figures.

test('the accuracy page shows the goal and either figures or a plain empty message', async ({ page }) => {
  await page.goto('/#/admin/accuracy');
  await expect(page.getByRole('heading', { name: 'Reading accuracy' })).toBeVisible();
  await expect(page.getByText(/The goal is 99% of fields/)).toBeVisible();
  await page.getByRole('radio', { name: 'All' }).click();
  await expect(page.getByTestId('accuracy-empty').or(page.getByTestId('acc-fields'))).toBeVisible();
  if (await page.getByTestId('acc-fields').isVisible()) {
    await expect(page.getByTestId('acc-weeks')).toBeVisible();
    await expect(page.getByTestId('acc-fields')).toContainText('goal 99%');
    await expect(page.getByTestId('acc-by-confidence')).toBeVisible();
    await expect(page.getByTestId('acc-by-prompt')).toBeVisible();
    await expect(page.getByTestId('acc-filled-by-hand')).toBeVisible();
  }
});

test('Home links its accuracy figure to the accuracy page', async ({ page }) => {
  await page.goto('/#/');
  await page.getByTestId('home-accuracy-link').click();
  await expect(page).toHaveURL(/#\/admin\/accuracy$/);
  await expect(page.getByTestId('accuracy-screen')).toBeVisible();
});
