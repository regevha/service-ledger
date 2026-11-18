import { fileURLToPath } from 'node:url';
import { test, expect } from './coverage';

// Several PDFs chosen or dropped on the New report screen go to the batch screen, as on Home.
// Nothing is uploaded here: the batch screen only lists the files until the person starts it.
const PDF = () => Buffer.from('%PDF-1.4\n% synthetic test file\n');
const pdf = (name: string) => ({ name, mimeType: 'application/pdf', buffer: PDF() });

test('two PDFs chosen on the New report screen open the batch screen with both listed', async ({ page }) => {
  await page.goto('/#/new');
  await expect(page.getByText('Several PDFs? Each becomes its own report.')).toBeVisible();
  await page.getByTestId('intake-file-input').setInputFiles([pdf('multi-a.pdf'), pdf('multi-b.pdf')]);
  await expect(page.getByTestId('batch-screen')).toBeVisible();
  await expect(page).toHaveURL(/#\/batch/);
  await expect(page.getByTestId('batch-row')).toHaveCount(2);
  await expect(page.getByTestId('batch-row').first()).toHaveAttribute('data-state', 'queued');
  await expect(page.getByTestId('batch-row').nth(1)).toHaveAttribute('data-state', 'queued');
});

test('three PDFs dropped on the dropzone open the batch screen', async ({ page }) => {
  await page.goto('/#/new');
  const dt = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    for (const n of ['drop-a.pdf', 'drop-b.pdf', 'drop-c.pdf']) d.items.add(new File(['%PDF-1.4'], n, { type: 'application/pdf' }));
    return d;
  });
  await page.locator('.dropzone').dispatchEvent('drop', { dataTransfer: dt });
  await expect(page.getByTestId('batch-screen')).toBeVisible();
  await expect(page.getByTestId('batch-row')).toHaveCount(3);
});

test('one PDF keeps the single-report flow', async ({ page }) => {
  await page.goto('/#/new');
  await page.getByTestId('intake-file-input').setInputFiles(pdf('only-one.pdf'));
  await expect(page).toHaveURL(/#\/new/);
  await expect(page.getByTestId('batch-screen')).toHaveCount(0);
  await expect(page.locator('.dropzone .primary')).toHaveText('only-one.pdf');
  await expect(page.getByRole('button', { name: 'Upload & classify' })).toBeEnabled();
});

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X4VQAAAAASUVORK5CYII=';

test('mixed intake can correct a suggested split, reorder, and queue the result', async ({ page }) => {
  await page.goto('/#/new');
  await page.getByTestId('intake-file-input').setInputFiles([
    { name: 'page-photo.png', mimeType: 'image/png', buffer: Buffer.from(PIXEL, 'base64') },
    fileURLToPath(new URL('./fixtures/synthetic-confident-scan.pdf', import.meta.url)),
  ]);
  await expect(page.getByRole('heading', { name: 'Group pages into reports' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Queue 2 reports' })).toBeEnabled();
  await page.getByRole('combobox', { name: 'Move page 1 of report 2' }).selectOption({ label: 'Report 1' });
  const group = page.getByRole('group', { name: 'Report 1 · 2 pages' });
  await group.getByRole('button', { name: 'Move up' }).last().click();
  await expect(group.getByRole('listitem').first()).toContainText('synthetic-confident-scan.pdf');
  await page.getByRole('button', { name: 'Queue 1 report' }).click();
  await expect(page.getByTestId('batch-row')).toHaveCount(1);
  await expect(page.getByTestId('batch-row')).toContainText('synthetic-confident-scan-grouped.pdf');
});

test('Home opens the same grouping preview for mixed files', async ({ page }) => {
  await page.goto('/#/');
  await page.getByTestId('home-file-input').setInputFiles([
    fileURLToPath(new URL('./fixtures/synthetic-confident-scan.pdf', import.meta.url)),
    { name: 'page-photo.png', mimeType: 'image/png', buffer: Buffer.from(PIXEL, 'base64') },
  ]);
  await expect(page.getByRole('heading', { name: 'Group pages into reports' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Queue 2 reports' })).toBeEnabled();
});
