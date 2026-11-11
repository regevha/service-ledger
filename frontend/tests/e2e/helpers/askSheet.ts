import { expect, type Locator, type Page } from '@playwright/test';

/** On a phone the Ask box lives in a sheet opened from the magnifier in the top bar. Opens it and returns it. */
export async function openAskSheet(page: Page): Promise<Locator> {
  await page.getByTestId('ask-open').tap();
  const sheet = page.getByTestId('ask-sheet');
  await expect(sheet).toBeVisible();
  return sheet;
}

/** Opens the sheet, types the question and sends it with a tap. */
export async function askInSheet(page: Page, text: string): Promise<void> {
  const sheet = await openAskSheet(page);
  await sheet.getByTestId('ask-input').fill(text);
  await sheet.getByTestId('ask-submit').tap();
}
