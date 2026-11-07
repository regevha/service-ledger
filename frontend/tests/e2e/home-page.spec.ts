import { test, expect } from './coverage';
import { seedReport } from './helpers/api';

test('Home shows waiting reports and opens the new-report screen', async ({ page, request }) => {
  const tech = `home-${Date.now()}`;
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: tech });

  await page.goto('/#/home');
  await expect(page.getByTestId('home-screen')).toBeVisible();
  await expect(page.getByTestId('tab-home')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('home-tile-review')).toBeVisible();
  await expect(page.getByTestId('home-waiting-row').first()).toBeVisible();
  await expect(page.getByTestId('home-tile-review').locator('.stat-value')).not.toHaveText('–');

  await page.getByTestId('home-waiting-row').first().getByRole('button', { name: 'Review' }).click();
  await expect(page).toHaveURL(/#\/reports\//);

  await page.goto('/#/home');
  await page.getByTestId('home-new-report').click();
  await expect(page.getByTestId('tab-new')).toHaveAttribute('aria-current', 'page');
});

test('Home is reachable from More on a phone-width screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/#/new');
  await page.getByTestId('tab-more').click();
  await page.getByRole('button', { name: /Home/ }).first().click();
  await expect(page.getByTestId('home-screen')).toBeVisible();
});

test('Home figures: waiting, finalized and the kept-as-read note', async ({ page, request }) => {
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: `fig-${Date.now()}` });
  await page.goto('/#/home');
  await expect(page.getByTestId('home-tile-review').locator('.stat-value')).not.toHaveText('–');
  await expect(page.getByTestId('home-tile-review')).toContainText('Oldest has waited');
  await expect(page.getByTestId('home-tile-finalized')).toContainText(/Last month: \d+|Finalize your first report/);
  // Too few finalized fields for a percentage: it says how many there are instead of showing a number.
  await expect(page.getByTestId('home-tile-accuracy')).toContainText(/Shown after 20 fields|last 30 days/);
});

test('a plain-words request on Home opens Reports with those filters', async ({ page, request }) => {
  const tech = 'Home Askerson';
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: tech });
  await seedReport(request, { model: 'LSRFortessa', reportType: 'preventive_maintenance', technician: tech });

  await page.goto('/#/home');
  await page.getByTestId('home-ask').getByTestId('ask-input').fill('repairs by home askerson');
  await page.getByTestId('home-ask').getByTestId('ask-submit').click();

  await expect(page).toHaveURL(/#\/reports/);
  await expect(page.getByTestId('tab-reports')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('report-row')).toHaveCount(1);
  await expect(page.locator('input[value="Home Askerson" i]').first()).toBeVisible();

  // The request is used once: opening Reports again later starts without it.
  await page.getByTestId('tab-home').click();
  await page.getByTestId('tab-reports').click();
  await expect(page.locator('input[value="Home Askerson" i]')).toHaveCount(0);
});

test('files dropped anywhere on Home open the several-files screen with them', async ({ page }) => {
  await page.goto('/#/home');
  const dt = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    d.items.add(new File(['%PDF-1.4 a'], 'dropped-one.pdf', { type: 'application/pdf' }));
    d.items.add(new File(['%PDF-1.4 b'], 'dropped-two.pdf', { type: 'application/pdf' }));
    return d;
  });
  await page.dispatchEvent('body', 'dragenter', { dataTransfer: dt });
  await expect(page.getByTestId('home-drop')).toHaveClass(/dragging/);
  await page.dispatchEvent('body', 'drop', { dataTransfer: dt });

  await expect(page).toHaveURL(/#\/batch/);
  await expect(page.getByText('dropped-one.pdf')).toBeVisible();
  await expect(page.getByText('dropped-two.pdf')).toBeVisible();
});

test('files chosen with the Choose files button go the same way', async ({ page }) => {
  await page.goto('/#/home');
  await page.getByTestId('home-file-input').setInputFiles({ name: 'picked.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 c') });
  await expect(page).toHaveURL(/#\/batch/);
  await expect(page.getByText('picked.pdf')).toBeVisible();
});

test('the app opens on Home, and the name in the top bar leads back to it', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('home-screen')).toBeVisible();
  await page.getByTestId('tab-reports').click();
  await page.getByTestId('masthead-home').click();
  await expect(page.getByTestId('home-screen')).toBeVisible();
});
