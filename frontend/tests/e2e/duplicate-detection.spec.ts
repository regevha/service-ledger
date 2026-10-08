import { test, expect } from './coverage';

// A document that is already on file is flagged, never blocked
// (backend/app/services/duplicates.py). Two signals, both exercised here with
// the stub reader: the same file bytes (SHA-256, found at upload) and the same
// work-order number (the stub "reads" one when the file's own name contains it,
// classification.py::_stub_work_order — a re-scan has different bytes).
//
// Each test uses its own unique marker, so neither depends on run order or on
// what other specs left in the shared database.

async function uploadAndClassify(page: import('@playwright/test').Page, name: string, contents: string) {
  await page.goto('/');
  await page.click('.view-tab:has-text("New report")');
  await page.fill('input[placeholder="Your name (optional)"]', 'E2E Duplicate');
  await page.locator('input[type="file"]').setInputFiles({
    name,
    mimeType: 'application/pdf',
    buffer: Buffer.from(contents),
  });
  await page.click('button:has-text("Upload & classify")');
  // Either end of classification: straight through to review, or the manual
  // confirm step (which other specs' extra instruments can cause).
  await expect(page.locator('#review-report-date, .class-row').first()).toBeVisible({ timeout: 30_000 });
}

test('the same file uploaded twice is flagged on the second report', async ({ page }) => {
  const marker = Date.now();
  const bytes = `%PDF-1.4 duplicate bytes ${marker}`;

  await uploadAndClassify(page, `first_${marker}.pdf`, bytes);
  await expect(page.locator('#duplicate-notice')).toHaveCount(0);

  await uploadAndClassify(page, `second_${marker}.pdf`, bytes);
  await expect(page.locator('#duplicate-notice')).toContainText('already on file');
  await expect(page.locator('#duplicate-notice')).toContainText('E2E Duplicate');
});

test('a re-scan with a different file but the same work order is flagged', async ({ page }) => {
  const workOrder = `WO-${Date.now()}`;

  await uploadAndClassify(page, `visit_${workOrder}.pdf`, `%PDF-1.4 first scan ${workOrder}`);
  await expect(page.locator('#duplicate-notice')).toHaveCount(0);

  await uploadAndClassify(page, `rescan ${workOrder}.pdf`, `%PDF-1.4 a different scan of ${workOrder}`);
  await expect(page.locator('#duplicate-notice')).toContainText('already on file');
});

test('a document that is not on file gets no warning', async ({ page }) => {
  const marker = Date.now() + 1;
  await uploadAndClassify(page, `unique_${marker}.pdf`, `%PDF-1.4 nothing like it ${marker}`);
  await expect(page.locator('#duplicate-notice')).toHaveCount(0);
});
