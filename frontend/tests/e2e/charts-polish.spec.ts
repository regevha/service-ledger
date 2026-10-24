import { type APIRequestContext, type Page } from '@playwright/test';
import { test, expect } from './coverage';
import { uniquePdf } from './unique-upload';
import { BACKEND_PORT } from '../../playwright.config';

// UI review items #26-#28: charts drawn at the size they are shown (so their text matches the page)
// with years on the date axis, Analytics bars that line up, and the active tab joined to its card.

const API_BASE = `http://localhost:${BACKEND_PORT}`;

async function seedCalibrationReport(
  request: APIRequestContext,
  opts: { instrumentId: string; model: string; extractedFields: Record<string, unknown>; reportDate: string }
): Promise<void> {
  const report = await (await request.post(`${API_BASE}/reports`, { data: {} })).json();
  const templates = await (
    await request.get(`${API_BASE}/report-templates`, { params: { report_type: 'calibration', model: opts.model } })
  ).json();
  await request.patch(`${API_BASE}/reports/${report.id}/template`, {
    data: { instrument_id: opts.instrumentId, template_id: templates[0].id },
  });
  const attachment = await (
    await request.post(`${API_BASE}/reports/${report.id}/attachments`, {
      multipart: { file: { name: 'seed.pdf', mimeType: 'application/pdf', buffer: uniquePdf('%PDF-1.4 seed') } },
    })
  ).json();
  const job = await (await request.post(`${API_BASE}/attachments/${attachment.id}/extract`)).json();
  for (let waited = 0; waited < 30_000; waited += 200) {
    const polled = await (await request.get(`${API_BASE}/extraction-jobs/${job.id}`)).json();
    if (polled.status === 'succeeded' || polled.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await request.patch(`${API_BASE}/reports/${report.id}/fields`, {
    data: { extracted_fields: opts.extractedFields, report_date: opts.reportDate },
  });
  await request.post(`${API_BASE}/reports/${report.id}/finalize`);
}

async function instrumentWithTrend(request: APIRequestContext, marker: string, dates: string[]): Promise<string> {
  const instrument = await (
    await request.post(`${API_BASE}/instruments`, {
      data: { name: marker, model: marker, manufacturer: 'E2E Maker', serial_number: `SN-${marker}` },
    })
  ).json();
  for (let i = 0; i < dates.length; i++) {
    await seedCalibrationReport(request, {
      instrumentId: instrument.id,
      model: marker,
      reportDate: dates[i],
      extractedFields: { fluidics_pressure_psi: 4.8 + i * 0.05 },
    });
  }
  return instrument.id as string;
}

// Six reports over two years: enough that a narrow chart has to thin its date labels, few enough to seed quickly.
const DATES = ['2025-10-15', '2025-12-15', '2026-02-15', '2026-04-15', '2026-06-15', '2026-07-15'];

async function openTrend(page: Page, instrumentId: string) {
  await page.goto(`/#/reports/instrument/${instrumentId}`);
  await expect(page.locator('.trend-section')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.trend-chart-wrap svg')).toBeVisible();
}

test.describe('trend chart', () => {
  let instrumentId: string;
  test.beforeAll(async ({ request }) => {
    // Seeding reads each report through the extraction worker, which is slow on a busy CI machine.
    test.setTimeout(240_000);
    instrumentId = await instrumentWithTrend(request, `E2E-ChartScale-${Date.now()}`, DATES);
  });

  for (const width of [1400, 700]) {
    test(`at ${width}px wide the chart is drawn 1:1, not stretched`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openTrend(page, instrumentId);
      const scale = await page.locator('.trend-chart-wrap svg').evaluate((svg: SVGSVGElement) => svg.getBoundingClientRect().width / svg.viewBox.baseVal.width);
      expect(scale).toBeGreaterThan(0.97);
      expect(scale).toBeLessThan(1.03);
    });
  }

  test('on a phone the chart still fits the screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openTrend(page, instrumentId);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const box = await page.locator('.trend-chart-wrap svg').boundingBox();
    expect(box!.width).toBeLessThanOrEqual(390);
  });

  test('date labels carry the year and never overlap, however narrow the chart', async ({ page }) => {
    for (const width of [1400, 500]) {
      await page.setViewportSize({ width, height: 900 });
      await openTrend(page, instrumentId);
      const labels = page.locator('.trend-chart-wrap svg text.trend-tick-label').filter({ hasText: /\d{4}/ });
      const count = await labels.count();
      expect(count).toBeGreaterThan(1);
      const texts = await labels.allTextContents();
      for (const t of texts) expect(t).toMatch(/\b20(25|26)\b/);
      const boxes = [];
      for (let i = 0; i < count; i++) boxes.push((await labels.nth(i).boundingBox())!);
      boxes.sort((a, b) => a.x - b.x);
      for (let i = 1; i < boxes.length; i++) expect(boxes[i].x).toBeGreaterThanOrEqual(boxes[i - 1].x + boxes[i - 1].width);
      if (width === 500) expect(count).toBeLessThan(DATES.length); // thinned
    }
  });
});

test.describe('analytics bars', () => {
  async function mockFleet(page: Page, body: unknown) {
    await page.route('**/analytics/fleet*', (route) => route.fulfill({ json: body }));
  }
  const rollup = (n: number) => ({
    instrument_id: `00000000-0000-0000-0000-00000000000${n}`,
    name: `Unit ${n}`,
    model: `Model ${n}`,
    serial_number: `SN${n}`,
    report_count: n,
    total_labor_hours: n * 3,
  });
  const base = {
    finalized_report_count: 4,
    total_labor_hours: 18,
    labor_hours_by_instrument: [rollup(1), rollup(2), rollup(3)],
    labor_hours_by_fault_category: { fluidics: 5, optics: 2 },
    pass_fail_by_report_type: {
      repair: { pass_count: 3, fail_count: 1, other_count: 0, total: 4 },
      preventive_maintenance: { pass_count: 12, fail_count: 0, other_count: 1, total: 13 },
    },
  };

  test('every bar starts and ends in the same place, whatever its label or value says', async ({ page }) => {
    await mockFleet(page, {
      ...base,
      parts_replaced: [
        { part_name: 'Sheath filter', part_number: 'SF-1', times_replaced: 4, total_qty: 12 },
        { part_name: 'O', part_number: null, times_replaced: 1, total_qty: 3 },
        { part_name: 'A much longer part name than the others in the list', part_number: 'LONG-1', times_replaced: 2, total_qty: 5 },
      ],
    });
    await page.setViewportSize({ width: 1300, height: 900 });
    await page.goto('/#/analytics');
    const tracks = page.locator('.bar-chart').first().locator('.bar-track');
    await expect(tracks).toHaveCount(3);
    const boxes = [];
    for (let i = 0; i < 3; i++) boxes.push((await tracks.nth(i).boundingBox())!);
    for (const b of boxes) {
      expect(Math.round(b.x)).toBe(Math.round(boxes[0].x));
      expect(Math.round(b.width)).toBe(Math.round(boxes[0].width));
    }
    // The pass/fail bars share the same columns too.
    const stack = page.locator('.stack-track');
    await expect(stack).toHaveCount(2);
    const [s0, s1] = [await stack.nth(0).boundingBox(), await stack.nth(1).boundingBox()];
    expect(Math.round(s0!.x)).toBe(Math.round(s1!.x));
    expect(Math.round(s0!.width)).toBe(Math.round(s1!.width));
  });

  test('when every part has the same count the bars give way to a plain list', async ({ page }) => {
    await mockFleet(page, {
      ...base,
      parts_replaced: [
        { part_name: 'Sheath filter', part_number: 'SF-1', times_replaced: 1, total_qty: 1 },
        { part_name: 'O-ring', part_number: 'OR-9', times_replaced: 1, total_qty: 1 },
        { part_name: 'Lamp', part_number: null, times_replaced: 1, total_qty: 1 },
      ],
    });
    await page.goto('/#/analytics');
    const list = page.locator('.count-list').first();
    await expect(list).toBeVisible();
    await expect(list.locator('li')).toHaveCount(3);
    await expect(list).toContainText('Sheath filter');
    await expect(list).toContainText('1 unit · 1 report');
    // The parts section has no bars; other charts still do.
    await expect(page.locator('.bar-chart .bar-track')).toHaveCount(5); // 3 instruments + 2 fault categories
  });

  test('a single part still gets a bar', async ({ page }) => {
    await mockFleet(page, {
      ...base,
      parts_replaced: [{ part_name: 'Sheath filter', part_number: 'SF-1', times_replaced: 1, total_qty: 1 }],
    });
    await page.goto('/#/analytics');
    await expect(page.locator('.count-list')).toHaveCount(0);
    await expect(page.locator('.bar-row', { hasText: 'Sheath filter' })).toBeVisible();
  });
});

test.describe('active tab joins its card', () => {
  for (const width of [1300, 390]) {
    test(`at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/#/templates');
      await expect(page.locator('.view-tab.active')).toHaveText('Templates');
      const [tab, card] = await Promise.all([page.locator('.view-tab.active').boundingBox(), page.locator('.app-shell').boundingBox()]);
      // The tab's bottom edge lands on the card's top edge: no gap, no float.
      expect(Math.abs(tab!.y + tab!.height - card!.y)).toBeLessThanOrEqual(1);
      // …and the pixel row under the tab is the card's colour, not its border line.
      const [tabBg, tabBorder] = await page.locator('.view-tab.active').evaluate((el) => {
        const cs = getComputedStyle(el);
        return [cs.backgroundColor, cs.borderBottomColor];
      });
      expect(tabBorder).toBe(tabBg);
    });
  }
});
