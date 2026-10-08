import { test, expect } from './coverage';

// Installation / upgrade is a report type of its own (BD task code T107). The
// stub treats a file name containing "sample-work-order" as an uncertain report
// type (manual-confirm.spec.ts), which is the easiest way to reach the confirm
// screen, where the technician can now pick the new type and land on its
// template's fields.
test('a technician can confirm a report as an installation / upgrade and review its fields', async ({ page }) => {
  await page.goto('/');
  await page.click('.view-tab:has-text("New report")');
  await page.fill('input[placeholder="Your name (optional)"]', 'E2E Install Upgrade');
  await page.locator('input[type="file"]').setInputFiles({
    name: `sample-work-order-upgrade-${Date.now()}.pdf`,
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 software upgrade'),
  });
  await page.click('button:has-text("Upload & classify")');
  await page.waitForSelector('.class-row', { timeout: 30_000 });

  const typeSelect = page.locator('select:has(option:has-text("Installation / upgrade"))');
  await typeSelect.selectOption({ label: 'Installation / upgrade' });
  await page.click('button:has-text("Confirm & continue")');

  const fields = page.locator('.field-list');
  await expect(fields).toBeVisible({ timeout: 30_000 });
  await expect(fields).toContainText('service description');
  await expect(fields).toContainText('parts used');
  await expect(fields).toContainText('verification result');
  // The repair template's fields are not on this report.
  await expect(fields).not.toContainText('fault category');

  await page.click('button:has-text("Save & finalize report")');
  await expect(page.locator('.success-panel')).toBeVisible({ timeout: 15_000 });

  // It is filterable by its type in the reports list.
  await page.click('.view-tab:has-text("Reports")');
  await page.locator('input[aria-label="Technician"]').fill('E2E Install Upgrade');
  await expect(page.locator('.report-row-body')).toHaveCount(1);
  await expect(page.locator('.report-row-body')).toContainText('Installation / upgrade');
});
