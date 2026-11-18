import { test, expect } from './coverage';

// Admin: Review metrics (how much of the reading was approved without an edit). The suite shares one
// database, so the check accepts either an empty period or real figures.

test('the accuracy page shows the goal and either figures or a plain empty message', async ({ page }) => {
  await page.goto('/#/admin/accuracy');
  await expect(page.getByRole('heading', { name: 'Review metrics' })).toBeVisible();
  await expect(page.getByText(/The goal is 99% of fields kept as read/)).toBeVisible();
  await expect(page.getByText(/tracks edits as a proxy for reading quality/)).toBeVisible();
  await page.getByRole('radio', { name: 'All' }).click();
  await expect(page.getByTestId('accuracy-empty').or(page.getByTestId('acc-fields'))).toBeVisible();
  if (await page.getByTestId('acc-fields').isVisible()) {
    await expect(page.getByTestId('acc-weeks')).toBeVisible();
    await expect(page.getByTestId('acc-fields')).toContainText('goal 99%');
    await expect(page.getByTestId('acc-structured')).toBeVisible();
    await expect(page.getByTestId('acc-free-text')).toBeVisible();
    await expect(page.getByTestId('acc-by-confidence')).toBeVisible();
    await expect(page.getByTestId('acc-by-prompt')).toBeVisible();
    await expect(page.getByTestId('acc-filled-by-hand')).toBeVisible();
  }
});

test('Home links its fields kept as read figure to Review metrics', async ({ page }) => {
  await page.goto('/#/');
  const metric = page.getByTestId('home-tile-accuracy');
  await expect(metric).toContainText('Fields kept as read');
  await metric.getByRole('link', { name: 'View review metrics' }).click();
  await expect(page).toHaveURL(/#\/admin\/accuracy$/);
  await expect(page.getByTestId('accuracy-screen')).toBeVisible();
});
