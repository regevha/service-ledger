import { test, expect } from './coverage';
import { seedReport } from './helpers/api';
import { openReviewFromList } from './helpers/ui';

// The Review screen's field list opens with "What the report says" and a "N of M checked" counter
// that matches the fields still flagged for a second look.

test('the field list has a heading and a checked counter', async ({ page, request }) => {
  const marker = `E2E-ReviewHead-${Date.now()}`;
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: marker });
  await openReviewFromList(page, marker);
  await expect(page.getByRole('heading', { name: 'What the report says' })).toBeVisible();
  const counter = page.getByTestId('checked-count');
  await expect(counter).toHaveText(/^\d+ of \d+ checked$/);
  const [done, total] = ((await counter.textContent()) ?? '').match(/\d+/g)!.map(Number);
  expect(total).toBeGreaterThan(1);
  const flagged = await page.locator('.field.pending').count();
  expect(total - done).toBe(flagged);
});
