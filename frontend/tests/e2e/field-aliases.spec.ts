import { type APIRequestContext, type Page } from '@playwright/test';
import { test, expect } from './coverage';
import { API_BASE } from './helpers/api';

// Field aliases (phase 2 of the template-comparison proposal): a hand-kept list
// of sets of field names that mean the same thing, edited on the Templates tab,
// and the "possible match" rows they add to a template comparison. Every name,
// label and model is unique to the run because the suite shares one database.

async function openAliases(page: Page) {
  await page.goto('/');
  await page.click('.view-tab:has-text("Templates")');
  await page.click('#field-aliases');
  await expect(page.getByText('Field aliases', { exact: true }).first()).toBeVisible();
}

function group(page: Page, label: string) {
  return page.locator('.alias-group', { has: page.locator('.alias-group-label', { hasText: label }) });
}

async function fillNames(page: Page, names: string[]) {
  const inputs = page.getByLabel('Field name');
  for (let i = 0; i < names.length; i += 1) {
    if (i >= (await inputs.count())) await page.getByRole('button', { name: '+ Add name' }).click();
    await inputs.nth(i).fill(names[i]);
  }
}

async function createGroup(request: APIRequestContext, label: string | null, names: string[]) {
  const res = await request.post(`${API_BASE}/field-aliases`, { data: { label, names } });
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string };
}

async function createTemplate(request: APIRequestContext, data: Record<string, unknown>) {
  const res = await request.post(`${API_BASE}/report-templates`, { data });
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string };
}

test('create, edit and delete an alias group, with the rules explained', async ({ page, request }) => {
  const stamp = Date.now();
  const label = `E2E check result ${stamp}`;
  const [a, b, c] = [`e2e_retest_${stamp}`, `e2e_verify_${stamp}`, `e2e_outcome_${stamp}`];
  let other: { id: string } | undefined;
  try {
    await openAliases(page);
    await page.click('#new-alias-group');

    // Two names are needed before the group can be saved.
    await expect(page.getByRole('button', { name: 'Create group' })).toBeDisabled();
    await page.locator('#alias-label').fill(label);
    await fillNames(page, [a]);
    await expect(page.getByRole('button', { name: 'Create group' })).toBeDisabled();
    await fillNames(page, [a, b]);
    await page.getByRole('button', { name: 'Create group' }).click();

    await expect(group(page, label).locator('.alias-chip')).toHaveText([a, b]);

    // Edit: add a third name.
    await group(page, label).getByRole('button', { name: 'Edit' }).click();
    await fillNames(page, [a, b, c]);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(group(page, label).locator('.alias-chip')).toHaveText([a, b, c]);

    // A name can be in only one group: the reason is shown and nothing is saved.
    await page.click('#new-alias-group');
    await fillNames(page, [c.toUpperCase(), `e2e_other_${stamp}`]);
    await page.getByRole('button', { name: 'Create group' }).click();
    await expect(page.locator('.banner-crit')).toContainText(`'${c}' is already in the group '${label}'`);
    // The same name twice in one group is refused too.
    await fillNames(page, [`e2e_twice_${stamp}`, `E2E-Twice-${stamp}`]);
    await page.getByRole('button', { name: 'Create group' }).click();
    await expect(page.locator('.banner-crit')).toContainText('are the same name');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('.alias-group-label', { hasText: label })).toHaveCount(1);

    // Delete asks first.
    await group(page, label).getByRole('button', { name: 'Delete' }).click();
    await group(page, label).getByRole('button', { name: 'Cancel' }).click();
    await expect(group(page, label)).toHaveCount(1);
    await group(page, label).getByRole('button', { name: 'Delete' }).click();
    await group(page, label).getByRole('button', { name: 'Confirm delete' }).click();
    await expect(group(page, label)).toHaveCount(0);

    // The names are free again.
    other = await createGroup(request, null, [a, `e2e_free_${stamp}`]);
  } finally {
    const groups = await (await request.get(`${API_BASE}/field-aliases`)).json();
    for (const g of groups.filter((x: { names: string[] }) => x.names.some((n) => n.includes(String(stamp))))) {
      await request.delete(`${API_BASE}/field-aliases/${g.id}`);
    }
    void other;
  }
});

test('differently named fields in one group show as a possible match in a comparison', async ({ page, request }) => {
  const stamp = Date.now();
  const label = `E2E same thing ${stamp}`;
  const [retest, verify] = [`retest_${stamp}`, `verification_${stamp}`];
  const left = await createTemplate(request, {
    report_type: 'repair',
    model: `E2E-AliasA-${stamp}`,
    fields: [
      { name: 'fault', type: 'text', unit: null, notes: null },
      { name: retest, type: 'enum', unit: null, notes: null, options: ['pass', 'fail'] },
      { name: 'left_only', type: 'text', unit: null, notes: null },
    ],
  });
  const right = await createTemplate(request, {
    report_type: 'repair',
    model: `E2E-AliasB-${stamp}`,
    fields: [
      { name: 'fault', type: 'text', unit: null, notes: null },
      { name: verify, type: 'enum', unit: null, notes: null, options: ['pass', 'retest'] },
    ],
  });
  let created: { id: string } | undefined;
  try {
    const compare = async () => {
      await page.goto('/');
      await page.click('.view-tab:has-text("Templates")');
      await page.click('#compare-templates');
      const pick = async (selector: string, pattern: RegExp) => {
        const options = await page
          .locator(`${selector} option`)
          .evaluateAll((els) => els.map((el) => ({ value: (el as HTMLOptionElement).value, text: el.textContent ?? '' })));
        await page.locator(selector).selectOption(options.find((o) => o.value && pattern.test(o.text))!.value);
      };
      await pick('#compare-left', new RegExp(`E2E-AliasA-${stamp}`));
      await pick('#compare-right', new RegExp(`E2E-AliasB-${stamp}`));
      await expect(page.locator('#compare-summary')).toBeVisible();
    };

    // Without an alias the two are one field on each side.
    await compare();
    await expect(page.locator('tr[data-status="possible_match"]')).toHaveCount(0);
    await expect(page.locator('#compare-summary')).not.toContainText('possible match');

    created = await createGroup(request, label, [retest, verify]);
    await compare();
    await expect(page.locator('#compare-summary')).toContainText('1 possible match');
    const row = page.locator('tr[data-status="possible_match"]');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Possible match: spelling, choices');
    await expect(row).toContainText(`Listed as the same thing: ${label}`);
    // Both names and the differing choice are shown, side by side.
    await expect(row.locator('td').nth(0)).toContainText(retest);
    await expect(row.locator('td').nth(1)).toContainText(verify);
    await expect(row.locator('td').nth(0).locator('mark')).toContainText(['fail']);
    await expect(row.locator('td').nth(1).locator('mark')).toContainText(['retest']);
    // The unpaired field stays on its own, and a possible match survives "only the differences".
    await expect(page.locator('tr[data-status="only_left"]')).toHaveCount(1);
    await expect(page.locator('tr[data-status="only_right"]')).toHaveCount(0);
    await page.getByLabel('Show only the differences').check();
    await expect(page.locator('tr[data-status="possible_match"]')).toHaveCount(1);

    // The comparison links to the aliases screen.
    await page.getByRole('button', { name: 'field aliases' }).click();
    await expect(group(page, label)).toHaveCount(1);

    // Deleting the group takes the possible match away; nothing about the templates changed.
    await group(page, label).getByRole('button', { name: 'Delete' }).click();
    await group(page, label).getByRole('button', { name: 'Confirm delete' }).click();
    created = undefined;
    await compare();
    await expect(page.locator('tr[data-status="possible_match"]')).toHaveCount(0);
    const stored = await (await request.get(`${API_BASE}/report-templates/${left.id}`)).json();
    expect(stored.field_schema.fields.map((f: { name: string }) => f.name)).toEqual(['fault', retest, 'left_only']);
  } finally {
    if (created) await request.delete(`${API_BASE}/field-aliases/${created.id}`);
    await request.delete(`${API_BASE}/report-templates/${left.id}`);
    await request.delete(`${API_BASE}/report-templates/${right.id}`);
  }
});
