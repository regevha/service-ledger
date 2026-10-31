import { test, expect } from './coverage';

// Upload screen: a "What happens next" card, and on a phone Take photo / Browse files buttons.

test('the upload screen explains what happens next', async ({ page }) => {
  await page.goto('/');
  const card = page.getByTestId('intake-next-card');
  await expect(card).toBeVisible();
  await expect(card.getByText('What happens next')).toBeVisible();
  await expect(page.getByTestId('intake-phone-pick')).toHaveCount(0);
});

test.describe('on a phone', { tag: '@phone' }, () => {
  test('Take photo and Browse files are offered', async ({ page }) => {
    await page.goto('/');
    const pick = page.getByTestId('intake-phone-pick');
    await expect(pick).toBeVisible();
    await expect(pick.getByRole('button', { name: 'Take photo' })).toBeVisible();
    await expect(pick.getByRole('button', { name: 'Browse files' })).toBeVisible();
  });
});
