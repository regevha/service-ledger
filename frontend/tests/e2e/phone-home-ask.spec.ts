import { test, expect } from './coverage';
import { seedReport } from './helpers/api';
import { askInSheet, openAskSheet } from './helpers/askSheet';

// Phone coverage for Home and the plain-words ask box (docs: claude/plan-phone-e2e-tests.md, items 1 to 3).
// Every action here is a tap, not a click, so a control that only works with a mouse fails these tests.

async function noSideScroll(page: import('@playwright/test').Page) {
  const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(scroll, 'the page scrolls sideways').toBeLessThanOrEqual(client + 1);
}

async function insideScreen(page: import('@playwright/test').Page, locator: import('@playwright/test').Locator, what: string) {
  const box = (await locator.boundingBox())!;
  const width = page.viewportSize()!.width;
  expect(box.x, `${what} starts left of the screen`).toBeGreaterThanOrEqual(-0.5);
  expect(box.x + box.width, `${what} ends right of the screen`).toBeLessThanOrEqual(width + 0.5);
}

test.describe('Home and the ask box on a phone', { tag: '@phone' }, () => {
  test('Home: the tiles stack inside the screen, nothing scrolls sideways, and the buttons are thumb-sized', async ({ page, request }) => {
    await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: `ph-home-${Date.now()}` });
    await page.goto('/');
    await expect(page.getByTestId('home-screen')).toBeVisible();
    await expect(page.getByTestId('home-tile-review').locator('.stat-value')).not.toHaveText('–');
    for (const id of ['home-tile-review', 'home-tile-overdue', 'home-tile-finalized']) {
      await insideScreen(page, page.getByTestId(id), id);
    }
    await noSideScroll(page);
    // The Ask box is not on the page on a phone: the magnifier in the top bar opens it.
    await expect(page.getByTestId('ask-input')).toHaveCount(0);
    for (const control of [page.getByTestId('ask-open'), page.getByTestId('home-choose-files'), page.getByTestId('home-new-report')]) {
      const box = (await control.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(43.5);
    }
  });

  test('Home: tapping Review opens that report, and Add one by hand opens New report', async ({ page, request }) => {
    await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: `ph-tap-${Date.now()}` });
    await page.goto('/#/home');
    await page.getByTestId('home-waiting-row').first().getByRole('button', { name: 'Review' }).tap();
    await expect(page).toHaveURL(/#\/reports\//);

    await page.getByTestId('masthead-home').tap(); // the name in the top bar leads back to Home
    await expect(page.getByTestId('home-screen')).toBeVisible();
    await page.getByTestId('home-new-report').tap();
    await expect(page.getByTestId('tab-new')).toHaveAttribute('aria-current', 'page');
  });

  test('Home: a question typed in and sent with a tap opens Reports with those filters', async ({ page, request }) => {
    const tech = 'Phone Askerson';
    await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: tech });
    await seedReport(request, { model: 'LSRFortessa', reportType: 'preventive_maintenance', technician: tech });
    await page.goto('/#/home');
    await askInSheet(page, `repairs by ${tech.toLowerCase()}`);
    await expect(page).toHaveURL(/#\/reports/);
    // The filter line says what the question became; the repair-only filter leaves reports of that one manager.
    // (The Ask box shows the kept question's chips too, so the line is picked out by its own class.)
    await expect(page.locator('.filters-summary-text')).toContainText('Lab manager: phone askerson');
    await expect(page.getByText('Malfunction / repair').first()).toBeVisible();
    await expect(page.getByTestId('report-group').first()).toBeVisible();
    await noSideScroll(page);
  });

  test('Reports: on a phone the conditions are on the line at the top, inside the screen, and a tapped example fills them', async ({ page }) => {
    await page.goto('/#/reports');
    const sheet = await openAskSheet(page);
    await sheet.getByRole('button', { name: 'maintenance in 2025 at Bar-Ilan University' }).tap();
    await expect(page.getByTestId('ask-sheet')).toHaveCount(0); // a question that set something closes the sheet
    // The Ask box does not repeat the chips on a phone; the one line at the top is where they are.
    const line = page.getByTestId('active-search');
    await expect(line).toBeVisible();
    await expect(page.getByTestId('ask-chip').first()).toBeHidden();
    const chips = page.getByTestId('active-search-chip');
    await expect(chips.first()).toBeVisible();
    expect(await chips.count()).toBeGreaterThanOrEqual(2);
    await insideScreen(page, line, 'the search line');
    await insideScreen(page, page.getByTestId('active-search-clear'), 'Clear search');
    await noSideScroll(page);
  });

  test('Reports: when the question cannot be read, a warning shows inside the screen and the box stays usable', async ({ page }) => {
    await page.route('**/reports/parse-search', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"The helper is not available."}' }));
    await page.goto('/#/reports');
    const sheet = await openAskSheet(page);
    await sheet.getByTestId('ask-input').fill('anything at all');
    await sheet.getByTestId('ask-submit').tap();
    const warning = page.getByRole('alert').filter({ hasText: 'not available' });
    await expect(warning).toBeVisible();
    await insideScreen(page, warning, 'the warning');
    await expect(page.getByTestId('ask-submit')).toBeEnabled();
    await noSideScroll(page);
  });

  test('the tab bar and the More screen work by tap', async ({ page }) => {
    await page.goto('/#/new');
    await page.getByTestId('tab-reports').tap();
    await expect(page.getByTestId('tab-reports')).toHaveAttribute('aria-current', 'page');
    await page.getByTestId('tab-more').tap();
    await expect(page.getByTestId('more-screen')).toBeVisible();
    await page.getByTestId('more-screen').getByRole('button', { name: /Home/ }).first().tap();
    await expect(page.getByTestId('home-screen')).toBeVisible();
  });
});
