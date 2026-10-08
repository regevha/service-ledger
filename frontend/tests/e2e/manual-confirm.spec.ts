import { test, expect } from './coverage';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The uncertain case (§4): the stub special-cases any filename containing
// "sample" (among other markers) to reproduce the real BD Care EU Work
// Order's actual asymmetry — a confident instrument read, a report-type
// guess below threshold — forcing the manual-confirm detour before
// extraction can run. This is the exact branch the Reports-tab live tests
// this session kept landing in for real (see the BD EU work order runs).

const FIXTURE = path.join(__dirname, 'fixtures', 'sample-work-order.pdf');

test('uncertain report type routes through manual confirm before extracting', async ({ page }) => {
  await page.goto('/');

  await page.click('.view-tab:has-text("New report")');
  await page.fill('input[placeholder="Your name (optional)"]', 'E2E Manual Confirm');
  await page.locator('input[type="file"]').setInputFiles(FIXTURE);
  await page.click('button:has-text("Upload & classify")');

  await page.waitForSelector('.class-row', { timeout: 30_000 });
  await expect(page.locator('.class-row')).toHaveCount(2);

  // Instrument: confident (§4's stub reproduces 0.96). Report type: below
  // threshold (0.58) — flagged "needs review", not silently accepted.
  const instrumentRow = page.locator('.class-row').nth(0);
  await expect(instrumentRow).toContainText('Instrument');
  await expect(instrumentRow.locator('.badge-good')).toBeVisible();
  // The stub is a demo stand-in, so the badge says so instead of a percentage.
  await expect(instrumentRow.locator('.badge')).toHaveText('demo value');

  const typeRow = page.locator('.class-row').nth(1);
  await expect(typeRow).toContainText('Report type');
  await expect(typeRow.locator('.badge-warn')).toBeVisible();

  await page.click('button:has-text("Confirm & continue")');
  await expect(page.locator('.field-list')).toBeVisible({ timeout: 30_000 });

  // The stub's real BD Care values for this exact fixture (§5) — root_cause
  // and components_replaced are genuinely blank on the source document, not
  // a bad read, and both get flagged for review rather than guessed.
  const faultCategoryField = page.locator('.field', { hasText: 'fault category' });
  await expect(faultCategoryField.locator('select')).toHaveValue('fluidics');

  const workPerformedField = page.locator('.field', { hasText: 'work performed' });
  await expect(workPerformedField.locator('textarea')).toHaveValue(/fluidics path/);

  const rootCauseField = page.locator('.field', { hasText: 'root cause' });
  await expect(rootCauseField).toHaveClass(/pending/);
  await expect(rootCauseField.locator('textarea')).toHaveValue('');

  // A human fills in the blank the model correctly declined to guess.
  await rootCauseField.locator('textarea').fill('Sample injector O-ring degraded');
  await page.click('button:has-text("Save & finalize report")');
  await expect(page.locator('.success-panel')).toBeVisible({ timeout: 15_000 });
});
