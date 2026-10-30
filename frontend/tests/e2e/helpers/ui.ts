import { type Page, expect } from '@playwright/test';
import { TIMEOUT } from '../timeouts';

// Getting to a screen, the way a person would: through the address and the tabs.

/** The Reports tab, once its table (or its empty-state hint) is showing. */
export async function openReports(page: Page): Promise<void> {
  await page.goto('/');
  await page.click('.view-tab:has-text("Reports")');
  await page.waitForSelector('.report-table, .empty-hint');
}

/** A report from the Reports list, found by text in its row (a technician name used as a marker). */
export async function openReportFromList(page: Page, marker: string): Promise<void> {
  await openReports(page);
  await page.click(`.report-row-body:has-text("${marker}")`);
}

/** The same, for a report that opens on the review screen: waits until its fields are showing. */
export async function openReviewFromList(page: Page, marker: string): Promise<void> {
  await openReportFromList(page, marker);
  await expect(page.locator('.field-list')).toBeVisible({ timeout: TIMEOUT.ui });
}

/** The Analytics tab, once its filter bar is showing. */
export async function openAnalytics(page: Page): Promise<void> {
  await page.goto('/');
  await page.click('.view-tab:has-text("Analytics")');
  await expect(page.getByTestId('analytics-filters')).toBeVisible({ timeout: TIMEOUT.ui });
}

/**
 * Presses "Confirm & continue" on the Classify screen. A report type read with low confidence is not
 * pre-selected, so when the type select is still empty the given type is chosen first.
 */
export async function confirmClassification(page: Page, reportType: string = 'repair'): Promise<void> {
  const typeSelect = page.locator('.class-row select').nth(1);
  if ((await typeSelect.inputValue()) === '') await typeSelect.selectOption(reportType);
  await page.click('button:has-text("Confirm & continue")');
}
