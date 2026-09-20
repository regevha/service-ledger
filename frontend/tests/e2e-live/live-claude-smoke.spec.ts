import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';

// A one-spec, opt-in sanity check that the real Claude API path works end to
// end through the actual UI — upload -> classify -> (manual confirm if
// needed) -> extract -> review -> finalize. Everything in tests/e2e/ runs
// against the deterministic stub and asserts exact hardcoded values (see
// playwright.config.ts's own comments); none of that is reproducible with a
// real model call, so this lives in its own directory/config
// (playwright.live.config.ts) that nothing else picks up by accident.
//
// Needs a real scanned service report PDF, supplied via LIVE_SMOKE_FIXTURE_PATH
// — never committed to this repo (same convention as backend/app/
// seed_demo_reports.py's docstring: original scans are real third-party
// records and stay out of git). Skips cleanly if the env var isn't set or
// doesn't point at a real file, rather than failing a run that never meant
// to exercise this path.
//
// Assertions here are deliberately loose compared to the stub suite: a real
// model's exact wording/confidence can vary slightly run to run, so this
// checks for absence of errors and for the coarse facts a real BD Care work
// order should always yield (some fields extracted, correctly routed to a
// report-type-specific field), not byte-for-byte field values.

const FIXTURE = process.env.LIVE_SMOKE_FIXTURE_PATH;

test('upload -> classify -> extract -> review -> finalize against the real Claude API', async ({ page }) => {
  test.skip(!FIXTURE || !existsSync(FIXTURE), 'LIVE_SMOKE_FIXTURE_PATH is not set to an existing file — see file header.');

  await page.goto('/');
  await page.click('.view-tab:has-text("New report")');
  await page.fill('input[placeholder="Your name (optional)"]', 'E2E Live Smoke');
  await page.locator('input[type="file"]').setInputFiles(FIXTURE as string);
  await page.click('button:has-text("Upload & classify")');

  // Real classification can land confident (straight to fields) or below
  // threshold (manual-confirm detour) — both are correct app behavior, so
  // this branches on whichever the live call actually produced instead of
  // assuming one, unlike happy-path.spec.ts which picks a stub fixture
  // specifically to force the confident branch.
  const outcome = page.locator('.field-list, .class-row, .banner-crit');
  await outcome.first().waitFor({ timeout: 120_000 });

  if (await page.locator('.banner-crit').count()) {
    const message = await page.locator('.banner-crit').first().textContent();
    throw new Error(`Live classify/extract call failed: ${message}`);
  }

  if (await page.locator('.class-row').count()) {
    await page.click('button:has-text("Confirm & continue")');
    await expect(page.locator('.field-list, .banner-crit')).toBeVisible({ timeout: 120_000 });
    if (await page.locator('.banner-crit').count()) {
      const message = await page.locator('.banner-crit').first().textContent();
      throw new Error(`Live extract call failed after manual confirm: ${message}`);
    }
  }

  await expect(page.locator('.field-list')).toBeVisible();
  const fieldCount = await page.locator('.field-list .field').count();
  expect(fieldCount).toBeGreaterThan(0);

  await page.click('button:has-text("Save & finalize report")');
  await expect(page.locator('.success-panel')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.success-panel')).toContainText('finalized');
});
