import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './coverage';
import { createNumericModel } from './numeric-fixture';
import { API_BASE, okJson, seedReport } from './helpers/api';
import { openReviewFromList } from './helpers/ui';

// Screenshot comparisons of two places where a wrong pixel is a wrong answer: the trend chart and
// the review screen's field list. Chromium only, tagged @visual, run by the "visual" project and
// not by the default one. The baseline images are drawn on the Linux CI runner (fonts and
// anti-aliasing differ between machines, so images made anywhere else never match): run the
// "Update visual baselines" workflow in the Actions tab, review the images it commits, and merge.

const SHOT = { maxDiffPixelRatio: 0.01, animations: 'disabled' as const };

// The same screens in the dark theme and at phone width, and the Reports list. Nothing in a picture may
// change from one run to the next: dates are fixed, and the list is of one instrument that keeps the
// same name (so it is looked up, and made only the first time) with fixed technician names.
async function darkTheme(page: Page) {
  await page.addInitScript(() => localStorage.setItem('sl.theme', 'dark'));
}

async function trendSetup(request: APIRequestContext, prefix: string) {
  const model = await createNumericModel(request, prefix);
  const dates = ['2026-01-10', '2026-03-10', '2026-05-10', '2026-07-10'];
  let instrumentId = '';
  for (let i = 0; i < dates.length; i++) {
    const seeded = await seedReport(request, {
      model,
      reportType: 'installation_upgrade',
      reportDate: dates[i],
      fields: {
        baseline_cv_percent: { detector_1: 2.1 + i * 0.2, detector_2: 3.0 + i * 0.2, detector_3: 1.4 + i * 0.1 },
        fluidics_pressure_psi: 4.9 + i * 0.1,
      },
      finalize: true,
    });
    instrumentId = seeded.instrumentId;
  }
  return instrumentId;
}

async function openTrend(page: Page, instrumentId: string) {
  await page.goto('/');
  await page.click('.view-tab:has-text("Reports")');
  await page.getByLabel('Instrument', { exact: true }).selectOption(instrumentId);
  await page.click('button:has-text("View instrument details")');
  await expect(page.locator('.trend-chart-wrap svg')).toBeVisible();
  await page.mouse.move(0, 0); // no hover tooltip in the picture
}

async function reviewSetup(request: APIRequestContext, prefix: string) {
  const model = await createNumericModel(request, prefix);
  const marker = `E2E-Visual-${Date.now()}`;
  await seedReport(request, {
    model,
    reportType: 'installation_upgrade',
    technician: marker,
    reportDate: '2026-05-10',
    fields: {
      cst_beads_lot: 'LOT-12345',
      baseline_cv_percent: { detector_1: 2.1, detector_2: 3.0, detector_3: 1.4 },
      pmt_voltages: { detector_1: 450, detector_2: 470, detector_3: 480 },
      fluidics_pressure_psi: 5.0,
    },
    finalize: true,
  });
  return marker;
}

/** The one instrument the list picture is of: found by its fixed model name, made only the first time. */
async function fixedListInstrument(request: APIRequestContext): Promise<string> {
  const model = 'E2E-Visual-Fixed';
  const all = await okJson<{ id: string; model: string }[]>(await request.get(`${API_BASE}/instruments`), 'list instruments');
  const found = all.find((i) => i.model === model);
  if (found) return found.id;
  const made = await okJson<{ id: string }>(
    await request.post(`${API_BASE}/instruments`, { data: { name: model, model, manufacturer: 'E2E Maker', serial_number: 'SN-E2E-VISUAL-FIXED' } }),
    'create fixed instrument'
  );
  return made.id;
}

test('the trend chart draws the same', { tag: '@visual' }, async ({ page, request }) => {
  const model = await createNumericModel(request, 'E2E-Visual-Trend');
  const dates = ['2026-01-10', '2026-03-10', '2026-05-10', '2026-07-10'];
  let instrumentId = '';
  for (let i = 0; i < dates.length; i++) {
    const seeded = await seedReport(request, {
      model,
      reportType: 'installation_upgrade',
      reportDate: dates[i],
      fields: {
        baseline_cv_percent: { detector_1: 2.1 + i * 0.2, detector_2: 3.0 + i * 0.2, detector_3: 1.4 + i * 0.1 },
        fluidics_pressure_psi: 4.9 + i * 0.1,
      },
      finalize: true,
    });
    instrumentId = seeded.instrumentId;
  }

  await page.goto('/');
  await page.getByTestId('tab-reports').click();
  await page.getByLabel('Instrument', { exact: true }).selectOption(instrumentId);
  await page.click('button:has-text("View instrument details")');
  await expect(page.locator('.trend-chart-wrap svg')).toBeVisible();
  await page.mouse.move(0, 0); // no hover tooltip in the picture

  await expect(page.locator('.trend-chart-wrap')).toHaveScreenshot('trend-chart.png', SHOT);
});

test('the review screen lays out its fields the same', { tag: '@visual' }, async ({ page, request }) => {
  const model = await createNumericModel(request, 'E2E-Visual-Review');
  const marker = `E2E-Visual-${Date.now()}`;
  await seedReport(request, {
    model,
    reportType: 'installation_upgrade',
    technician: marker,
    reportDate: '2026-05-10',
    fields: {
      cst_beads_lot: 'LOT-12345',
      baseline_cv_percent: { detector_1: 2.1, detector_2: 3.0, detector_3: 1.4 },
      pmt_voltages: { detector_1: 450, detector_2: 470, detector_3: 480 },
      fluidics_pressure_psi: 5.0,
    },
    finalize: true,
  });
  await openReviewFromList(page, marker);

  await expect(page.getByTestId('field-list')).toHaveScreenshot('review-fields.png', SHOT);
});

test('the trend chart draws the same in the dark theme', { tag: '@visual' }, async ({ page, request }) => {
  const instrumentId = await trendSetup(request, 'E2E-Visual-TrendDark');
  await darkTheme(page);
  await openTrend(page, instrumentId);
  await expect(page.locator('.trend-chart-wrap')).toHaveScreenshot('trend-chart-dark.png', SHOT);
});

test('the review screen lays out its fields the same in the dark theme', { tag: '@visual' }, async ({ page, request }) => {
  const marker = await reviewSetup(request, 'E2E-Visual-ReviewDark');
  await darkTheme(page);
  await openReviewFromList(page, marker);
  await expect(page.locator('.field-list')).toHaveScreenshot('review-fields-dark.png', SHOT);
});

test('the review screen lays out its fields the same on a phone', { tag: '@visual' }, async ({ page, request }) => {
  const marker = await reviewSetup(request, 'E2E-Visual-ReviewPhone');
  await page.setViewportSize({ width: 390, height: 844 });
  await openReviewFromList(page, marker);
  await expect(page.locator('.field-list')).toHaveScreenshot('review-fields-phone.png', SHOT);
});

for (const theme of ['light', 'dark'] as const) {
  test(`the Reports list draws the same (${theme})`, { tag: '@visual' }, async ({ page, request }) => {
    const instrumentId = await fixedListInstrument(request);
    const templates = await okJson<{ id: string }[]>(
      await request.get(`${API_BASE}/report-templates`, { params: { report_type: 'repair', model: 'E2E-Visual-Fixed' } }),
      'list templates'
    );
    const rows = [
      { technician: 'Visual Tester A', reportDate: '2026-02-03' },
      { technician: 'Visual Tester B', reportDate: '2026-04-17' },
      { technician: 'Visual Tester C', reportDate: '2026-06-29' },
    ];
    for (const row of rows) {
      await seedReport(request, { model: 'E2E-Visual-Fixed', reportType: 'repair', instrumentId, templateId: templates[0]?.id, ...row, finalize: true });
    }
    if (theme === 'dark') await darkTheme(page);
    await page.goto('/');
    await page.click('.view-tab:has-text("Reports")');
    await page.getByLabel('Instrument', { exact: true }).selectOption(instrumentId);
    await expect(page.locator('.report-row-body')).toHaveCount(rows.length);
    await page.mouse.move(0, 0);
    await expect(page.locator('.report-table, .report-groups').first()).toHaveScreenshot(`reports-list-${theme}.png`, SHOT);
  });
}
