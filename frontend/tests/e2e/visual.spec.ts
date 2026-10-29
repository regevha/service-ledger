import { test, expect } from './coverage';
import { createNumericModel } from './numeric-fixture';
import { seedReport } from './helpers/api';
import { openReviewFromList } from './helpers/ui';

// Screenshot comparisons of two places where a wrong pixel is a wrong answer: the trend chart and
// the review screen's field list. Chromium only, tagged @visual, run by the "visual" project and
// not by the default one. The baseline images are drawn on the Linux CI runner (fonts and
// anti-aliasing differ between machines, so images made anywhere else never match): run the
// "Update visual baselines" workflow in the Actions tab, review the images it commits, and merge.

const SHOT = { maxDiffPixelRatio: 0.01, animations: 'disabled' as const };

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
  await page.click('.view-tab:has-text("Reports")');
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

  await expect(page.locator('.field-list')).toHaveScreenshot('review-fields.png', SHOT);
});
