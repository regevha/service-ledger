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
// Run by hand, or every week by .github/workflows/live-claude.yml (which fails loudly when its
// secrets are missing, so a broken check is never mistaken for a passing one).
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
// report-type-specific field), not byte-for-byte field values. After the run it also checks the
// shape of what came back through the API: the job succeeded, every confidence is a number between
// 0 and 1, the report is finalized and has extracted fields. A changed model, a changed reply
// format or an expired key shows up here before it shows up for a user.

const FIXTURE = process.env.LIVE_SMOKE_FIXTURE_PATH;

type JobBody = { status?: string; error_message?: string | null; field_confidences?: Record<string, unknown> | null };

test('upload -> classify -> extract -> review -> finalize against the real Claude API', async ({ page, request }) => {
  test.skip(!FIXTURE || !existsSync(FIXTURE), 'LIVE_SMOKE_FIXTURE_PATH is not set to an existing file — see file header.');

  // What the page was told about its jobs and reports, kept to check the shape afterwards.
  const jobs: JobBody[] = [];
  let reportId: string | undefined;
  page.on('response', async (res) => {
    const url = new URL(res.url());
    try {
      if (/^\/extraction-jobs\/[^/]+$/.test(url.pathname) && res.request().method() === 'GET') jobs.push(await res.json());
      if (url.pathname === '/reports' && res.request().method() === 'POST' && res.ok()) reportId = (await res.json()).id;
    } catch {
      /* a response that went away with the page: nothing to record */
    }
  });

  await page.goto('/');
  await page.click('.view-tab:has-text("New report")');
  await page.fill('input[placeholder="Your name (optional)"]', 'E2E Live Smoke');
  await page.getByTestId('intake-file-input').setInputFiles(FIXTURE as string);
  await page.click('button:has-text("Upload & classify")');

  // Real classification can land confident (straight to fields) or below
  // threshold (manual-confirm detour) — both are correct app behavior, so
  // this branches on whichever the live call actually produced instead of
  // assuming one, unlike happy-path.spec.ts which picks a stub fixture
  // specifically to force the confident branch.
  const outcome = page.locator('.field-list, [data-testid="class-row"], [data-testid="intake-error"]');
  await outcome.first().waitFor({ timeout: 120_000 });

  if (await page.getByTestId('intake-error').count()) {
    const message = await page.getByTestId('intake-error').first().textContent();
    throw new Error(`Live classify/extract call failed: ${message}`);
  }

  if (await page.getByTestId('class-row').count()) {
    await page.click('button:has-text("Confirm & continue")');
    await expect(page.locator('.field-list, [data-testid="intake-error"]').first()).toBeVisible({ timeout: 120_000 });
    if (await page.getByTestId('intake-error').count()) {
      const message = await page.getByTestId('intake-error').first().textContent();
      throw new Error(`Live extract call failed after manual confirm: ${message}`);
    }
  }

  await expect(page.locator('.field-list')).toBeVisible();
  const fieldCount = await page.locator('.field-list .field').count();
  expect(fieldCount).toBeGreaterThan(0);

  await page.click('button:has-text("Save & finalize report")');
  await expect(page.getByTestId('intake-success')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('intake-success')).toContainText('finalized');

  // The shape of what came back, through the API. Values are not compared: they vary run to run.
  const extraction = jobs.filter((j) => j.status === 'succeeded').pop();
  expect(extraction, `no extraction job succeeded (saw statuses: ${jobs.map((j) => j.status).join(', ')})`).toBeDefined();
  const confidences = Object.entries(extraction!.field_confidences ?? {});
  expect(confidences.length, 'the extraction returned no field confidences').toBeGreaterThan(0);
  for (const [name, value] of confidences) {
    expect(typeof value === 'number' && value >= 0 && value <= 1, `confidence for ${name} is ${JSON.stringify(value)}, not a number from 0 to 1`).toBe(true);
  }

  expect(reportId, 'the page never created a report').toBeDefined();
  const report = await (await request.get(`${process.env.API_BASE_URL ?? 'http://localhost:8001'}/reports/${reportId}`)).json();
  expect(report.status).toBe('finalized');
  expect(Object.keys(report.extracted_fields ?? {}).length, 'the finalized report has no extracted fields').toBeGreaterThan(0);
});
