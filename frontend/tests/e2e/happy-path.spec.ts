import { test, expect } from './coverage';
import { uniqueFixture } from './unique-upload';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIMEOUT } from './timeouts';

import { finalizeFromReview } from './finalize-helper';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The confident case (§4): a document with no marker in its filename gets a
// deterministic "confident on both" stub classification, auto-resolves
// straight to extraction with no manual-confirm detour, and reaches the
// review screen ready to finalize. This is the one flow every earlier round
// of ad hoc Playwright scripts this session re-verified by hand before every
// milestone — this file is that check, made permanent.

const FIXTURE = path.join(__dirname, 'fixtures', 'confident-scan.pdf');

test('upload → auto-classify → extract → review → finalize', async ({ page }) => {
  await page.goto('/');

  await page.click('.view-tab:has-text("New report")');
  await page.fill('input[placeholder="Your name (optional)"]', 'E2E Happy Path');
  await page.getByTestId('intake-file-input').setInputFiles(uniqueFixture(FIXTURE));
  await page.click('button:has-text("Upload & classify")');

  // No manual-confirm detour expected for this fixture.
  await page.waitForSelector('.field-list, [data-testid="class-row"], [data-testid="intake-error"]', { timeout: TIMEOUT.flow });
  await expect(page.getByTestId('class-row')).toHaveCount(0);
  await expect(page.getByTestId('intake-error')).toHaveCount(0);

  await expect(page.locator('.field-list')).toBeVisible();
  const fieldCount = await page.locator('.field-list .field').count();
  expect(fieldCount).toBeGreaterThan(0);

  await finalizeFromReview(page);
  await expect(page.getByTestId('intake-success')).toBeVisible({ timeout: TIMEOUT.ui });
  await expect(page.getByTestId('intake-success')).toContainText('finalized');

  // "Start another report" returns to a clean intake screen — the state
  // machine's reset path, not just the finalize call itself.
  await page.click('button:has-text("Start another report")');
  await expect(page.getByTestId('intake-dropzone')).toBeVisible();
});
