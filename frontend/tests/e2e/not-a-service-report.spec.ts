import { test, expect } from './coverage';
import { listReportIds } from './helpers/api';
import { uniquePdf } from './unique-upload';
import { TIMEOUT } from './timeouts';

// A file that is not a service report is rejected at Classify. It does not show the instrument form
// ("not in your fleet", add an instrument), it leaves no draft behind, and another file can be chosen.
// In stub mode a file name containing "notareport" is read as "not a service document".

test('a file that is not a service report is rejected, with no draft left and no add-instrument form', async ({ page, request }) => {
  const before = new Set(await listReportIds(request));

  await page.goto('/#/new');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'notareport-photo.pdf',
    mimeType: 'application/pdf',
    buffer: uniquePdf('%PDF-1.4 not a service report'),
  });
  await page.click('button:has-text("Upload & classify")');

  await expect(page.getByText("This doesn't look like a service report.")).toBeVisible({ timeout: TIMEOUT.flow });
  await expect(page.getByText('not in your fleet', { exact: false })).toHaveCount(0);
  await expect(page.locator('.class-row')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Confirm & continue/ })).toHaveCount(0);

  const after = await listReportIds(request);
  expect(after.filter((id) => !before.has(id))).toEqual([]);

  await page.getByRole('button', { name: 'Choose another file' }).click();
  await expect(page.getByRole('button', { name: 'Upload & classify' })).toBeVisible({ timeout: TIMEOUT.ui });
});
