import { expect, test } from '@playwright/test';
import { API_BASE, seedReport } from './helpers/api';

// A condition on a number in the report ("labor hours above 5"): the answer to a plain-words question can carry
// one, the list narrows to the reports whose number passes, the condition shows as a chip, and taking it out
// brings the other reports back without touching the rest of the search.

function answerWith(tech: string) {
  return {
    filters: { technician: tech, number_field: 'labor_hours', number_op: 'gt', number_value: '5' },
    understood: [
      { key: 'technician', label: `Lab manager: ${tech}` },
      { key: 'field', label: 'Labor hours above 5' },
    ],
    source: 'ai',
    notes: [],
  };
}

test('a number condition narrows the list, shows as a chip, and can be taken out alone', async ({ page, request }) => {
  const tech = 'Number Conditionson';
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: tech, fields: { labor_hours: 2 }, finalize: true });
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: tech, fields: { labor_hours: 9 }, finalize: true });
  await page.route('**/reports/parse-search', (route) => route.fulfill({ json: answerWith(tech) }));

  await page.goto('/#/reports');
  await page.getByTestId('ask-input').fill('repairs by number conditionson with labor hours above 5');
  await page.getByTestId('ask-submit').click();

  // Only the report with 9 hours passes.
  await expect(page.getByTestId('report-row')).toHaveCount(1);
  await expect(page.getByTestId('ask-chip').filter({ hasText: 'Labor hours above 5' })).toHaveCount(1);
  await expect(page.getByTestId('number-condition')).toHaveText(/Labor hours above 5/);

  // Removing it from the filter bar brings the other report back; the lab manager stays.
  await page.getByTestId('number-condition-remove').click();
  await expect(page.getByTestId('report-row')).toHaveCount(2);
  await expect(page.getByTestId('number-condition')).toHaveCount(0);
  await expect(page.locator('input[aria-label="Lab manager"]')).toHaveValue(/number conditionson/i);
});

test('taking the condition out with its chip in the search leaves the rest', async ({ page, request }) => {
  const tech = 'Number Chipson';
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: tech, fields: { labor_hours: 2 }, finalize: true });
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: tech, fields: { labor_hours: 9 }, finalize: true });
  await page.route('**/reports/parse-search', (route) => route.fulfill({ json: answerWith(tech) }));

  await page.goto('/#/reports');
  await page.getByTestId('ask-input').fill('labor hours above 5 by number chipson');
  await page.getByTestId('ask-submit').click();
  await expect(page.getByTestId('report-row')).toHaveCount(1);

  await page.getByTestId('ask-chip').filter({ hasText: 'Labor hours above 5' }).click();
  await expect(page.getByTestId('report-row')).toHaveCount(2);
  await expect(page.getByTestId('number-condition')).toHaveCount(0);
  await expect(page.getByTestId('ask-chip').filter({ hasText: /Lab manager/ })).toHaveCount(1);
});

test('the same condition reaches Analytics, and the CSV export takes it too', async ({ page, request }) => {
  const tech = 'Number Exporton';
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: tech, fields: { labor_hours: 2 }, finalize: true });
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: tech, fields: { labor_hours: 9 }, finalize: true });
  await page.route('**/reports/parse-search', (route) => route.fulfill({ json: answerWith(tech) }));

  await page.goto('/#/reports');
  await page.getByTestId('ask-input').fill('labor hours above 5');
  await page.getByTestId('ask-submit').click();
  await expect(page.getByTestId('report-row')).toHaveCount(1);

  const analytics = page.waitForRequest((r) => r.url().includes('/analytics/fleet') && /number_field=labor_hours/.test(r.url()) && /number_op=gt/.test(r.url()) && /number_value=5/.test(r.url()));
  await page.getByTestId('tab-analytics').click();
  await analytics;
  await expect(page.getByTestId('number-condition')).toHaveText(/Labor hours above 5/);

  // The export answers to the same three parts: only the 9-hour report is in the file.
  const csv = await request.get(`${API_BASE}/reports/export`, {
    params: { technician: tech, number_field: 'labor_hours', number_op: 'gt', number_value: '5' },
  });
  expect(csv.ok()).toBe(true);
  const rows = (await csv.text()).trim().split('\n').slice(1);
  expect(rows).toHaveLength(1);
});
