import type { Page } from '@playwright/test';
import { test, expect } from './coverage';
import { uniquePdf } from './unique-upload';
import { dropProblem } from '../../src/uploadFiles';
import { TIMEOUT } from './timeouts';

// Dragging a scan onto the upload box on the New report tab. A real drag can't be
// scripted, so these dispatch the same drag events a browser would, carrying a real
// DataTransfer with real File objects.

type Dropped = { name: string; type: string; text?: string };

async function dataTransfer(page: Page, items: Dropped[], content: Buffer) {
  return page.evaluateHandle(
    ({ items, bytes }) => {
      const dt = new DataTransfer();
      for (const it of items) dt.items.add(new File([new Uint8Array(bytes)], it.name, { type: it.type }));
      return dt;
    },
    { items, bytes: [...content] }
  );
}

const PDF = () => uniquePdf('%PDF-1.4 drop test');

test('dropping a PDF on the upload box selects it, and it can be read', async ({ page }) => {
  await page.goto('/');
  const zone = page.locator('.dropzone');
  await expect(page.getByRole('button', { name: 'Upload & classify' })).toBeDisabled();

  const dt = await dataTransfer(page, [{ name: 'dropped-scan.pdf', type: 'application/pdf' }], PDF());
  await zone.dispatchEvent('dragenter', { dataTransfer: dt });
  await expect(zone).toHaveClass(/dragging/);
  await expect(zone.locator('.primary')).toHaveText('Drop the file here');

  await zone.dispatchEvent('drop', { dataTransfer: dt });
  await expect(zone).not.toHaveClass(/dragging/);
  await expect(zone.locator('.primary')).toHaveText('dropped-scan.pdf');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Upload & classify' })).toBeEnabled();

  await page.getByRole('button', { name: 'Upload & classify' }).click();
  await page.waitForSelector('.field-list, .class-row, .banner-crit', { timeout: TIMEOUT.flow });
});

test('the highlight goes away when the drag leaves the box', async ({ page }) => {
  await page.goto('/');
  const zone = page.locator('.dropzone');
  const dt = await dataTransfer(page, [{ name: 'x.pdf', type: 'application/pdf' }], PDF());
  await zone.dispatchEvent('dragover', { dataTransfer: dt });
  await expect(zone).toHaveClass(/dragging/);
  await zone.dispatchEvent('dragleave', { dataTransfer: dt });
  await expect(zone).not.toHaveClass(/dragging/);
});

test('a drag that carries no files (selected text) does not light up the box', async ({ page }) => {
  await page.goto('/');
  const zone = page.locator('.dropzone');
  const dt = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    d.setData('text/plain', 'just some text');
    return d;
  });
  await zone.dispatchEvent('dragover', { dataTransfer: dt });
  await expect(zone).not.toHaveClass(/dragging/);
});

test('a file that is not a PDF or an image is refused on the spot, with the reason', async ({ page }) => {
  await page.goto('/');
  const zone = page.locator('.dropzone');
  const dt = await dataTransfer(page, [{ name: 'notes.txt', type: 'text/plain' }], Buffer.from('hello'));
  await zone.dispatchEvent('drop', { dataTransfer: dt });
  await expect(page.getByRole('alert')).toContainText('“notes.txt” is not a PDF or an image');
  await expect(zone.locator('.primary')).toContainText('Click to choose');
  await expect(page.getByRole('button', { name: 'Upload & classify' })).toBeDisabled();
});

test('several files at once are refused: one file per report', async ({ page }) => {
  await page.goto('/');
  const dt = await dataTransfer(
    page,
    [
      { name: 'a.pdf', type: 'application/pdf' },
      { name: 'b.pdf', type: 'application/pdf' },
    ],
    PDF()
  );
  await page.locator('.dropzone').dispatchEvent('drop', { dataTransfer: dt });
  await expect(page.getByRole('alert')).toContainText('one file at a time');
  await expect(page.getByRole('button', { name: 'Upload & classify' })).toBeDisabled();
});

test('a good drop after a refused one clears the message, and so does using the file picker', async ({ page }) => {
  await page.goto('/');
  const zone = page.locator('.dropzone');
  await zone.dispatchEvent('drop', { dataTransfer: await dataTransfer(page, [{ name: 'n.txt', type: 'text/plain' }], Buffer.from('x')) });
  await expect(page.getByRole('alert')).toBeVisible();
  await zone.dispatchEvent('drop', { dataTransfer: await dataTransfer(page, [{ name: 'ok.png', type: 'image/png' }], Buffer.from('x')) });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(zone.locator('.primary')).toHaveText('ok.png');

  // A refused drop does not throw away the file already chosen, and says it was kept.
  await zone.dispatchEvent('drop', { dataTransfer: await dataTransfer(page, [{ name: 'n.txt', type: 'text/plain' }], Buffer.from('x')) });
  await expect(page.getByRole('alert')).toContainText('Keeping ok.png.');
  await expect(zone.locator('.primary')).toHaveText('ok.png');
  await expect(page.getByRole('button', { name: 'Upload & classify' })).toBeEnabled();

  await zone.dispatchEvent('drop', { dataTransfer: await dataTransfer(page, [{ name: 'n.txt', type: 'text/plain' }], Buffer.from('x')) });
  await expect(page.getByRole('alert')).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({ name: 'picked.pdf', mimeType: 'application/pdf', buffer: PDF() });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(zone.locator('.primary')).toHaveText('picked.pdf');
});

test('a file dropped anywhere else on the page does not make the browser open it', async ({ page }) => {
  await page.goto('/');
  for (const tab of ['New report', 'Reports', 'Analytics']) {
    await page.click(`.view-tab:has-text("${tab}")`);
    const cancelled = await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'stray.pdf', { type: 'application/pdf' }));
      const ev = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
      document.body.dispatchEvent(ev);
      const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
      document.body.dispatchEvent(over);
      return ev.defaultPrevented && over.defaultPrevented;
    });
    expect(cancelled, `${tab} tab`).toBe(true);
  }
});

test('dropProblem: what is accepted and what is said when it is not', () => {
  const f = (name: string, type: string) => ({ name, type });
  expect(dropProblem([f('a.pdf', 'application/pdf')])).toBeNull();
  for (const t of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) expect(dropProblem([f('s', t)])).toBeNull();
  // A system that gives no type: the name decides.
  expect(dropProblem([f('SCAN.PDF', '')])).toBeNull();
  expect(dropProblem([f('photo.JPEG', '')])).toBeNull();
  expect(dropProblem([f('notes.txt', '')])).toContain('is not a PDF or an image');
  expect(dropProblem([f('movie.mp4', 'video/mp4')])).toContain('“movie.mp4”');
  // A wrong type is not rescued by a right-looking name.
  expect(dropProblem([f('fake.pdf', 'text/plain')])).toContain('is not a PDF or an image');
  expect(dropProblem([])).toContain('Nothing was dropped');
  expect(dropProblem([f('a.pdf', 'application/pdf'), f('b.pdf', 'application/pdf')])).toContain('one file at a time');
});
