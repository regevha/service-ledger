import { test, expect } from './coverage';
import { seedReport } from './helpers/api';
import { openReviewFromList } from './helpers/ui';

// Search on the review screen: find words in the values on screen (text boxes, table cells),
// highlight them without hiding anything, step through the matches, and work on a finalized
// (read-only) report too. Values come from the seeded report so the words are known.

const ROWS = [
  { part_name: 'Zqx O-ring kit', part_number: 'ZQ-100', qty: 2 },
  { part_name: 'Zqx sheath filter', part_number: 'ZQ-220', qty: 1 },
  { part_name: 'Wqv tubing', part_number: 'PT-9', qty: 4 },
];

async function seed(request: Parameters<typeof seedReport>[0], tag: string, finalize = false) {
  const marker = `E2E-Search-${tag}-${Date.now()}`;
  await seedReport(request, {
    model: 'LSRFortessa',
    reportType: 'repair',
    technician: marker,
    fields: { components_replaced: ROWS },
    finalize,
  });
  return marker;
}

test('searching marks the matching table rows, keeps every field showing and steps through the matches', async ({
  page,
  request,
}) => {
  await openReviewFromList(page, await seed(request, 'rows'));
  const fieldsBefore = await page.locator('.field').count();
  const checkedBefore = await page.getByTestId('checked-count').textContent();

  // Ctrl+F opens this search, with the keyboard in its box.
  await page.keyboard.press('Control+f');
  const box = page.getByLabel('Search the values on this screen');
  await expect(box).toBeFocused();

  // Case does not matter, and every word must be in the row, in any order: "100 ZQX" finds the O-ring row only.
  await box.fill('100 ZQX');
  await expect(page.getByTestId('review-search-count')).toHaveText('1 of 1');
  const hits = page.locator('[data-search-hit="true"]');
  await expect(hits).toHaveCount(1);
  await expect(hits.first().locator('input').first()).toHaveValue('Zqx O-ring kit');

  // Two rows have "zqx"; Enter goes to the next, Shift+Enter back, both wrap round.
  await box.fill('zqx');
  await expect(page.getByTestId('review-search-count')).toHaveText('1 of 2');
  await expect(page.locator('[data-search-current="true"] input').first()).toHaveValue('Zqx O-ring kit');
  await box.press('Enter');
  await expect(page.getByTestId('review-search-count')).toHaveText('2 of 2');
  await expect(page.locator('[data-search-current="true"] input').first()).toHaveValue('Zqx sheath filter');
  await box.press('Enter');
  await expect(page.getByTestId('review-search-count')).toHaveText('1 of 2');
  await box.press('Shift+Enter');
  await expect(page.getByTestId('review-search-count')).toHaveText('2 of 2');

  // Words that are nowhere say so.
  await box.fill('zqx nothing-like-this');
  await expect(page.getByTestId('review-search-count')).toHaveText('No matches');
  await expect(page.locator('[data-search-hit="true"]')).toHaveCount(0);

  // Nothing was hidden, changed or marked as checked by searching.
  await expect(page.locator('.field')).toHaveCount(fieldsBefore);
  await expect(page.getByTestId('checked-count')).toHaveText(checkedBefore ?? '');
  await expect(page.locator('.object-array-row:not(.object-array-head)')).toHaveCount(ROWS.length);
});

test('Escape closes the search, clears the marks and puts the keyboard back on the field being edited', async ({
  page,
  request,
}) => {
  await openReviewFromList(page, await seed(request, 'esc'));
  const partName = page.getByLabel('Part name, row 1');
  await partName.focus();

  await page.keyboard.press('Control+f');
  const box = page.getByLabel('Search the values on this screen');
  await box.fill('zqx');
  await expect(page.locator('[data-search-hit="true"]')).toHaveCount(2);

  await box.press('Escape');
  await expect(page.getByTestId('review-search')).toHaveCount(0);
  await expect(page.locator('[data-search-hit], [data-search-current]')).toHaveCount(0);
  await expect(partName).toBeFocused();
  await expect(partName).toHaveValue('Zqx O-ring kit');
});

test('the search icon opens it, and a value typed while searching is found', async ({ page, request }) => {
  await openReviewFromList(page, await seed(request, 'icon'));

  await page.getByTestId('review-search-toggle').click();
  const box = page.getByLabel('Search the values on this screen');
  await expect(box).toBeFocused();
  await box.fill('wqv');
  await expect(page.getByTestId('review-search-count')).toHaveText('1 of 1');

  // Editing a cell while the search is open: the new value is found without searching again.
  await page.getByLabel('Part name, row 3').fill('Wqv tubing, spare wqv');
  await expect(page.getByTestId('review-search-count')).toHaveText('1 of 1');
  await page.getByLabel('Part name, row 1').fill('wqv O-ring kit');
  await expect(page.getByTestId('review-search-count')).toHaveText('1 of 2');
  await expect(page.locator('[data-search-hit="true"]')).toHaveCount(2);
});

test('search works on a finalized (read-only) report', async ({ page, request }) => {
  await openReviewFromList(page, await seed(request, 'final', true));
  await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible();

  await page.keyboard.press('Control+f');
  const box = page.getByLabel('Search the values on this screen');
  await expect(box).toBeFocused();
  await box.fill('zq-220');
  await expect(page.getByTestId('review-search-count')).toHaveText('1 of 1');
  await expect(page.locator('[data-search-current="true"] input').first()).toHaveValue('Zqx sheath filter');
});
