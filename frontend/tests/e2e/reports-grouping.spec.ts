import { test, expect } from './coverage';
import { API_BASE, seedReport } from './helpers/api';

// The Reports list opens grouped by instrument: one card per instrument with its reports inside, a count,
// a "need review" chip and a link to the instrument page. "Group: Model" puts every unit of a model in one card.
// "Group: None" is the flat sortable table.

test('reports are grouped by instrument, and Group: None shows the flat table', async ({ page, request }) => {
  const stamp = Date.now();
  const a = `E2E-GroupA-${stamp}`;
  const b = `E2E-GroupB-${stamp}`;
  await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: a, finalize: true });
  await seedReport(request, { model: 'FACSAria III', reportType: 'preventive_maintenance', technician: b, finalize: true });

  await page.setViewportSize({ width: 1300, height: 900 });
  await page.goto('/#/reports');
  await expect(page.getByTestId('report-groups')).toBeVisible();
  await expect(page.getByTestId('group-select')).toHaveValue('instrument');
  // No sort headers on the grouped view.
  await expect(page.locator('.report-row-head')).toHaveCount(0);

  const groupA = page.getByTestId('report-group').filter({ has: page.locator('.report-row-body', { hasText: a }) });
  await expect(groupA).toHaveCount(1);
  await expect(groupA.locator('.report-group-head strong')).toHaveText('LSRFortessa');
  await expect(groupA.locator('.report-row-body', { hasText: b })).toHaveCount(0);
  await expect(groupA.getByRole('button', { name: /Instrument page/ })).toBeVisible();

  // A row still opens its report.
  await groupA.locator('.report-row-body', { hasText: a }).click();
  await expect(page.locator('.field-list, .back-link').first()).toBeVisible();
  await page.goBack();

  // None: one flat table with sortable headers; the choice is remembered.
  await page.getByTestId('group-select').selectOption('none');
  await expect(page.getByTestId('report-groups')).toHaveCount(0);
  await expect(page.getByTestId('sort-date')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('group-select')).toHaveValue('none');
});

test('Group: Model puts the reports of every unit of one model in one card, and the choice is remembered', async ({ page, request }) => {
  const stamp = Date.now();
  const model = `E2E-GM-${stamp}`;
  const units: { id: string; serial: string }[] = [];
  for (const n of [1, 2]) {
    const made = await request.post(`${API_BASE}/instruments`, {
      data: { name: `E2E GM ${n}`, model, manufacturer: 'E2E Maker', serial_number: `SN-GM-${stamp}-${n}` },
    });
    expect(made.ok()).toBeTruthy();
    const body = await made.json();
    units.push({ id: body.id, serial: body.serial_number });
  }
  const templates = await (await request.get(`${API_BASE}/report-templates`, { params: { report_type: 'repair', model } })).json();
  const tags = [`E2E-GM1-${stamp}`, `E2E-GM2-${stamp}`];
  for (const [i, unit] of units.entries()) {
    await seedReport(request, { instrumentId: unit.id, templateId: templates[0].id, model, reportType: 'repair', technician: tags[i], finalize: true });
  }

  await page.setViewportSize({ width: 1300, height: 900 });
  await page.goto('/#/reports');
  await expect(page.getByTestId('group-select')).toHaveValue('instrument');

  // By instrument the two units are two cards.
  const byUnit = page.getByTestId('report-group').filter({ has: page.locator('.report-row-body', { hasText: tags[0] }) });
  await expect(byUnit).toHaveCount(1);
  await expect(byUnit.locator('.report-row-body', { hasText: tags[1] })).toHaveCount(0);

  // By model they are one card: the model as its title, how many units, the maker, both reports, and no instrument page link.
  await page.getByTestId('group-select').selectOption('model');
  const card = page.getByTestId('report-group').filter({ has: page.locator('.report-row-body', { hasText: tags[0] }) });
  await expect(card).toHaveCount(1);
  await expect(card.locator('.report-row-body', { hasText: tags[1] })).toHaveCount(1);
  await expect(card.locator('.report-group-head strong')).toHaveText(model);
  await expect(card.getByTestId('group-units')).toHaveText('2 instruments');
  await expect(card.locator('.report-group-count')).toHaveText('2 reports');
  await expect(card.locator('.report-group-head')).toContainText('E2E Maker');
  await expect(card.getByRole('button', { name: /Instrument page/ })).toHaveCount(0);
  // Each row still says which unit it is.
  await expect(card.locator('.report-row-body', { hasText: tags[1] })).toContainText(units[1].serial);

  // A row still opens its report.
  await card.locator('.report-row-body', { hasText: tags[0] }).click();
  await expect(page.locator('.field-list, .back-link').first()).toBeVisible();
  await page.goBack();

  // Remembered, like the other choices.
  await page.reload();
  await expect(page.getByTestId('group-select')).toHaveValue('model');
  await expect(page.getByTestId('report-groups')).toBeVisible();
});

test('Group: Model for a single unit says "1 instrument", and the card fits a phone screen', async ({ page, request }) => {
  const stamp = Date.now();
  const model = `E2E-GM1-${stamp}`;
  const made = await request.post(`${API_BASE}/instruments`, {
    data: { name: 'E2E GM solo', model, manufacturer: 'E2E Maker', serial_number: `SN-GM1-${stamp}` },
  });
  expect(made.ok()).toBeTruthy();
  const unit = await made.json();
  const templates = await (await request.get(`${API_BASE}/report-templates`, { params: { report_type: 'repair', model } })).json();
  const tag = `E2E-GM1T-${stamp}`;
  await seedReport(request, { instrumentId: unit.id, templateId: templates[0].id, model, reportType: 'repair', technician: tag, finalize: true });

  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/#/reports');
  await page.getByTestId('group-select').selectOption('model');
  const card = page.getByTestId('report-group').filter({ has: page.locator('.report-row-body', { hasText: tag }) });
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId('group-units')).toHaveText('1 instrument');
  await expect(card.locator('.report-group-count')).toHaveText('1 report');
  // nothing makes the page scroll sideways
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
