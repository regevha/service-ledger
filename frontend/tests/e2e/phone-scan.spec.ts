import { type APIRequestContext } from '@playwright/test';
import { test, expect } from './coverage';
import { createNumericModel } from './numeric-fixture';
import { seedReport as seedReportWith, API_BASE } from './helpers/api';

// Phone review of 2026-10-25, item 11 and the owner's choice of a "⋯" menu: on a phone the scan is
// shown as page images behind a Fields | Scan switch, and the report's rarer actions live in a menu.

// The shared fixture PDFs are fake bytes; page rendering needs a real (here: two blank pages) document.
// PDFium rebuilds a missing cross-reference table, so none is written.
const TWO_PAGE_PDF =
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n' +
  '4 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n' +
  'trailer<</Root 1 0 R/Size 5>>\n%%EOF';

async function seedReport(request: APIRequestContext): Promise<{ reportId: string; attachmentId: string }> {
  const model = await createNumericModel(request, 'E2E-Scan');
  const { reportId, attachmentId } = await seedReportWith(request, {
    model,
    reportType: 'installation_upgrade',
    extract: false,
    file: { name: 'two-pages.pdf', contents: TWO_PAGE_PDF },
  });
  return { reportId, attachmentId };
}

test.describe('scan and report menu on a phone', () => {
  test.use({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true });

  test('the Scan tab shows every page as an image, and + / - zoom it', async ({ page, request }) => {
    const { reportId, attachmentId } = await seedReport(request);
    const { page_count } = await (await request.get(`${API_BASE}/attachments/${attachmentId}/pages`)).json();
    await page.goto(`/#/reports/${reportId}`);

    await expect(page.getByRole('tab', { name: 'Fields' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.field-list')).toBeVisible();

    await page.getByRole('tab', { name: 'Scan' }).click();
    await expect(page.locator('.field-list')).toBeHidden();
    const pages = page.locator('.scan-page');
    expect(page_count).toBe(2);
    await expect(pages).toHaveCount(2);
    await expect(pages.first()).toBeVisible();
    await expect.poll(() => pages.first().evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);

    const sheet = page.locator('.scan-sheet');
    const before = (await sheet.boundingBox())!.width;
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect.poll(async () => (await sheet.boundingBox())!.width).toBeGreaterThan(before * 1.4);
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await expect(page.locator('.scan-zoom-level')).toHaveText('100%');

    await page.getByRole('tab', { name: 'Fields' }).click();
    await expect(page.locator('.field-list')).toBeVisible();
  });

  test('Delete report, Download PDF and View original scan are in a "⋯" menu', async ({ page, request }) => {
    const { reportId } = await seedReport(request);
    await page.goto(`/#/reports/${reportId}`);
    await expect(page.locator('.field-list')).toBeVisible();

    // not loose buttons any more
    await expect(page.getByRole('button', { name: 'Delete report' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Download PDF' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'View original scan' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Report actions' }).click();
    await expect(page.getByRole('menuitem')).toHaveText(['Download PDF', 'View original scan', 'Delete report']);

    await page.getByRole('menuitem', { name: 'Delete report' }).click();
    await expect(page.getByRole('alertdialog', { name: 'Confirm delete' })).toBeVisible();
    await page.getByRole('button', { name: 'Confirm delete' }).click();
    await expect.poll(async () => (await request.get(`${API_BASE}/reports/${reportId}`)).status()).toBe(404);
  });
});

test.describe('on a wide screen', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('Delete report stays a button and there is no Fields | Scan switch', async ({ page, request }) => {
    const { reportId } = await seedReport(request);
    await page.goto(`/#/reports/${reportId}`);
    await expect(page.getByRole('button', { name: 'Delete report' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Scan' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Report actions' })).toHaveCount(0);
  });
});
