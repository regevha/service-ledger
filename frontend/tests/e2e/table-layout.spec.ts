import { test, expect } from './coverage';

// Layout regressions from the 2026-10-24 UI review: the table captions must sit
// over their columns (header and rows are separate grids, so an "auto" column
// used to size itself per row), and a phone-width screen must not scroll sideways
// (the five tabs are wider than a phone).

async function maxColumnDrift(page: import('@playwright/test').Page, head: string, body: string) {
  return page.evaluate(
    ([h, b]) => {
      const lefts = (el: Element) => [...el.children].map((c) => Math.round(c.getBoundingClientRect().left));
      const headEl = document.querySelector(h);
      const rows = [...document.querySelectorAll(b)];
      if (!headEl || rows.length === 0) return null;
      const headLefts = lefts(headEl);
      return Math.max(...headLefts.flatMap((x, i) => rows.map((r) => Math.abs(lefts(r)[i] - x))));
    },
    [head, body]
  );
}

for (const width of [1440, 1100]) {
  test(`table captions line up with their columns at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');

    await page.click('.view-tab:has-text("Instruments")');
    await expect(page.locator('.instrument-row.template-row-body').first()).toBeVisible();
    expect(await maxColumnDrift(page, '.instrument-row.template-row-head', '.instrument-row.template-row-body')).toBe(0);

    await page.click('.view-tab:has-text("Reports")');
    await expect(page.locator('.report-row-body').first()).toBeVisible();
    expect(await maxColumnDrift(page, '.report-row-head', '.report-row-body')).toBe(0);
  });
}

test('no screen scrolls sideways at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  for (const tab of ['New report', 'Reports', 'Analytics', 'Templates', 'Instruments']) {
    await page.click(`.view-tab:has-text("${tab}")`);
    const [scrollWidth, innerWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(scrollWidth, `${tab} tab`).toBeLessThanOrEqual(innerWidth);
  }
});

test('the Reports search box is styled like the other filters', async ({ page }) => {
  await page.goto('/');
  await page.click('.view-tab:has-text("Reports")');
  const [search, lab] = await Promise.all([
    page.locator('input[type="search"]').evaluate((e) => getComputedStyle(e).borderRadius),
    page.locator('.filter-row select').first().evaluate((e) => getComputedStyle(e).borderRadius),
  ]);
  expect(search).toBe(lab);
});

test('a template with a seeded choice field can be opened and saved', async ({ page }) => {
  await page.goto('/');
  await page.click('.view-tab:has-text("Templates")');
  // The generic repair row (any model) carries the retest_result choice field.
  const row = page.locator('.template-row-body', { hasText: 'Malfunction / repair' }).filter({ hasText: '(any model)' }).first();
  await row.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByText('needs at least one option')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled();
});
