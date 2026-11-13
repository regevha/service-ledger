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

test('two PDFs with a photo are refused, and the screen stays on New report (#326)', async ({ page }) => {
  await page.goto('/#/new');
  await page.getByTestId('intake-file-input').setInputFiles([
    pdf('mix-a.pdf'),
    pdf('mix-b.pdf'),
    { name: 'mix-c.png', mimeType: 'image/png', buffer: Buffer.from('x') },
  ]);
  await expect(page.getByRole('alert')).toContainText('Upload the PDFs and the photos separately');
  await expect(page).toHaveURL(/#\/new/);
  await expect(page.getByTestId('batch-screen')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Upload & classify' })).toBeDisabled();
});

test('two PDFs and a photo dropped together are refused too', async ({ page }) => {
  await page.goto('/#/new');
  const dt = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    d.items.add(new File(['%PDF-1.4'], 'drop-mix-a.pdf', { type: 'application/pdf' }));
    d.items.add(new File(['%PDF-1.4'], 'drop-mix-b.pdf', { type: 'application/pdf' }));
    d.items.add(new File(['x'], 'drop-mix-c.png', { type: 'image/png' }));
    return d;
  });
  await page.locator('.dropzone').dispatchEvent('drop', { dataTransfer: dt });
  await expect(page.getByRole('alert')).toContainText('Upload the PDFs and the photos separately');
  await expect(page).toHaveURL(/#\/new/);
  await expect(page.getByTestId('batch-screen')).toHaveCount(0);
});

test('one PDF with photos is refused and the message says what to do', async ({ page }) => {
  await page.goto('/#/new');
  await page.getByTestId('intake-file-input').setInputFiles([
    { name: 'a.png', mimeType: 'image/png', buffer: Buffer.from('x') },
    pdf('b.pdf'),
  ]);
  await expect(page.getByRole('alert')).toContainText('choose only PDFs');
  await expect(page.getByRole('button', { name: 'Upload & classify' })).toBeDisabled();
});
