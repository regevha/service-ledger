import type { Page } from '@playwright/test';
import { test, expect } from './coverage';
import { TIMEOUT } from './timeouts';
import { scaledSize, jpegsToPdf } from '../../src/imageUpload';

// Photos are shrunk in the browser before upload, and several photos become one PDF.

/** A PNG of the given size, drawn in the page, as bytes. */
async function png(page: Page, width: number, height: number, shade: string): Promise<Buffer> {
  const data = await page.evaluate(
    async ([w, h, c]) => {
      const canvas = document.createElement('canvas');
      canvas.width = w as number;
      canvas.height = h as number;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = c as string;
      ctx.fillRect(0, 0, w as number, h as number);
      ctx.fillStyle = '#000';
      ctx.fillRect(10, 10, 100, 40);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
      return Array.from(new Uint8Array(await blob!.arrayBuffer()));
    },
    [width, height, shade] as const
  );
  return Buffer.from(data);
}

/** The next attachment upload: its body (read through a route, which sees it whole) and its answer. */
async function captureUpload(page: Page) {
  const seen: { body: Buffer } = { body: Buffer.alloc(0) };
  await page.route(/\/reports\/[^/]+\/attachments$/, async (route) => {
    if (route.request().method() === 'POST') seen.body = route.request().postDataBuffer() ?? Buffer.alloc(0);
    await route.continue();
  });
  const done = page.waitForResponse((r) => r.request().method() === 'POST' && /\/reports\/[^/]+\/attachments$/.test(r.url()));
  return { seen, done };
}

test('scaledSize: the long side is at most 2000 px, never scaled up', () => {
  expect(scaledSize(4000, 3000)).toEqual({ width: 2000, height: 1500 });
  expect(scaledSize(3000, 6000)).toEqual({ width: 1000, height: 2000 });
  expect(scaledSize(1200, 800)).toEqual({ width: 1200, height: 800 });
});

test('jpegsToPdf: one page per image', () => {
  const jpeg = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 10, height: 20 };
  const text = Buffer.from(jpegsToPdf([jpeg, jpeg, jpeg])).toString('latin1');
  expect(text.startsWith('%PDF-1.4')).toBe(true);
  expect(text).toContain('/Count 3');
  expect(text.match(/\/Type \/Page /g)).toHaveLength(3);
  expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
});

test('one big photo goes up shrunk, as a JPEG', async ({ page }) => {
  await page.goto('/');
  const big = await png(page, 3200, 2400, '#fff');
  const { seen, done } = await captureUpload(page);
  await page.getByTestId('intake-file-input').setInputFiles({ name: 'form.png', mimeType: 'image/png', buffer: big });
  await page.click('button:has-text("Upload & classify")');
  await done;
  const body = seen.body.toString('latin1');
  expect(body).toContain('filename="form.jpg"');
  expect(body).toContain('Content-Type: image/jpeg');
  expect(seen.body.length).toBeLessThan(big.length);
  await expect(page.locator('.field-list, .section-title:has-text("Detected from the document")').first()).toBeVisible({ timeout: TIMEOUT.flow });
});

test('several photos go up as one PDF and become one report', async ({ page }) => {
  await page.goto('/');
  const files = [
    { name: 'page1.png', mimeType: 'image/png', buffer: await png(page, 800, 1000, '#fff') },
    { name: 'page2.png', mimeType: 'image/png', buffer: await png(page, 800, 1000, '#eee') },
    { name: 'page3.png', mimeType: 'image/png', buffer: await png(page, 800, 1000, '#ddd') },
  ];
  await page.getByTestId('intake-file-input').setInputFiles(files);
  await expect(page.locator('.dropzone .primary')).toHaveText('3 photos — one report');
  const { seen, done } = await captureUpload(page);
  await page.click('button:has-text("Upload & classify")');
  const response = await done;
  expect(response.status()).toBe(201);
  const body = seen.body.toString('latin1');
  expect(body).toContain('filename="page1-and-2-more.pdf"');
  expect(body).toContain('%PDF-1.4');
  expect(body).toContain('/Count 3');
  await expect(page.locator('.field-list, .section-title:has-text("Detected from the document")').first()).toBeVisible({ timeout: TIMEOUT.flow });
});

test('photos mixed with a PDF are refused with the reason', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('intake-file-input').setInputFiles([
    { name: 'a.png', mimeType: 'image/png', buffer: await png(page, 50, 50, '#fff') },
    { name: 'b.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') },
  ]);
  await expect(page.getByRole('alert')).toContainText('Drop one PDF');
  await expect(page.getByRole('button', { name: 'Upload & classify' })).toBeDisabled();
});
