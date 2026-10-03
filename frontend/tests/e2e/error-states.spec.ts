import { test, expect } from './coverage';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Every step's failure state (§9): a network-level failure (backend
// unreachable) and a backend-returned error (classification failing) each
// need to land on the same '.banner-crit' + Start over / Try again UI, per
// App.tsx's Phase union — not a raw crash or a silently stuck spinner.

const FIXTURE = path.join(__dirname, 'fixtures', 'confident-scan.pdf');

test('an unreachable backend surfaces a clear connection error', async ({ page }) => {
  await page.route('**/reports', (route) => {
    if (route.request().method() === 'POST') return route.abort('connectionrefused');
    return route.continue();
  });

  await page.goto('/');
  await page.click('.view-tab:has-text("New report")');
  await page.locator('input[type="file"]').setInputFiles(FIXTURE);
  await page.click('button:has-text("Upload & classify")');

  await expect(page.locator('.banner-crit')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.banner-crit')).toContainText('Could not reach the backend');
  await expect(page.locator('button:has-text("Start over")')).toBeVisible();
  await expect(page.locator('button:has-text("Try again")')).toBeVisible();
});

test('a failed classification surfaces the backend error and Try again re-attempts it', async ({ page }) => {
  let classifyAttempts = 0;
  await page.route('**/attachments/*/classify', (route) => {
    classifyAttempts += 1;
    return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ detail: 'Simulated classification failure' }) });
  });

  await page.goto('/');
  await page.click('.view-tab:has-text("New report")');
  await page.locator('input[type="file"]').setInputFiles(FIXTURE);
  await page.click('button:has-text("Upload & classify")');

  await expect(page.locator('.banner-crit')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.banner-crit')).toContainText('Simulated classification failure');
  expect(classifyAttempts).toBe(1);

  await page.click('button:has-text("Try again")');
  await expect(page.locator('.banner-crit')).toBeVisible({ timeout: 15_000 });
  expect(classifyAttempts).toBe(2);

  await page.click('button:has-text("Start over")');
  await expect(page.locator('.dropzone')).toBeVisible();
  await expect(page.locator('.banner-crit')).toHaveCount(0);
});

test('a file that is not a PDF or an image is refused with the reason', async ({ page }) => {
  await page.goto('/');
  await page.click('.view-tab:has-text("New report")');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('just some notes, not a scan'),
  });
  await page.click('button:has-text("Upload & classify")');

  await expect(page.locator('.banner-crit')).toContainText('Unsupported file type', { timeout: 15_000 });
  await expect(page.locator('.banner-crit')).toContainText('PDF');
  await expect(page.locator('button:has-text("Start over")')).toBeVisible();
});

test('an image scan is accepted, not just a PDF', async ({ page }) => {
  // A 1x1 PNG: enough for the upload check, which reads the file's own bytes.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  await page.goto('/');
  await page.click('.view-tab:has-text("New report")');
  await page.locator('input[type="file"]').setInputFiles({ name: 'scan.png', mimeType: 'image/png', buffer: png });
  await page.click('button:has-text("Upload & classify")');

  // Past the upload step: it reaches classification (the manual pick or the
  // review screen, depending on how many instruments share the guessed model).
  await page.waitForSelector('.field-list, .class-row', { timeout: 30_000 });
  await expect(page.locator('.banner-crit')).toHaveCount(0);
});
