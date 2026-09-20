import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';
import { BACKEND_PORT } from './playwright.config';

// A separate, opt-in config for the one spec in tests/e2e-live/ that exercises
// the real Claude API end to end through the UI — everything in tests/e2e/
// (this project's default suite, see playwright.config.ts) was written
// against the deterministic stub: fake byte-string "PDFs" and assertions on
// exact hardcoded stub values (fixed confidence scores, fixed field text).
// Real Claude can't reproduce those values and will likely reject the fake
// byte strings outright, so that suite is never meant to run with
// USE_LIVE_CLAUDE=true. This config exists so the live path can still be
// sanity-checked by hand, without either contaminating the default suite or
// requiring a real API key/document just to run `npx playwright test`.
//
// Run it explicitly:
//   ANTHROPIC_API_KEY=... LIVE_SMOKE_FIXTURE_PATH=/path/to/a/real/scan.pdf \
//     npx playwright test --config=playwright.live.config.ts
// (see tests/e2e-live/live-claude-smoke.spec.ts for what the fixture needs
// to be and why it's never committed to this repo).

const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PINNED_CHROMIUM = existsSync(SANDBOX_CHROMIUM) ? SANDBOX_CHROMIUM : undefined;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  throw new Error(
    'playwright.live.config.ts requires ANTHROPIC_API_KEY in the environment — ' +
      'this run talks to the real Claude API, not the stub.'
  );
}

// Reuses the same e2e database as the stub suite (playwright.config.ts) —
// reset_db.py truncates it before every run regardless of which config
// launched it, so there's no state to keep separate between the two.
const LIVE_BACKEND_PORT = BACKEND_PORT;
const FRONTEND_PORT = 5175; // different from playwright.config.ts's 5174 so the two configs never collide if run back to back without waiting for teardown
const E2E_DATABASE_URL = 'postgresql+psycopg2://service_ledger:service_ledger_dev@localhost:5432/service_ledger_e2e';

export default defineConfig({
  testDir: './tests/e2e-live',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  // Real classify() + extract() calls (two sequential live Claude requests,
  // each with up to ANTHROPIC_MAX_RETRIES retries and a 90s timeout per
  // backend/app/config.py's defaults) take far longer than the stub's
  // near-instant response — the stub suite's 60s default would be too tight.
  timeout: 240_000,

  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      ...(PINNED_CHROMIUM ? { executablePath: PINNED_CHROMIUM } : {}),
      args: ['--no-sandbox'],
    },
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: [
    {
      command: `bash -c "DATABASE_URL='${E2E_DATABASE_URL}' USE_LIVE_CLAUDE=false python3 -m app.testing.reset_db && DATABASE_URL='${E2E_DATABASE_URL}' USE_LIVE_CLAUDE=true ANTHROPIC_API_KEY='${ANTHROPIC_API_KEY}' uvicorn app.main:app --host 0.0.0.0 --port ${LIVE_BACKEND_PORT}"`,
      cwd: '../backend',
      url: `http://localhost:${LIVE_BACKEND_PORT}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // The worker is what actually calls classify()/extract() (§3) — it
      // needs USE_LIVE_CLAUDE=true and the real key too, not just the backend.
      command: `bash -c "DATABASE_URL='${E2E_DATABASE_URL}' USE_LIVE_CLAUDE=true ANTHROPIC_API_KEY='${ANTHROPIC_API_KEY}' python3 -m app.worker"`,
      cwd: '../backend',
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `npx vite --port ${FRONTEND_PORT} --strictPort`,
      env: { VITE_API_BASE_URL: `http://localhost:${LIVE_BACKEND_PORT}` },
      url: `http://localhost:${FRONTEND_PORT}`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
