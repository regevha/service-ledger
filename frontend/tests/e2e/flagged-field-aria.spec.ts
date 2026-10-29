import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './coverage';
import { uniqueFixture } from './unique-upload';

// Flagged fields for keyboard and screen-reader users: every field is a named group that says when it
// needs checking, "Mark as checked" and the attention chips say which field they mean, and checking a
// field leaves the keyboard on that field rather than on nothing.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIDENT_SCAN = path.join(__dirname, 'fixtures', 'confident-scan.pdf');

test('flagged fields are named groups that say they need checking, and checking keeps the focus', async ({ page }) => {
  await page.route('**/extraction-jobs/*', async (route) => {
    const response = await route.fetch();
    const job = await response.json();
    if (job && typeof job === 'object') job.field_confidences = { ...(job.field_confidences ?? {}), report_date: 0.1 };
    await route.fulfill({ response, json: job });
  });
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles(uniqueFixture(CONFIDENT_SCAN));
  await page.click('button:has-text("Upload & classify")');
  await page.waitForSelector('.field-list', { timeout: 30_000 });

  const date = page.getByRole('group', { name: /Service date/ });
  await expect(date).toContainText('Needs checking.');
  await expect(date.getByRole('button', { name: 'Mark as checked: Service date' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Go to Service date' })).toBeVisible();

  // An unflagged field is a named group too, and says nothing about checking.
  const groups = page.locator('.field-list [role="group"]');
  expect(await groups.count()).toBeGreaterThan(1);
  // Fields a person fills in are always flagged, so look for one that is not: it is a group that says nothing about checking.
  await expect(groups.filter({ hasNotText: 'Needs checking.' }).first()).toBeVisible();

  await date.getByRole('button', { name: 'Mark as checked: Service date' }).click();
  await expect(date).not.toContainText('Needs checking.');
  await expect(date.locator('input, textarea, select').first()).toBeFocused();
});
