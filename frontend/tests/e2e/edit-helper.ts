import { type Page } from '@playwright/test';

/** Opens a finalized report for editing: the Edit button, then the confirmation. */
export async function startEditing(page: Page) {
  await page.click('.review-actions button:has-text("Edit")');
  await page.getByRole('button', { name: 'Edit anyway' }).click();
}
