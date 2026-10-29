import { test, expect } from './coverage';
import { uniquePdf } from './unique-upload';
import { TIMEOUT } from './timeouts';

// The Hebrew translation review (docs: proposal-hebrew-translation.md). In
// stub mode a file whose name contains "hebrew" is "translated" with a fixed
// fixture whose pages 2 and 3 are reported as QC printouts; a name containing
// "othermaker-<serial>" is read as another company's instrument that is not in
// the fleet until it is added. Nothing here needs an API key.

async function upload(page: import('@playwright/test').Page, name: string) {
  await page.goto('/');
  await page.click('.view-tab:has-text("New report")');
  await page.locator('input[type="file"]').setInputFiles({
    name,
    mimeType: 'application/pdf',
    buffer: uniquePdf('%PDF-1.4 fake scan'),
  });
  await page.click('button:has-text("Upload & classify")');
}

test('a Hebrew document waits for review; QC pages are listed and can be included', async ({ page }) => {
  await upload(page, `hebrew-review-${Date.now()}.pdf`);

  const review = page.locator('#translation-review');
  await expect(review).toBeVisible({ timeout: TIMEOUT.flow });
  await expect(page.locator('#ignored-pages')).toContainText('page');
  await expect(page.locator('#ignored-pages')).toContainText('2, 3');
  await expect(page.locator('#identifier-check')).toContainText('identifiers');
  await expect(page.locator('textarea[aria-label="English translation"]')).toContainText('Service report No. 2046');
  // Nothing is classified yet.
  await expect(page.locator('.class-row')).toHaveCount(0);
  await expect(page.locator('.field-list')).toHaveCount(0);

  // Ask for page 2 to be included: translated again, page 3 still ignored.
  await page.click('button:has-text("Include page 2")');
  await expect(page.locator('#included-pages')).toContainText('2', { timeout: TIMEOUT.flow });
  await expect(page.locator('#ignored-pages')).toContainText('page 3');
  await expect(page.locator('#ignored-pages')).not.toContainText('2, 3');
  await expect(page.locator('textarea[aria-label="English translation"]')).toContainText('Page 2 included');
});

test('the original beside the English is served for display, not as a download', async ({ page, request }) => {
  // Found on 2026-10-16 with the Cytek PDF (pages are images): the original
  // pane stayed blank because the file came back as an attachment, which a
  // browser refuses to show in an iframe.
  await upload(page, `hebrew-inline-${Date.now()}.pdf`);
  await expect(page.locator('#translation-review')).toBeVisible({ timeout: TIMEOUT.flow });

  const src = await page.locator('iframe.translation-original').getAttribute('src');
  expect(src).toContain('/file?inline=1');
  const res = await request.get(src!);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-disposition']).toMatch(/^inline/);
  // Not asserted: whether the browser draws the PDF. The headless Chromium in
  // CI has no PDF viewer and turns an inline PDF in an iframe into a download,
  // while Chrome shows it; the inline disposition above is what decides that.
});

test('editing the English shows durations in decimal hours and accepting continues to the report', async ({ page }) => {
  await upload(page, `hebrew-edit-${Date.now()}.pdf`);
  const box = page.locator('textarea[aria-label="English translation"]');
  await expect(box).toBeVisible({ timeout: TIMEOUT.flow });

  // Not edited yet: the plain accept button.
  await expect(page.locator('button:has-text("Accept & continue")')).toBeVisible();

  await box.fill('Work\n1 | 22/09/26 | Rhenium work hours | 12:00 | 13:25 | 01:25\nTravel: 6');
  await expect(page.locator('#translation-durations')).toContainText('01:25 = 1.42 h');
  await expect(page.locator('#translation-durations')).not.toContainText('12:00');

  await page.click('button:has-text("Accept my edits & continue")');
  await page.waitForSelector('.field-list, .class-row, .banner-crit', { timeout: TIMEOUT.flow });
  await expect(page.locator('.banner-crit')).toHaveCount(0);
  await expect(page.locator('#translation-review')).toHaveCount(0);
});

test('discarding the translation goes on with the original document', async ({ page }) => {
  await upload(page, `hebrew-discard-${Date.now()}.pdf`);
  await expect(page.locator('#translation-review')).toBeVisible({ timeout: TIMEOUT.flow });
  await page.click('button:has-text("Discard and use the original")');
  await page.waitForSelector('.field-list, .class-row, .banner-crit', { timeout: TIMEOUT.flow });
  await expect(page.locator('.banner-crit')).toHaveCount(0);
  await expect(page.locator('#translation-review')).toHaveCount(0);
});

test('an instrument that is not in the fleet is added on the spot and the document is classified again', async ({ page }) => {
  const serial = `E2E${Date.now()}`;
  await upload(page, `hebrew-othermaker-${serial}-scan.pdf`);
  await expect(page.locator('#translation-review')).toBeVisible({ timeout: TIMEOUT.flow });
  await page.click('button:has-text("Accept & continue")');

  const panel = page.locator('#add-instrument-panel');
  await expect(panel).toBeVisible({ timeout: TIMEOUT.flow });
  await expect(panel).toContainText('not in your fleet');
  await expect(page.locator('#read-model')).toContainText('not in your fleet');
  await expect(page.locator('#read-issuer')).toContainText('almog diagnostic');
  await expect(page.locator('#report-type-note')).toContainText('Preventive maintenance');

  // Filled in from the document.
  await expect(panel.locator('input[aria-label="Instrument model"]')).toHaveValue('Cytek Aurora');
  await expect(panel.locator('input[aria-label="Instrument manufacturer"]')).toHaveValue('Cytek Biosciences');
  await expect(panel.locator('input[aria-label="Instrument distributor"]')).toHaveValue('almog diagnostic');
  await expect(panel.locator('input[aria-label="Instrument serial number"]')).toHaveValue(serial);

  // Needs a name and a kind; the name starts as the model.
  await panel.locator('input[aria-label="Instrument name"]').fill(`E2E-Aurora-${serial}`);
  await panel.locator('button:has-text("Add instrument")').click();

  // Classified again: now matched by serial. The new instrument takes the type of the existing
  // "Cytek Aurora" model (a flow cytometer), so the report finds its template and goes straight
  // to review, without the add panel.
  await expect(page.locator('#serial-notice')).toContainText(`Matched to Cytek Aurora (${serial})`, { timeout: TIMEOUT.flow });
  await expect(page.locator('.banner-crit')).toHaveCount(0);
  await expect(page.locator('#add-instrument-panel')).toHaveCount(0);
  await expect(page.locator('.field-list').first()).toBeVisible({ timeout: TIMEOUT.flow });

  // The new instrument is in the fleet list with its distributor.
  await page.click('.view-tab:has-text("Instruments")');
  const row = page.locator('.instrument-row.template-row-body', { hasText: `E2E-Aurora-${serial}` });
  await expect(row).toContainText('almog diagnostic');
});

test('a document that is not Hebrew goes straight to classification', async ({ page }) => {
  await upload(page, `plain-english-${Date.now()}.pdf`);
  await page.waitForSelector('.field-list, .class-row, .banner-crit', { timeout: TIMEOUT.flow });
  await expect(page.locator('#translation-review')).toHaveCount(0);
});
