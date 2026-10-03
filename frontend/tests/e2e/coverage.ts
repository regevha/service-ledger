import { test as base, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Drop-in replacement for `test` from '@playwright/test'. Normally identical;
 * with COVERAGE=1 (see `npm run test:e2e:coverage`) it also reads the Istanbul
 * counters the instrumented app keeps in `window.__coverage__` from every page
 * the test opened, and writes them to .nyc_output/ for `nyc report` to merge.
 */
export const test = base.extend<{ _coverage: void }>({
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
