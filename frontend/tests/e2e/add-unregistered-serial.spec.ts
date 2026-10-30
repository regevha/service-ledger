import { test, expect } from './coverage';
import { TIMEOUT } from './timeouts';

// A BD service report whose serial number is not registered: the classify screen offers the
// same add-instrument panel as for another maker's form, pre-filled from the document.

/** A one-page PDF with a real text layer, one line of text per entry. */
function textPdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, '\\$&');
  const content = lines.map((l, i) => `BT /F1 11 Tf 40 ${800 - i * 16} Td (${esc(l)}) Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('a serial that is not registered offers the add-instrument panel, pre-filled', async ({ page }) => {
  const stamp = String(Date.now()).slice(-8);
  const serial = `R647794E6${stamp}`; // BD serials embed the product code
  const pdf = textPdf([
    'Service Report',
    `CASE NUMBER : 0${stamp}      WORK ORDER NUMBER: WO-${stamp}`,
    'ACCOUNT   INSTRUMENT LOCATION   SYSTEM   INSTALLED PRODUCT',
    'N/A647794E6 - LSRFortessa SO',
    'Serial/Lot Number:',
    serial,
    'WORK ORDER DETAILS',
    'Work Order Task CodeT113 Repair / Troubleshooting Visit',
  ]);
  await page.goto('/');
  await page.getByTestId('intake-file-input').setInputFiles({ name: `report-${stamp}.pdf`, mimeType: 'application/pdf', buffer: pdf });
  await page.click('button:has-text("Upload & classify")');

  const panel = page.locator('#add-instrument-panel');
  await expect(panel).toBeVisible({ timeout: TIMEOUT.flow });
  await expect(panel).toContainText(`${serial}, is not registered under LSRFortessa`);
  await expect(panel.locator('input[aria-label="Instrument model"]')).toHaveValue('LSRFortessa');
  await expect(panel.locator('input[aria-label="Instrument serial number"]')).toHaveValue(serial);
  await expect(panel.locator('input[aria-label="Instrument manufacturer"]')).not.toHaveValue('');

  await panel.locator('input[aria-label="Instrument name"]').fill(`E2E-Fortessa-${stamp}`);
  await panel.locator('button:has-text("Add instrument")').click();

  // Classified again: the serial now matches, so the report goes on without the panel.
  await expect(page.locator('#add-instrument-panel')).toHaveCount(0, { timeout: TIMEOUT.flow });
  await expect(page.locator('.banner-crit')).toHaveCount(0);
  await expect(page.locator('.field-list, #serial-notice').first()).toBeVisible({ timeout: TIMEOUT.flow });
});
