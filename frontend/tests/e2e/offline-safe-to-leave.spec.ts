import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './coverage';
import { uniqueFixture } from './unique-upload';
import { TIMEOUT } from './timeouts';
import { leaveNote } from '../../src/components/intake/leaveNote';

// When it is safe to leave the page, and what is said when the connection is gone (src/components/OfflineBanner.tsx,
// intake/WorkingPanel.tsx, BatchIntake.tsx). Playwright's setOffline makes the browser report no connection.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'confident-scan.pdf');

test.describe('the words', () => {
  test('keep the page open while the scan is sent; leaving is safe once it is sent', () => {
    expect(leaveNote(true, true)).toMatch(/Keep this page open until the scan has been sent/);
    expect(leaveNote(true, false)).toMatch(/offline.*cannot be sent.*Keep this page open/);
    expect(leaveNote(false, true)).toMatch(/You can leave this tab/);
    expect(leaveNote(false, false)).toMatch(/offline.*already sent.*safe to leave.*Reports/);
  });
});

test('offline: a banner shows on every screen while the connection is gone and goes when it is back', async ({ page, context }) => {
  await page.goto('/#/reports');
  await expect(page.getByTestId('offline-banner')).toHaveCount(0);
  await context.setOffline(true);
  await expect(page.getByTestId('offline-banner')).toBeVisible();
  await page.getByTestId('tab-analytics').click();
  await expect(page.getByTestId('offline-banner')).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByTestId('offline-banner')).toHaveCount(0);
});

test('intake: while the scan is being sent it says to keep the page open; once sent, that leaving is safe, also offline', async ({ page, context }) => {
  let releaseUpload!: () => void;
  const uploadGate = new Promise<void>((resolve) => (releaseUpload = resolve));
  await page.route('**/reports/*/attachments', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await uploadGate;
    await route.continue();
  });
  let releaseJob!: () => void;
  const jobGate = new Promise<void>((resolve) => (releaseJob = resolve));
  await page.route('**/extraction-jobs/*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await jobGate;
    await route.continue();
  });

  await page.goto('/#/new');
  await page.getByTestId('intake-file-input').setInputFiles(uniqueFixture(FIXTURE));
  await page.click('button:has-text("Upload & classify")');

  const note = page.getByTestId('intake-leave-note');
  await expect(note).toContainText('Keep this page open until the scan has been sent', { timeout: TIMEOUT.ui });
  await expect(page.getByTestId('intake-working')).toContainText('Sending the scan');

  await context.setOffline(true);
  await expect(note).toContainText('You are offline, so the scan cannot be sent yet');
  await context.setOffline(false);

  releaseUpload();
  await expect(note).toContainText('You can leave this tab', { timeout: TIMEOUT.ui });
  await expect(page.getByTestId('intake-working')).toContainText('Scan uploaded');

  await context.setOffline(true);
  await expect(note).toContainText('already sent');
  await expect(note).toContainText('safe to leave');
  await context.setOffline(false);
  releaseJob();
  await expect(page.getByTestId('intake-working')).toHaveCount(0, { timeout: TIMEOUT.ui }); // let the flow finish before the test ends
});

test('several files: while they run it says to keep the tab open, and what changes when offline', async ({ page, context }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/reports/*/attachments', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await gate;
    await route.continue();
  });
  await page.goto('/#/batch');
  await expect(page.getByTestId('batch-keep-open')).toHaveCount(0);
  await page.getByTestId('batch-input').setInputFiles(uniqueFixture(FIXTURE));
  await expect(page.getByTestId('batch-keep-open')).toHaveCount(0); // nothing runs until the person starts it
  await page.getByTestId('batch-start').click();
  const keep = page.getByTestId('batch-keep-open');
  await expect(keep).toContainText('Keep this tab open until every file is done');
  await context.setOffline(true);
  await expect(keep).toContainText('You are offline');
  await context.setOffline(false);
  await expect(keep).toContainText('Keep this tab open until every file is done');
  release();
  await expect(page.getByTestId('batch-state')).not.toHaveText('Uploading', { timeout: TIMEOUT.ui });
});
