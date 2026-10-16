import { type APIRequestContext, type Page } from '@playwright/test';
import { test, expect } from './coverage';
import { BACKEND_PORT } from '../../playwright.config';

// Sorting the Reports table by clicking a column header. The rules themselves
// (blank cells last, status by progress, ties keep their order) are covered on
// plain data in report-sort.spec.ts; this checks the table behaves.

const API_BASE = `http://localhost:${BACKEND_PORT}`;

async function reportFor(request: APIRequestContext, technician: string) {
  const res = await request.post(`${API_BASE}/reports`, { data: { technician_name: technician } });
  expect(res.status()).toBe(201);
}

/** The lab managers of the rows currently shown, top to bottom, reduced to their last letter. */
async function order(page: Page, prefix: string): Promise<string[]> {
  const rows = await page.locator('.report-row-body').allTextContents();
  return rows.filter((t) => t.includes(prefix)).map((t) => t.split(prefix)[1].charAt(0));
}

test('clicking a column header sorts the table, again reverses it, a third time restores the order', async ({ page, request }) => {
  const stamp = Date.now();
  const prefix = `E2E-Sort-${stamp}-`;
  // Created b, c, a: so the default order (newest first) is a, c, b,
  // which is neither the ascending nor the descending order.
  for (const letter of ['b', 'c', 'a']) await reportFor(request, `${prefix}${letter}`);

  await page.goto('/');
  await page.click('.view-tab:has-text("Reports")');
  await page.fill('input[aria-label="Lab manager"]', prefix);
  await expect(page.locator('.report-row-body', { hasText: `${prefix}a` })).toBeVisible();
  await expect.poll(() => order(page, prefix)).toEqual(['a', 'c', 'b']);

  const head = page.locator('[data-testid="sort-lab_manager"]');
  await expect(head).toHaveAttribute('data-sort', 'none');

  await head.click();
  await expect.poll(() => order(page, prefix)).toEqual(['a', 'b', 'c']);
  await expect(head).toHaveAttribute('data-sort', 'asc');
  await expect(head).toContainText('▲');
  await expect(page.locator('[data-testid="result-count"]')).toContainText('sorted by lab manager');

  await head.click();
  await expect.poll(() => order(page, prefix)).toEqual(['c', 'b', 'a']);
  await expect(head).toHaveAttribute('data-sort', 'desc');
  await expect(head).toContainText('▼');

  await head.click();
  await expect.poll(() => order(page, prefix)).toEqual(['a', 'c', 'b']);
  await expect(head).toHaveAttribute('data-sort', 'none');
  await expect(page.locator('[data-testid="result-count"]')).not.toContainText('sorted by');
});

test('sorting by another column replaces the first, and survives a change of filter', async ({ page, request }) => {
  const stamp = Date.now();
  const prefix = `E2E-Sort2-${stamp}-`;
  for (const letter of ['b', 'c', 'a']) await reportFor(request, `${prefix}${letter}`);

  await page.goto('/');
  await page.click('.view-tab:has-text("Reports")');
  await page.fill('input[aria-label="Lab manager"]', prefix);
  await expect.poll(() => order(page, prefix)).toEqual(['a', 'c', 'b']);

  const lab = page.locator('[data-testid="sort-lab_manager"]');
  const date = page.locator('[data-testid="sort-date"]');
  await lab.click();
  await expect.poll(() => order(page, prefix)).toEqual(['a', 'b', 'c']);

  // Another column takes over: the first loses its arrow. The reports have no
  // date, so equal rows keep the order they came in (newest first).
  await date.click();
  await expect(lab).toHaveAttribute('data-sort', 'none');
  await expect(date).toHaveAttribute('data-sort', 'asc');
  await expect.poll(() => order(page, prefix)).toEqual(['a', 'c', 'b']);

  // Changing the filter keeps the chosen sort: narrow to one report, then widen again.
  await lab.click();
  await expect(lab).toHaveAttribute('data-sort', 'asc');
  await page.fill('input[aria-label="Lab manager"]', `${prefix}b`);
  await expect.poll(() => order(page, prefix)).toEqual(['b']);
  await expect(lab).toHaveAttribute('data-sort', 'asc');
  await page.fill('input[aria-label="Lab manager"]', prefix);
  await expect.poll(() => order(page, prefix)).toEqual(['a', 'b', 'c']);
  await expect(lab).toHaveAttribute('data-sort', 'asc');
});
