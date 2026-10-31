import { test, expect } from './coverage';
import { seedReport } from './helpers/api';
import { openReviewFromList } from './helpers/ui';

// On a wide screen the Review screen has a left-hand list of the fields; pressing one jumps to it.

test('the field jump list focuses the field it names', async ({ page, request }) => {
  await page.setViewportSize({ width: 1700, height: 1000 });
  const marker = `E2E-JumpList-${Date.now()}`;
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: marker });
  await openReviewFromList(page, marker);
  const rail = page.getByTestId('review-rail');
  await expect(rail).toBeVisible();
  const items = rail.getByRole('button');
  expect(await items.count()).toBeGreaterThan(2);
  await items.nth(1).click();
  await expect(page.locator('.field-list :focus')).toHaveCount(1);
});
