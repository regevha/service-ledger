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
  await page.goto('/#/new');
  await page.getByTestId('tab-new').click();
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
  ['Instruments', '[data-testid="instrument-row"]'],
  ['Models', '#models-section'],
  ['Makers', '#makers-section'],
  ['Places', '#places-section'],
] as const) {
  test(`instruments tab: ${part.toLowerCase()}`, async ({ page, request }) => {
    // Something to list on the screens that list reports against units.
    await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: `E2E-A11y-${Date.now()}`, finalize: true });
    await page.goto('/#/new');
    await page.getByTestId('tab-instruments').click();
    if (part !== 'Instruments') await page.click(`.sub-switch button:has-text("${part}")`);
    await expect(page.locator(ready).first()).toBeVisible();
    await scan(page, `instruments-${part.toLowerCase()}`);
  });
}

test('templates', async ({ page }) => {
  await page.goto('/#/new');
  await page.getByTestId('tab-templates').click();
  await expect(page.getByTestId('template-row').first()).toBeVisible();
  await scan(page, 'templates');
});

for (const [section, link, ready] of [
  ['data export', 'Data export', '.admin-title'],
  ['field aliases', 'Field aliases', '.admin-body .section-title'],
  ['appearance', 'Appearance', '.admin-body h2'],
] as const) {
  test(`admin: ${section}`, async ({ page }) => {
    await page.goto('/#/new');
    await page.getByTestId('tab-admin').click();
    await page.click(`.admin-nav-item:has-text("${link}")`);
    await expect(page.locator(ready).first()).toBeVisible();
    await scan(page, `admin-${section.replace(' ', '-')}`);
  });
}

// A table that scrolls sideways has to be reachable by keyboard (axe: scrollable-region-focusable). It only
// scrolls when it is wider than its box, which used to depend on how much data other specs had left behind
// (so only the shuffled nightly run saw it). This scan makes the units table overflow by narrowing the window
// after the page has loaded (below about 600px the page changes to its phone layout, so the width is 900, where it overflows by a wide margin),
// and checks that it really does overflow, so the scan cannot pass for want of anything to find.
test('analytics with a table that scrolls sideways', async ({ page, request }) => {
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: `E2E-A11y-${Date.now()}`, finalize: true });
  await openAnalytics(page);
  const scroller = page.locator('.trend-table-wrap').first();
  await expect(scroller).toBeVisible();
  await page.setViewportSize({ width: 900, height: 900 });
  await expect.poll(() => scroller.evaluate((el) => el.scrollWidth > el.clientWidth), { message: 'the table is wider than its box' }).toBe(true);
  await scan(page, 'analytics-narrow');
});

// Borders that mark out a control need 3:1 against what is next to them (WCAG 1.4.11). axe does not check
// non-text contrast, so this does: light mode, a plain .btn (added to the page for the check, because the
// intake screen's only desktop button is a filled primary one) and the name field, against --surface. SL-57 raised --input-border to pass; this keeps a later token edit from undoing it.
test('light-mode control borders reach 3:1 against the surface', async ({ page, context }) => {
  await context.addInitScript(() => {
    try {
      localStorage.setItem('sl.theme', 'light');
    } catch {
      /* the theme check below then fails instead of measuring the wrong theme */
    }
  });
  await page.goto('/#/new');
  await page.getByTestId('tab-new').click();
  await expect(page.getByTestId('intake-dropzone')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.dataset.theme), 'light theme is in force').toBe('light');
  const ratios = await page.evaluate(() => {
    const rgb = (css: string) => {
      const probe = document.createElement('span');
      probe.style.color = css;
      document.body.appendChild(probe);
      const m = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g)!.map(Number);
      probe.remove();
      return m.slice(0, 3);
    };
    const lum = ([r, g, b]: number[]) => {
      const c = [r, g, b].map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (a: number[], b: number[]) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const surface = rgb(getComputedStyle(document.documentElement).getPropertyValue('--surface').trim());
    const out: Record<string, number> = {};
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Probe';
    document.body.appendChild(btn);
    for (const sel of ['.btn', '.text-input']) {
      const el = sel === '.btn' ? btn : document.querySelector(sel);
      out[sel] = el ? Math.round(ratio(rgb(getComputedStyle(el).borderTopColor), surface) * 100) / 100 : 0;
    }
    btn.remove();
    return out;
  });
  for (const [sel, r] of Object.entries(ratios)) expect(r, `${sel} border against --surface`).toBeGreaterThanOrEqual(3);
});
