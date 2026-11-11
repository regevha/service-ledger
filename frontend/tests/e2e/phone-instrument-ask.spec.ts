import { expect, test } from '@playwright/test';
import { askInSheet } from './helpers/askSheet';

// On a phone the question is typed in the sheet. A question about instruments closes the sheet and opens Instruments.

test('a question about instruments asked in the phone sheet opens Instruments', async ({ page }) => {
  await page.route('**/reports/parse-search', (route) =>
    route.fulfill({
      json: {
        filters: { repairs_op: 'gte', repairs_count: '0' },
        understood: [{ key: 'repairs', label: 'At least 0 repairs' }],
        source: 'ai',
        notes: [],
        target: 'instruments',
      },
    }),
  );
  await page.goto('/#/home');
  await askInSheet(page, 'instruments with any number of repairs');
  await expect(page.getByTestId('ask-sheet')).toHaveCount(0);
  await expect(page.getByTestId('instrument-ask')).toContainText('At least 0 repairs');
  await expect(page.getByTestId('instrument-repairs').first()).toBeVisible();
});
