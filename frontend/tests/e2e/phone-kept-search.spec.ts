import { test, expect } from './coverage';
import { seedReport } from './helpers/api';

// The kept search on a phone (src/keptSearch.ts): asked with a tap, it survives a reload and a trip through the tabs.

test.describe('The kept search on a phone', { tag: '@phone' }, () => {
  test('asked on Home with a tap, it is still in force after a reload and after the other tabs', async ({ page, request }) => {
    const tech = 'Phone Keptson';
    await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: tech });
    await seedReport(request, { model: 'LSRFortessa', reportType: 'preventive_maintenance', technician: tech });

    await page.goto('/#/home');
    const ask = page.getByTestId('home-ask');
    await ask.getByTestId('ask-input').fill(`repairs by ${tech.toLowerCase()}`);
    await ask.getByTestId('ask-submit').tap();
    await expect(page).toHaveURL(/#\/reports/);
    await expect(page.locator('.filters-summary-text')).toContainText('Lab manager: phone keptson');

    // Another tab and back.
    await page.getByTestId('tab-analytics').tap();
    await expect(page.locator('.filters-summary-text')).toContainText('Lab manager: phone keptson');
    await page.getByTestId('tab-reports').tap();
    await expect(page.locator('.filters-summary-text')).toContainText('Lab manager: phone keptson');

    // A reload, then the question is still in the box on Home.
    await page.reload();
    await expect(page.locator('.filters-summary-text')).toContainText('Lab manager: phone keptson');
    await page.goto('/#/home');
    await expect(page.getByTestId('home-ask').getByTestId('ask-input')).toHaveValue(`repairs by ${tech.toLowerCase()}`);

    // Nothing sideways on the small screen.
    const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    expect(scroll, 'the page scrolls sideways').toBeLessThanOrEqual(client + 1);
  });

  test('on a phone a deleted instrument drops the search, with the notice inside the screen', async ({ page }) => {
    const missing = '00000000-0000-4000-8000-000000000000';
    await page.goto('/#/home');
    await page.evaluate(
      (value) => localStorage.setItem('sl.ask.kept', value),
      JSON.stringify({ text: 'old question', filters: { instrument_id: missing }, understood: [] })
    );
    await page.reload();
    const notice = page.getByTestId('kept-search-notice');
    await expect(notice).toContainText('the instrument it named no longer exists');
    const box = (await notice.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(-0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 0.5);
    await notice.getByRole('button', { name: 'Dismiss' }).tap();
    await expect(notice).toHaveCount(0);
  });
});
