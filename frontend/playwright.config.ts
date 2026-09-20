import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// Pinned to this exact executable only where it actually exists (the cloud
// sandbox this suite was first written in, which pre-installs Chromium here
// rather than through Playwright's own browser cache — see PLAYWRIGHT_BROWSERS_PATH).
// Anywhere else — a developer's own machine, CI — this is undefined and
// Playwright launches whatever `npx playwright install chromium` put in its
// own cache instead. Don't hardcode a path here without this guard: it
// silently breaks `browserType.launch` everywhere the path doesn't exist,
// with no hint beyond "executable doesn't exist at <path>".
const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PINNED_CHROMIUM = existsSync(SANDBOX_CHROMIUM) ? SANDBOX_CHROMIUM : undefined;

// A dedicated port + database for this suite — never the dev server on 8000
// (which may be running USE_LIVE_CLAUDE=true against real demo data, per
// backend/.env) and never backend/tests/conftest.py's own
// calibration_ledger_test database (whose schema is created/dropped around
// each pytest session, so its tables may not exist between pytest runs).
// calibration_ledger_e2e is a one-time manual createdb (see README.md) that
// this suite owns end to end: reset_db.py truncates it before every run.
//
// Exported (not just local to this file) so spec files build their own
// direct request.post/get URLs (see reports-search.spec.ts, csv-export.spec.ts,
// field-editing.spec.ts) from this one number instead of a second hardcoded
// "8001" literal — changing this without also catching every duplicate used
// to be exactly the kind of drift nothing would catch until a spec started
// failing for an unrelated-looking reason.
export const BACKEND_PORT = 8001;
const FRONTEND_PORT = 5174;
const E2E_DATABASE_URL = 'postgresql+psycopg2://calibration_ledger:calibration_ledger_dev@localhost:5432/calibration_ledger_e2e';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  // One worker: every spec shares the one backend/database this config
  // boots, and there's no per-test truncation (unlike the pytest suite) —
  // specs are written to filter/assert on markers they created themselves
  // rather than on absolute counts, so run order doesn't matter, but two
  // specs mutating the same report concurrently would.
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,

  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      // undefined (see above) falls back to Playwright's own installed
      // browser, which is what every machine other than that one sandbox
      // needs. --no-sandbox is for running as root in that same sandbox/CI;
      // harmless but unnecessary on a normal desktop, kept for both.
      ...(PINNED_CHROMIUM ? { executablePath: PINNED_CHROMIUM } : {}),
      args: ['--no-sandbox'],
    },
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: [
    {
      // Truncate the E2E database, then boot a stub-mode backend against it.
      // app.main's own startup lifespan reseeds the instrument fleet +
      // report templates the moment this boots, so reset_db.py only has to
      // clear rows, never restore them.
      command: `bash -c "DATABASE_URL='${E2E_DATABASE_URL}' USE_LIVE_CLAUDE=false python3 -m app.testing.reset_db && DATABASE_URL='${E2E_DATABASE_URL}' USE_LIVE_CLAUDE=false uvicorn app.main:app --host 0.0.0.0 --port ${BACKEND_PORT}"`,
      cwd: '../backend',
      url: `http://localhost:${BACKEND_PORT}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // §3's background worker — classify/extract (§9) only enqueue a job
      // now, so nothing in this suite would ever leave "pending" without
      // this running against the same E2E database the backend above uses.
      // No `url`: a polling worker has no HTTP endpoint to health-check
      // against, so Playwright just launches it and moves on; the backend
      // entry above is still what gates "servers are ready."
      command: `bash -c "DATABASE_URL='${E2E_DATABASE_URL}' USE_LIVE_CLAUDE=false python3 -m app.worker"`,
      cwd: '../backend',
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `npx vite --port ${FRONTEND_PORT} --strictPort`,
      env: { VITE_API_BASE_URL: `http://localhost:${BACKEND_PORT}` },
      url: `http://localhost:${FRONTEND_PORT}`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
