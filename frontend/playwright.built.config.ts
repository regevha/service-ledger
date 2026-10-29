import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { E2E_DATABASE_URL } from './playwright.config';

// The suite against what is actually deployed: the production build of the page, served by the
// backend itself (FRONTEND_DIST_DIR), behind the shared password. No Vite server, one origin, so the
// page's API calls are same-origin (VITE_API_BASE_URL is empty at build time) and the browser's own
// password prompt covers the page and the API alike. The default suite (playwright.config.ts) can't
// see any of this: it runs the dev server on one port and the API on another, with no password.
//
//   npx playwright test --config=playwright.built.config.ts
//
// It shares the e2e database with the default suite, so don't run the two at the same time.
// tests/e2e-built/ holds the specs that exist only for this setup (the password gate); the four
// specs below are the default suite's own, re-run against the built page.

const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PINNED_CHROMIUM = existsSync(SANDBOX_CHROMIUM) ? SANDBOX_CHROMIUM : undefined;

const BACKEND_PORT = 8002; // not 8001, so a leftover default-suite server is never mistaken for this one
const BUILT_PASSWORD = 'e2e-built-pass-1234'; // a throwaway for a throwaway database; at least 12 characters
const DIST_DIR = join(tmpdir(), 'service-ledger-e2e-dist');
const ORIGIN = `http://localhost:${BACKEND_PORT}`;

// The shared helpers (tests/e2e/helpers/api.ts) read this, so the specs' direct API calls go to the
// one origin. Set here, not only in the webServer env, because the test workers load this file too.
process.env.API_BASE_URL = ORIGIN;
// Likewise for the gate spec, which needs the password to check what the wrong one does.
process.env.BUILT_PASSWORD = BUILT_PASSWORD;

export default defineConfig({
  testDir: './tests',
  testMatch: [/e2e-built\/.*\.spec\.ts$/, /e2e\/(happy-path|manual-confirm|field-editing|reports-search)\.spec\.ts$/],
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  timeout: 60_000,

  use: {
    baseURL: ORIGIN,
    // Sent with every request, including the specs' direct API calls. The gate spec opens its own
    // contexts when it needs none or the wrong one.
    httpCredentials: { username: 'tester', password: BUILT_PASSWORD, send: 'always' },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      ...(PINNED_CHROMIUM ? { executablePath: PINNED_CHROMIUM } : {}),
      args: ['--no-sandbox'],
    },
  },

  projects: [{ name: 'built', use: { ...devices['Desktop Chrome'] } }],

  webServer: [
    {
      // Build the page into a temp folder, empty the database, then start the backend serving that
      // folder. The build is what makes the first start slow, hence the long timeout.
      command: `bash -c "cd ../frontend && VITE_API_BASE_URL= npx vite build --outDir '${DIST_DIR}' --emptyOutDir && cd ../backend && DATABASE_URL='${E2E_DATABASE_URL}' USE_LIVE_CLAUDE=false STUB_EXTRACT_FROM_TEXT=false python3 -m app.testing.reset_db && DATABASE_URL='${E2E_DATABASE_URL}' USE_LIVE_CLAUDE=false STUB_EXTRACT_FROM_TEXT=false SHARED_PASSWORD='${BUILT_PASSWORD}' FRONTEND_DIST_DIR='${DIST_DIR}' uvicorn app.main:app --host 0.0.0.0 --port ${BACKEND_PORT}"`,
      cwd: '../backend',
      url: `${ORIGIN}/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // The background worker, as in the default config. It can start before the build finishes:
      // it only polls the database.
      command: `bash -c "DATABASE_URL='${E2E_DATABASE_URL}' USE_LIVE_CLAUDE=false STUB_EXTRACT_FROM_TEXT=false python3 -m app.worker"`,
      cwd: '../backend',
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
