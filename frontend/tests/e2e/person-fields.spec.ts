import { type APIRequestContext } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './coverage';
import { uniqueFixture, uniquePdf } from './unique-upload';
import { BACKEND_PORT } from '../../playwright.config';

// Fields a person fills in (fault category, retest result, verification result) are not
// printed on the form. The model still suggests a value, but Review always asks for it to
// be checked, however confident the model was (review of 2026-10-29, item 7, option B).

const API = `http://localhost:${BACKEND_PORT}`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIDENT_SCAN = path.join(__dirname, 'fixtures', 'confident-scan.pdf');

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

test('the repair template marks fault category and retest result as filled in by a person', async ({ request }) => {
  const templates = await (
    await request.get(`${API}/report-templates`, { params: { report_type: 'repair', model: 'LSRFortessa' } })
  ).json();
  const marked = templates[0].field_schema.fields.filter((f: { filled_by_person?: boolean }) => f.filled_by_person);
  expect(marked.map((f: { name: string }) => f.name).sort()).toEqual(['fault_category', 'retest_result']);
});

test('a new report: person fields are flagged even at 99% confidence, until marked as checked', async ({ page }) => {
  // Every field read at 0.99, so only the person fields can be flagged.
  await page.route('**/extraction-jobs/*', async (route) => {
    const response = await route.fetch();
    const job = await response.json();
    if (job?.kind === 'extract' && job.field_confidences) {
      job.field_confidences = Object.fromEntries(Object.keys(job.field_confidences).map((k) => [k, 0.99]));
    }
    await route.fulfill({ response, json: job });
  });
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles(uniqueFixture(CONFIDENT_SCAN));
  await page.click('button:has-text("Upload & classify")');
  await page.waitForSelector('.field-list', { timeout: 30_000 });

  const badges = page.getByTestId('person-field-badge');
  const n = await badges.count();
  expect(n).toBeGreaterThan(0);
  await expect(page.locator('.field.pending')).toHaveCount(n);
  await expect(badges.first()).toHaveText('suggested, check it');
  await expect(page.getByTestId('attention-strip')).toContainText(`${n} field`);

  const first = page.locator('.field.pending').first();
  const name = await first.getAttribute('data-field');
  await first.getByRole('button', { name: 'Mark as checked' }).click();
  const field = page.locator(`[data-field="${name}"]`);
  await expect(field).not.toHaveClass(/pending/);
  await expect(field.getByTestId('person-field-badge')).toHaveText('checked');
  await expect(page.locator('.field.pending')).toHaveCount(n - 1);
});

test('a saved draft flags them too; a finalized report does not', async ({ page, request }) => {
  const draftMarker = `E2E-Person-${Date.now()}`;
  await seedRepair(request, draftMarker);
  await page.goto('/');
  await page.click('.view-tab:has-text("Reports")');
  await page.click(`.report-row-body:has-text("${draftMarker}")`);
  await expect(page.locator('.field-list')).toBeVisible({ timeout: 15_000 });
  for (const name of ['fault_category', 'retest_result']) {
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
