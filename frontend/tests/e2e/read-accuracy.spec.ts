import { test, expect } from './coverage';
import { API_BASE } from './helpers/api';

// Admin: Reading accuracy (how much of the reading was approved without an edit) and the technical glossary
// (how a Hebrew term should read in English). The suite shares one database, so the accuracy check accepts
// either an empty period or real figures, and every glossary term is unique to the run.

test('the accuracy page shows the goal and either figures or a plain empty message', async ({ page }) => {
  await page.goto('/#/admin/accuracy');
  await expect(page.getByRole('heading', { name: 'Reading accuracy' })).toBeVisible();
  await expect(page.getByText(/The goal is 99% of fields/)).toBeVisible();
  await page.getByRole('radio', { name: 'All' }).click();
  await expect(page.getByTestId('accuracy-empty').or(page.getByTestId('acc-fields'))).toBeVisible();
  if (await page.getByTestId('acc-fields').isVisible()) {
    await expect(page.getByTestId('acc-weeks')).toBeVisible();
    await expect(page.getByTestId('acc-fields')).toContainText('goal 99%');
  }
});

test('Home links its accuracy figure to the accuracy page', async ({ page }) => {
  await page.goto('/#/');
  await page.getByTestId('home-accuracy-link').click();
  await expect(page).toHaveURL(/#\/admin\/accuracy$/);
  await expect(page.getByTestId('accuracy-screen')).toBeVisible();
});

test('add, edit and remove a glossary term', async ({ page, request }) => {
  const stamp = Date.now();
  const wrong = `e2e wrong ${stamp}`;
  const right = `e2e right ${stamp}`;
  await page.goto('/#/admin/glossary');
  await page.getByTestId('glossary-add').click();
  const form = page.getByTestId('glossary-form');
  // Neither the Hebrew term nor a wrong wording: refused with a plain reason.
  await form.getByLabel('Right English term').fill(right);
  await form.getByRole('button', { name: 'Add term' }).click();
  await expect(form.getByRole('alert')).toHaveText('Give the Hebrew term, the wrong English wording, or both.');
  await form.getByLabel('Wrong English wording seen before').fill(wrong);
  await form.getByRole('button', { name: 'Add term' }).click();
  const row = page.getByTestId('glossary-table').getByRole('row', { name: new RegExp(right) });
  await expect(row).toContainText(wrong);

  await row.getByRole('button', { name: 'Edit' }).click();
  await page.getByTestId('glossary-form').getByLabel('Note (optional)').fill('checked in e2e');
  await page.getByTestId('glossary-form').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('glossary-table').getByRole('row', { name: new RegExp(right) })).toContainText('checked in e2e');

  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('glossary-table').getByRole('row', { name: new RegExp(right) }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByTestId('glossary-table').getByRole('row', { name: new RegExp(right) })).toHaveCount(0);
  const terms = (await (await request.get(`${API_BASE}/glossary-terms`)).json()) as { english_term: string }[];
  expect(terms.some((t) => t.english_term === right)).toBe(false);
});
