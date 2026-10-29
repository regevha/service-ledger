import { test as base, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deleteReports, listReportIds } from './helpers/api';

/**
 * Drop-in replacement for `test` from '@playwright/test'. Normally identical;
 * with COVERAGE=1 (see `npm run test:e2e:coverage`) it also reads the Istanbul
 * counters the instrumented app keeps in `window.__coverage__` from every page
 * the test opened, and writes them to .nyc_output/ for `nyc report` to merge.
 */
export const test = base.extend<{ _coverage: void; _scanPaneOff: void; _reportCleanup: void }>({
  // Headless Chromium has no PDF viewer, so an inline scan <iframe> is a download in flight that can
  // interrupt typing in the form beside it. Tests start with the scan pane hidden (the per-viewer
  // "Hide scan" preference); the specs that exercise the pane turn it back on with showScanPane().
  _scanPaneOff: [
    async ({ context }, use) => {
      await context.addInitScript(() => {
        try {
          if (localStorage.getItem('sl.review.showScan') === null) localStorage.setItem('sl.review.showScan', 'off');
        } catch {
          /* storage unavailable: nothing to preset */
        }
      });
      await use();
    },
    { auto: true },
  ],
  // Every spec shares one database for the whole run, so reports a test made would pile up and show
  // in the next test's lists, counts and status filters. Whatever reports exist when a test ends that
  // did not exist when it began are deleted, however they were made (the screen or the API) and
  // whether the test passed. Reports made before the first test (a beforeAll) are left alone.
  _reportCleanup: [
    async ({ request }, use) => {
      const before = new Set(await listReportIds(request));
      await use();
      const created = (await listReportIds(request)).filter((id) => !before.has(id));
      await deleteReports(request, created);
    },
    { auto: true },
  ],
  _coverage: [
    async ({ context }, use, testInfo) => {
      await use();
      if (process.env.COVERAGE !== '1') return;
      const dir = path.join(process.cwd(), '.nyc_output');
      mkdirSync(dir, { recursive: true });
      let n = 0;
      for (const page of context.pages()) {
        const data = await page.evaluate(() => (window as unknown as { __coverage__?: unknown }).__coverage__).catch(() => undefined);
        if (data) writeFileSync(path.join(dir, `${testInfo.testId}-${n++}.json`), JSON.stringify(data));
      }
    },
    { auto: true },
  ],
});

export { expect };
