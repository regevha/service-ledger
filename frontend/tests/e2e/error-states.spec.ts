import { test, expect } from '@playwright/test';
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
