import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect } from './coverage';
import { seedReport } from './helpers/api';
import { openAnalytics, openReports, openReviewFromList } from './helpers/ui';

// The same axe-core scan as accessibility.spec.ts (WCAG 2 A and AA), on the same screens, with the dark
// theme chosen. Colour contrast is the rule that differs between themes: a text colour that passes on the
// light surfaces can fall just short on the dark ones (the faint text on the raised surface did, at 4.31
// against the 4.5 needed). There is no list of known problems here: dark mode is expected to be clean.

test.beforeEach(async ({ context }) => {
  // The theme the person chose, as the app itself keeps it (src/theme.ts).
  await context.addInitScript(() => {
    try {
      localStorage.setItem('sl.theme', 'dark');
    } catch {
      /* storage unavailable: the test below then fails on the theme check, not silently scans light */
    }
  });
});

async function scanDark(page: Page, screen: string) {
  // Without this a scan of the light theme would pass for the wrong reason.
  expect(await page.evaluate(() => document.documentElement.dataset.theme), `${screen}: dark theme is in force`).toBe('dark');
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const problems = results.violations.map((v) => {
    const first = v.nodes[0]?.any[0]?.data as { fgColor?: string; bgColor?: string; contrastRatio?: number } | undefined;
    const colours = first?.fgColor ? ` (${first.fgColor} on ${first.bgColor}, ratio ${first.contrastRatio})` : '';
    return `${v.id} (${v.impact}): ${v.help}${colours}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('\n    ')}`;
  });
  expect(problems, `accessibility problems on ${screen} in dark mode`).toEqual([]);
}

test('dark: intake screen', async ({ page }) => {
  await page.goto('/#/new');
  await page.getByTestId('tab-new').click();
  await expect(page.getByTestId('intake-dropzone')).toBeVisible();
  await scanDark(page, 'intake');
});

test('dark: reports list', async ({ page, request }) => {
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: `E2E-A11yDark-${Date.now()}`, finalize: true });
  await openReports(page);
  await expect(page.locator('.report-table')).toBeVisible();
  await scanDark(page, 'reports');
});

test('dark: review screen', async ({ page, request }) => {
  const marker = `E2E-A11yDark-${Date.now()}`;
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: marker, finalize: true });
  await openReviewFromList(page, marker);
  await scanDark(page, 'review');
});

test('dark: analytics', async ({ page, request }) => {
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: `E2E-A11yDark-${Date.now()}`, finalize: true });
  await openAnalytics(page);
  await scanDark(page, 'analytics');
});

for (const [part, ready] of [
  ['Instruments', '[data-testid="instrument-row"]'],
  ['Models', '#models-section'],
  ['Makers', '#makers-section'],
  ['Places', '#places-section'],
] as const) {
  test(`dark: instruments tab: ${part.toLowerCase()}`, async ({ page, request }) => {
    await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: `E2E-A11yDark-${Date.now()}`, finalize: true });
    await page.goto('/#/new');
    await page.getByTestId('tab-instruments').click();
    if (part !== 'Instruments') await page.click(`.sub-switch button:has-text("${part}")`);
    await expect(page.locator(ready).first()).toBeVisible();
    await scanDark(page, `instruments-${part.toLowerCase()}`);
  });
}

test('dark: templates', async ({ page }) => {
  await page.goto('/#/new');
  await page.getByTestId('tab-templates').click();
  await expect(page.getByTestId('template-row').first()).toBeVisible();
  await scanDark(page, 'templates');
});

for (const [section, link, ready] of [
  ['data export', 'Data export', '.admin-title'],
  ['field aliases', 'Field aliases', '.admin-body .section-title'],
  ['appearance', 'Appearance', '.admin-body h2'],
] as const) {
  test(`dark: admin: ${section}`, async ({ page }) => {
    await page.goto('/#/new');
    await page.getByTestId('tab-admin').click();
    await page.click(`.admin-nav-item:has-text("${link}")`);
    await expect(page.locator(ready).first()).toBeVisible();
    await scanDark(page, `admin-${section.replace(' ', '-')}`);
  });
}
