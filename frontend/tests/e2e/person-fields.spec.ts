import { type APIRequestContext } from '@playwright/test';
import { test, expect } from './coverage';
import { uniquePdf } from './unique-upload';
import { BACKEND_PORT } from '../../playwright.config';

// Fields a person fills in (fault category) are not
// printed on the form. The model still suggests a value, but Review always asks for it to
// be checked, however confident the model was (review of 2026-10-29, item 7, option B).

const API = `http://localhost:${BACKEND_PORT}`;

async function seedRepair(request: APIRequestContext, technician: string, finalize = false): Promise<string> {
  const report = await (await request.post(`${API}/reports`, { data: { technician_name: technician } })).json();
  const instruments = await (await request.get(`${API}/instruments`)).json();
  const instrument = instruments.find((i: { model: string }) => i.model === 'LSRFortessa');
  const templates = await (
    await request.get(`${API}/report-templates`, { params: { report_type: 'repair', model: 'LSRFortessa' } })
  ).json();
  await request.patch(`${API}/reports/${report.id}/template`, { data: { instrument_id: instrument.id, template_id: templates[0].id } });
  const attachment = await (
    await request.post(`${API}/reports/${report.id}/attachments`, {
      multipart: { file: { name: 'seed.pdf', mimeType: 'application/pdf', buffer: uniquePdf('%PDF-1.4 seed') } },
    })
  ).json();
  const job = await (await request.post(`${API}/attachments/${attachment.id}/extract`)).json();
  for (let i = 0; i < 150; i++) {
    const j = await (await request.get(`${API}/extraction-jobs/${job.id}`)).json();
    if (j.status === 'succeeded' || j.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (finalize) await request.post(`${API}/reports/${report.id}/finalize`);
  return report.id;
}

test('the repair template marks fault category as filled in by a person', async ({ request }) => {
  const templates = await (
    await request.get(`${API}/report-templates`, { params: { report_type: 'repair', model: 'LSRFortessa' } })
  ).json();
  const marked = templates[0].field_schema.fields.filter((f: { filled_by_person?: boolean }) => f.filled_by_person);
  expect(marked.map((f: { name: string }) => f.name).sort()).toEqual(['fault_category']);
});

test('a person field is flagged until it is marked as checked', async ({ page, request }) => {
  const marker = `E2E-PersonNew-${Date.now()}`;
  await seedRepair(request, marker);
  await page.goto('/');
  await page.click('.view-tab:has-text("Reports")');
  await page.click(`.report-row-body:has-text("${marker}")`);
  await expect(page.locator('.field-list')).toBeVisible({ timeout: 15_000 });

  const field = page.locator('[data-field="fault_category"]');
  await expect(field).toHaveClass(/pending/);
  await expect(field.getByTestId('person-field-badge')).toHaveText('suggested, check it');
  const pending = await page.locator('.field.pending').count();

  await field.getByRole('button', { name: 'Mark as checked' }).click();
  await expect(field).not.toHaveClass(/pending/);
  await expect(field.getByTestId('person-field-badge')).toHaveText('checked');
  await expect(page.locator('.field.pending')).toHaveCount(pending - 1);
});

test('a saved draft flags them too; a finalized report does not', async ({ page, request }) => {
  const draftMarker = `E2E-Person-${Date.now()}`;
  await seedRepair(request, draftMarker);
  await page.goto('/');
  await page.click('.view-tab:has-text("Reports")');
  await page.click(`.report-row-body:has-text("${draftMarker}")`);
  await expect(page.locator('.field-list')).toBeVisible({ timeout: 15_000 });
  for (const name of ['fault_category']) {
    await expect(page.locator(`[data-field="${name}"]`)).toHaveClass(/pending/);
    await expect(page.locator(`[data-field="${name}"]`).getByTestId('person-field-badge')).toHaveText('suggested, check it');
  }

  const finalMarker = `E2E-PersonFinal-${Date.now()}`;
  const finalId = await seedRepair(request, finalMarker, true);
  await page.goto(`/#/reports/${finalId}`);
  await expect(page.locator('.field-list')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('person-field-badge')).toHaveCount(0);
});

test('the template editor sets and clears "Filled in by a person"', async ({ page, request }) => {
  const model = `E2E-PersonTpl-${Date.now()}`;
  await page.goto('/');
  await page.click('.view-tab:has-text("Templates")');
  await page.click('button:has-text("+ New template")');
  await page.locator('.schema-form-label', { hasText: 'Model' }).locator('input').fill(model);
  await page.click('button:has-text("+ Add field")');
  const row = page.locator('.schema-field-row').nth(0);
  await row.locator('[aria-label="Field name"]').fill('outcome');
  const check = row.getByRole('checkbox', { name: /Filled in by a person/ });
  await expect(check).not.toBeChecked();
  await check.check();
  // Changing the type keeps the choice.
  await row.locator('[aria-label="Field type"]').selectOption('boolean');
  await expect(check).toBeChecked();
  await page.click('button:has-text("Create template")');
  await expect(page.locator('.template-row-body', { hasText: model })).toBeVisible();

  const all = await (await request.get(`${API}/report-templates/all`)).json();
  const saved = all.find((t: { model: string | null }) => t.model === model);
  expect(saved.field_schema.fields[0].filled_by_person).toBe(true);

  await page.locator('.template-row-body', { hasText: model }).locator('button:has-text("Edit")').click();
  const reopened = page.locator('.schema-field-row').nth(0).getByRole('checkbox', { name: /Filled in by a person/ });
  await expect(reopened).toBeChecked();
});
