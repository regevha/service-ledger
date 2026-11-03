import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect } from './coverage';
import { seedReport } from './helpers/api';
import { openAnalytics, openReports, openReviewFromList } from './helpers/ui';

// Automated accessibility scans (axe-core, WCAG 2 A and AA rules) of the screens people use: intake,
// reports, review and analytics, then the Instruments tab (instruments, models, makers, places),
// Templates and the three Admin sections. Known problems are listed in KNOWN with the screens they were seen on; a new problem on
// any screen fails the test, and a listed one that no longer shows up fails too, so the list can
// only shrink. Automated rules find roughly a third of real problems: this is a floor, not an audit.

type Known = { rule: string; screens: string[]; why: string };
const KNOWN: Known[] = [
];

async function scan(page: Page, screen: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const known = new Set(KNOWN.filter((k) => k.screens.includes(screen)).map((k) => k.rule));
  const found = new Set(results.violations.map((v) => v.id));
  const unexpected = results.violations
    .filter((v) => !known.has(v.id))
    .map((v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('\n    ')}`);
  expect(unexpected, `new accessibility problems on ${screen}`).toEqual([]);
  const gone = [...known].filter((rule) => !found.has(rule));
  expect(gone, `${screen}: these are no longer a problem, remove them from KNOWN`).toEqual([]);
}

test('intake screen', async ({ page }) => {
  await page.goto('/');
  await page.click('.view-tab:has-text("New report")');
  await expect(page.getByTestId('intake-dropzone')).toBeVisible();
  await scan(page, 'intake');
});

test('reports list', async ({ page, request }) => {
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: `E2E-A11y-${Date.now()}`, finalize: true });
  await openReports(page);
  await expect(page.locator('.report-table')).toBeVisible();
  await scan(page, 'reports');
});

test('review screen', async ({ page, request }) => {
  const marker = `E2E-A11y-${Date.now()}`;
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: marker, finalize: true });
  await openReviewFromList(page, marker);
  await scan(page, 'review');
});

test('analytics', async ({ page, request }) => {
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: `E2E-A11y-${Date.now()}`, finalize: true });
  await openAnalytics(page);
  await scan(page, 'analytics');
});

// The Instruments tab has four parts behind one switch; each is its own screen to scan.
for (const [part, ready] of [
  ['Instruments', '.instrument-row.template-row-body'],
  ['Models', '#models-section'],
  ['Makers', '#makers-section'],
  ['Places', '#places-section'],
] as const) {
  test(`instruments tab: ${part.toLowerCase()}`, async ({ page, request }) => {
    // Something to list on the screens that list reports against units.
    await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: `E2E-A11y-${Date.now()}`, finalize: true });
    await page.goto('/');
    await page.click('.view-tab:has-text("Instruments")');
    if (part !== 'Instruments') await page.click(`.sub-switch button:has-text("${part}")`);
    await expect(page.locator(ready).first()).toBeVisible();
    await scan(page, `instruments-${part.toLowerCase()}`);
  });
}

test('templates', async ({ page }) => {
  await page.goto('/');
  await page.click('.view-tab:has-text("Templates")');
  await expect(page.locator('.template-row-body').first()).toBeVisible();
  await scan(page, 'templates');
});

for (const [section, link, ready] of [
  ['data export', 'Data export', '.admin-title'],
  ['field aliases', 'Field aliases', '.admin-body .section-title'],
  ['appearance', 'Appearance', '.admin-body h2'],
] as const) {
  test(`admin: ${section}`, async ({ page }) => {
    await page.goto('/');
    await page.click('.view-tab:has-text("Admin")');
    await page.click(`.admin-nav-item:has-text("${link}")`);
    await expect(page.locator(ready).first()).toBeVisible();
    await scan(page, `admin-${section.replace(' ', '-')}`);
  });
}
