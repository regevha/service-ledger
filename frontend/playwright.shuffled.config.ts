import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Same suite, same servers, same settings as playwright.config.ts, but the
// specs are read from the shuffled copy that scripts/run-e2e-shuffled.mjs
// builds (and removes afterwards). Don't run this config directly: the
// directory only exists while the script is running.
export default defineConfig(base, { testDir: './tests/e2e_shuffled' });
