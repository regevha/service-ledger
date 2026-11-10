import { type Page, expect } from '@playwright/test';
import { TIMEOUT } from '../timeouts';

// Getting to a screen, the way a person would: through the address and the tabs.

/** The Reports tab, once its table (or its empty-state hint) is showing. */
export async function openReports(page: Page): Promise<void> {
  await page.goto('/#/new');
  await page.getByTestId('tab-reports').click();
  await page.waitForSelector('.report-table, .empty-hint');
  await showFlatList(page);
}

/**
 * The Reports list opens grouped by instrument; most specs look at rows and sort headers, which belong to the
 * flat list, so they switch the Group choice to None first (specs of the grouped view do not call this).
 */
export async function showFlatList(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="group-select"], .empty-hint');
  const group = page.getByTestId('group-select');
  if (await group.count()) {
    await group.selectOption('none');
    await page.waitForSelector('.report-table:not(.report-groups), .empty-hint');
  }
}

/** The instrument trend opens as a table; this switches it to the chart (and waits for it). */
export async function showTrendChart(page: Page): Promise<void> {
  const hide = page.getByRole('button', { name: 'Hide table' });
  if (await hide.count()) await hide.first().click();
  await page.waitForSelector('.trend-chart-wrap svg');
}

/** A report from the Reports list, found by text in its row (a technician name used as a marker). */
export async function openReportFromList(page: Page, marker: string): Promise<void> {
  await openReports(page);
  await page.click(`[data-testid="report-row"]:has-text("${marker}")`);
}

/** The same, for a report that opens on the review screen: waits until its fields are showing. */
export async function openReviewFromList(page: Page, marker: string): Promise<void> {
  await openReportFromList(page, marker);
  await expect(page.getByTestId('field-list')).toBeVisible({ timeout: TIMEOUT.ui });
}

/** The Analytics tab, once its filter bar is showing. */
export async function openAnalytics(page: Page): Promise<void> {
  await page.goto('/#/new');
  await page.getByTestId('tab-analytics').click();
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

/** The test id of a main-navigation tab, from its label ("New report" -> tab-new). */
export function tabTestId(label: string): string {
  const ids: Record<string, string> = { 'New report': 'tab-new', Reports: 'tab-reports', Analytics: 'tab-analytics', Templates: 'tab-templates', Home: 'tab-home', Instruments: 'tab-instruments', Admin: 'tab-admin', More: 'tab-more' };
  return ids[label] ?? `tab-${label.toLowerCase()}`;
}
