import { defineConfig } from '@playwright/test';

// A short check of a deployment that is already running, to be run right after a deploy
// (deploy/smoke.sh does it). No servers are started and nothing is built: it talks to the address
// it is given, so it is safe to point at the real thing, and it does not run in CI (which has no
// deployed address).
//
//   BASE_URL=https://example SMOKE_PASSWORD=... npx playwright test --config=playwright.smoke.config.ts
//   (add SMOKE_STUB=1 when the deployment runs the stub extractor, not live Claude)
//
// The specs make plain HTTP requests, no browser, so nothing needs installing beyond npm ci. Every
// record they create is named SMOKE-<timestamp> and removed again at the end.

const BASE_URL = process.env.BASE_URL?.replace(/\/+$/, '');
const SMOKE_PASSWORD = process.env.SMOKE_PASSWORD;
if (!BASE_URL || !SMOKE_PASSWORD) {
  throw new Error(
    'playwright.smoke.config.ts needs BASE_URL (the deployed address) and SMOKE_PASSWORD (the shared password) in the environment.'
  );
}

// The shared helpers (tests/e2e/helpers/api.ts) read this, so seedReport talks to the deployment.
process.env.API_BASE_URL = BASE_URL;

export default defineConfig({
  testDir: './tests/e2e-smoke',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list']],
  // A cold start of a scaled-to-zero service can take a while to answer the first request.
  timeout: 120_000,
  use: {
    baseURL: BASE_URL,
    httpCredentials: { username: 'smoke', password: SMOKE_PASSWORD, send: 'always' },
  },
});
