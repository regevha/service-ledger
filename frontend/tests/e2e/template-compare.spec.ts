import { type APIRequestContext, type Page } from '@playwright/test';
import { test, expect } from './coverage';
import { API_BASE } from './helpers/api';

// Comparing two templates side by side (phase 1 of the template-comparison
// proposal): read-only, same instrument type only, started from a row's
// "Compare" action or the "Compare templates" button, the second picker listing
// the closest templates first. The seeded templates are the real pairs the
// feature exists for; the made-up ones (unique to the run, since the suite
// shares one database) cover each kind of difference.

const GENERIC_REPAIR = 'Malfunction / repair · (any model)';
const CYTOFLEX_REPAIR = 'Malfunction / repair · CytoFLEX S';

async function openTemplates(page: Page) {
  await page.goto('/');
  await page.click('.view-tab:has-text("Templates")');
  await expect(page.locator('.template-table')).toBeVisible();
}

function row(page: Page, reportType: string, model: string) {
  return page.locator('.template-row-body').filter({ hasText: reportType }).filter({ hasText: model });
}

// selectOption cannot match a label by pattern, and the first picker's labels
// carry the instrument type; choose the one option whose text matches.
async function choose(page: Page, selector: string, pattern: RegExp) {
  const options = await page
    .locator(`${selector} option`)
    .evaluateAll((els) => els.map((el) => ({ value: (el as HTMLOptionElement).value, text: el.textContent ?? '' })));
  const matches = options.filter((o) => o.value && pattern.test(o.text));
  expect(matches, `one option in ${selector} matching ${pattern}`).toHaveLength(1);
  await page.locator(selector).selectOption(matches[0].value);
}

async function createTemplate(request: APIRequestContext, data: Record<string, unknown>) {
  const res = await request.post(`${API_BASE}/report-templates`, { data });
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string };
}

test('the Compare action on a row starts with that template and lists the closest ones first', async ({ page }) => {
  await openTemplates(page);
  await row(page, 'Malfunction / repair', '(any model)').getByRole('button', { name: /More actions/ }).click();
  await row(page, 'Malfunction / repair', '(any model)').getByRole('menuitem', { name: 'Compare' }).click();

  await expect(page.locator('#compare-left option:checked')).toHaveText(new RegExp(`^${GENERIC_REPAIR.replace(/[()/]/g, '\\$&')}`));
  // Nothing is compared until a second template is chosen.
  await expect(page.locator('#compare-summary')).toHaveCount(0);
  // The same report type comes first, under "Closest"; the left template itself is not offered.
  const closest = page.locator('#compare-right optgroup[label="Closest"] option');
  await expect(closest.filter({ hasText: 'CytoFLEX S' })).toHaveCount(1);
  await expect(page.locator('#compare-right option', { hasText: GENERIC_REPAIR })).toHaveCount(0);

  await page.locator('#compare-right').selectOption({ label: CYTOFLEX_REPAIR });

  // Both carry the same six fields.
  await expect(page.locator('#compare-summary')).toContainText('6 of 6 fields shared');
  await expect(page.locator('#compare-summary')).toContainText('0 only in “Malfunction / repair · (any model)”');
  await expect(page.locator('#compare-summary')).toContainText('0 only in “Malfunction / repair · CytoFLEX S”');
  await expect(page.locator('tr[data-status="only_right"]')).toHaveCount(0);
  // The reading hints (notes) differ on five fields, shown as such.
  await expect(page.locator('tr[data-status="differs"]')).toHaveCount(5);
  await expect(page.locator('tr[data-field="labor_hours"]')).toContainText('Differs: notes');
  await expect(page.locator('tr[data-field="labor_hours"] mark').first()).toBeVisible();
  await expect(page.locator('tr[data-status="same"]')).toHaveCount(1);

  // Only the differences.
  await page.getByLabel('Show only the differences').check();
  await expect(page.locator('tr[data-status="same"]')).toHaveCount(0);
  await expect(page.locator('tr.compare-row')).toHaveCount(5);

  // Nothing was changed by looking.
  await page.getByRole('button', { name: '← Back to templates' }).click();
  await expect(page.locator('.template-table')).toBeVisible();
  await expect(row(page, 'Malfunction / repair', '(any model)')).toContainText('6');
});

test('the Compare templates button needs both templates chosen, and identical templates are said to be identical', async ({
  page,
}) => {
  await openTemplates(page);
  await page.click('#compare-templates');
  await expect(page.locator('#compare-right')).toBeDisabled();

  await choose(page, '#compare-left', /Installation \/ upgrade · Cytek Aurora/);
  await expect(page.locator('#compare-right')).toBeEnabled();
  await page.locator('#compare-right').selectOption({ label: 'Preventive maintenance · Cytek Aurora' });

  // The two Cytek Aurora templates have the same four fields.
  await expect(page.locator('#compare-summary')).toContainText('4 of 4 fields shared');
  await expect(page.locator('tr[data-status="same"]')).toHaveCount(4);
  await page.getByLabel('Show only the differences').check();
  await expect(page.locator('#compare-identical')).toContainText('identical fields');

  // Changing the first template clears the second choice and the result.
  await choose(page, '#compare-left', /Installation \/ upgrade · \(any model\)/);
  await expect(page.locator('#compare-right')).toHaveValue('');
  await expect(page.locator('#compare-summary')).toHaveCount(0);
});

test('each kind of difference is marked, with the differing words highlighted', async ({ page, request }) => {
  const stamp = Date.now();
  const a = await createTemplate(request, {
    report_type: 'repair',
    model: `E2E-CmpA-${stamp}`,
    fields: [
      { name: 'Labor hours', type: 'number', unit: 'h', notes: 'Read the Subject line and Description' },
      { name: 'retest', type: 'enum', unit: null, notes: null, options: ['pass', 'fail'] },
      { name: 'parts', type: 'object[]', unit: null, notes: null, item_schema: [{ name: 'part', type: 'text' }] },
      { name: 'only_here', type: 'text', unit: null, notes: null },
    ],
  });
  const b = await createTemplate(request, {
    report_type: 'repair',
    model: `E2E-CmpB-${stamp}`,
    fields: [
      { name: 'labor_hours', type: 'text', unit: 'min', notes: 'Read the Summary line' },
      { name: 'retest', type: 'enum', unit: null, notes: null, options: ['pass', 'retest'] },
      {
        name: 'parts',
        type: 'object[]',
        unit: null,
        notes: null,
        item_schema: [
          { name: 'part', type: 'text' },
          { name: 'qty', type: 'number' },
        ],
      },
      { name: 'only_there', type: 'text', unit: null, notes: null },
    ],
  });
  try {
    await openTemplates(page);
    await page.click('#compare-templates');
    await choose(page, '#compare-left', new RegExp(`E2E-CmpA-${stamp}`));
    await page.locator('#compare-right').selectOption({ label: `Malfunction / repair · E2E-CmpB-${stamp}` });

    await expect(page.locator('#compare-summary')).toContainText('3 of 4 fields shared');
    await expect(page.locator('tr[data-status="only_left"]')).toContainText('only_here');
    await expect(page.locator('tr[data-status="only_right"]')).toContainText('only_there');

    const labor = page.locator('tr[data-field="Labor hours"]');
    await expect(labor).toContainText('Differs: spelling, type, unit, notes');
    const [leftCell, rightCell] = [labor.locator('td').nth(0), labor.locator('td').nth(1)];
    await expect(leftCell.locator('mark')).toContainText(['Labor hours', 'Number', 'h', 'Subject', 'and Description']);
    await expect(rightCell.locator('mark')).toContainText(['labor_hours', 'Text (long)', 'min', 'Summary']);
    // Words both notes share are not marked.
    await expect(leftCell.locator('mark', { hasText: /^Read$/ })).toHaveCount(0);

    const retest = page.locator('tr[data-field="retest"]');
    await expect(retest).toContainText('Differs: choices');
    await expect(retest.locator('td').nth(0).locator('mark')).toHaveText(['fail']);
    await expect(retest.locator('td').nth(1).locator('mark')).toHaveText(['retest']);

    const parts = page.locator('tr[data-field="parts"]');
    await expect(parts).toContainText('Differs: table columns');
    await expect(parts.locator('td').nth(1)).toContainText('part (text), qty (number)');
  } finally {
    await request.delete(`${API_BASE}/report-templates/${a.id}`);
    await request.delete(`${API_BASE}/report-templates/${b.id}`);
  }
});

test('only templates of the same instrument type can be compared', async ({ page, request }) => {
  const stamp = Date.now();
  const typeName = `E2E Compare Type ${stamp}`;
  const type = await (await request.post(`${API_BASE}/instrument-types`, { data: { display_name: typeName } })).json();
  const only = await createTemplate(request, {
    instrument_type: type.key,
    report_type: 'repair',
    model: null,
    fields: [{ name: 'fault_description', type: 'text', unit: null, notes: null }],
  });
  try {
    await openTemplates(page);
    await row(page, 'Malfunction / repair', typeName).getByRole('button', { name: /More actions/ }).click();
    await row(page, 'Malfunction / repair', typeName).getByRole('menuitem', { name: 'Compare' }).click();

    // It is the only template of its type: the second picker has nothing to offer.
    await expect(page.getByText(`There is no other ${typeName} template to compare this one with.`)).toBeVisible();
    await expect(page.locator('#compare-right option')).toHaveCount(1);

    // Switching to a flow cytometer template lists those, and not this one.
    await choose(page, '#compare-left', /Installation \/ upgrade · \(any model\) \(Flow cytometer\)/);
    await expect(page.locator('#compare-right option', { hasText: 'Malfunction / repair · (any model)' })).toHaveCount(1);
    await expect(page.locator('#compare-right option')).not.toHaveCount(1);
    const offered = await page.locator('#compare-right option').allTextContents();
    expect(offered.some((text) => text.includes(typeName))).toBe(false);
  } finally {
    await request.delete(`${API_BASE}/report-templates/${only.id}`);
  }
});
