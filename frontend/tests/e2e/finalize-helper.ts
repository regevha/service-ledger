import type { Page } from '@playwright/test';

/**
 * Press "Save & finalize report" on the review screen. When fields are still flagged the screen asks
 * "Finalize anyway?" first, so this answers that question too: specs that only want a finalized report
 * do not depend on whether the stub happened to flag anything on this run.
 */
export async function finalizeFromReview(page: Page): Promise<void> {
  const flagged = await page.locator('.field.pending').count();
  await page.click('button:has-text("Save & finalize report")');
  if (flagged > 0) await page.getByRole('button', { name: 'Finalize anyway' }).click();
}
