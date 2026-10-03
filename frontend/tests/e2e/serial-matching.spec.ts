import { test, expect } from './coverage';
import { BACKEND_PORT } from '../../playwright.config';

const API_BASE = `http://localhost:${BACKEND_PORT}`;

// A model alone can't tell two units of one model apart, so a fleet with
// several FACSAria IIIs used to send every upload to the manual pick. The
// serial number printed on the document now picks the unit. In stub mode the
// "reader" finds a serial when the uploaded file's own name contains one
// (classification.py::_stub_serial_read), which is what this test uses.
test('a document naming a serial number is assigned to that unit even when its model has several', async ({ page, request }) => {
  const serial = `SM-${Date.now()}`;
  const created = await request.post(`${API_BASE}/instruments`, {
    data: { name: `Aria serial test ${serial}`, model: 'FACSAria III', serial_number: serial },
  });
  expect(created.status()).toBe(201);

  await page.goto('/');
  await page.click('.view-tab:has-text("New report")');
  await page.fill('input[placeholder="Your name (optional)"]', `Serial ${serial}`);
  await page.locator('input[type="file"]').setInputFiles({
    name: `service_${serial}.pdf`,
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 serial test'),
  });
  await page.click('button:has-text("Upload & classify")');

  // Straight through to review: no manual pick, even though two FACSAria IIIs exist.
  await expect(page.locator('#review-report-date')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#serial-notice')).toContainText(`Matched to FACSAria III (${serial})`);

  await page.click('button:has-text("Save & finalize report")');
  await expect(page.locator('.success-panel')).toBeVisible({ timeout: 15_000 });

  // The report belongs to that unit, not to the other Aria.
  await page.click('.view-tab:has-text("Reports")');
  await page.locator('input[aria-label="Technician"]').fill(`Serial ${serial}`);
  await expect(page.locator('.report-row-body')).toHaveCount(1);
  await expect(page.locator('.report-row-body')).toContainText(`FACSAria III (${serial})`);
});
