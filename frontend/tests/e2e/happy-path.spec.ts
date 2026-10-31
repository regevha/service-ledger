import { test, expect } from './coverage';
import { uniqueFixture } from './unique-upload';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIMEOUT } from './timeouts';
import { API_BASE } from './helpers/api';

import { finalizeFromReview } from './finalize-helper';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The confident case (§4): a document with no marker in its filename gets a
// deterministic "confident on both" stub classification, auto-resolves
// straight to extraction with no manual-confirm detour, and reaches the
// review screen ready to finalize. This is the one flow every earlier round
// of ad hoc Playwright scripts this session re-verified by hand before every
// milestone — this file is that check, made permanent.
//
// Beyond "the screens appeared", it checks the values: every field of the template the stub picked
// holds the value meant for that field, the screen shows what the backend holds, and finalizing
// keeps those values. Which report type the stub picks depends on a hash of the stored file path, so
// the checks are driven by the template the report actually resolved to, not by a fixed list.

const FIXTURE = path.join(__dirname, 'fixtures', 'confident-scan.pdf');

type TemplateField = { name: string; type: string; item_schema?: { name: string; type: string }[] };
type ReportJson = {
  id: string;
  template_id: string;
  instrument_id: string | null;
  status: string;
  technician_name: string | null;
  report_date: string | null;
  finalized_at: string | null;
  extracted_fields: Record<string, unknown>;
};

// What the stub writes into a text field: its name (underscores as spaces) and the stored file it was
// read from. A value that landed in the wrong field, or came from another document, does not match.
function stubText(fieldName: string): RegExp {
  return new RegExp(`^\\[stub\\] ${fieldName.replace(/_/g, ' ')} read from .*confident-scan\\.pdf$`);
}

test('upload → auto-classify → extract → review → finalize', async ({ page, request }) => {
  const marker = `E2E-HappyPath-${Date.now()}`;
  await page.goto('/');

  await page.click('.view-tab:has-text("New report")');
  await page.fill('input[placeholder="Your name (optional)"]', marker);
  await page.getByTestId('intake-file-input').setInputFiles(uniqueFixture(FIXTURE));
  await page.click('button:has-text("Upload & classify")');

  // No manual-confirm detour expected for this fixture.
  await page.waitForSelector('.field-list, [data-testid="class-row"], [data-testid="intake-error"]', { timeout: TIMEOUT.flow });
  await expect(page.getByTestId('class-row')).toHaveCount(0);
  await expect(page.getByTestId('intake-error')).toHaveCount(0);

  await expect(page.locator('.field-list')).toBeVisible();

  // The report this run made, as the backend holds it, and the template it resolved to.
  const listed = await (await request.get(`${API_BASE}/reports`)).json();
  const mine = (listed.items ?? listed).find((r: { technician_name?: string }) => r.technician_name === marker);
  expect(mine, 'the report made by this run is listed').toBeTruthy();
  const before: ReportJson = await (await request.get(`${API_BASE}/reports/${mine.id}`)).json();
  const template = await (await request.get(`${API_BASE}/report-templates/${before.template_id}`)).json();
  const fields: TemplateField[] = template.field_schema.fields;
  expect(fields.length, 'the template has fields').toBeGreaterThan(0);

  expect(before.instrument_id, 'the report is on an instrument').toBeTruthy();
  expect(before.report_date, 'a service date was read').toMatch(/^\d{4}-\d{2}-\d{2}$/);

  for (const field of fields) {
    const value = before.extracted_fields[field.name];
    const onScreen = page.locator(`.field-list .field[data-field="${field.name}"]`);

    // Every template field is on the review screen, and the backend holds a value for it.
    await expect(onScreen, `${field.name} is on the review screen`).toHaveCount(1);
    expect(before.extracted_fields, `${field.name} was extracted`).toHaveProperty(field.name);

    if (field.type === 'text') {
      expect(value, `${field.name} holds the text read for it`).toMatch(stubText(field.name));
      await expect(onScreen.locator('textarea, input').first(), `${field.name} on screen`).toHaveValue(value as string);
    } else if (field.type === 'number') {
      expect(typeof value, `${field.name} is a number`).toBe('number');
      if (field.name === 'labor_hours') expect((value as number) * 4, 'labor is rounded to a quarter hour').toBe(Math.round((value as number) * 4));
      expect(Number(await onScreen.locator('input').first().inputValue()), `${field.name} on screen`).toBe(value);
    } else if (field.type === 'object[]') {
      const rows = value as Record<string, unknown>[];
      expect(Array.isArray(rows) && rows.length > 0, `${field.name} has a row`).toBe(true);
      for (const column of field.item_schema ?? []) {
        if (column.type === 'text') expect(rows[0][column.name], `${field.name}.${column.name}`).toMatch(stubText(column.name));
        else expect(typeof rows[0][column.name], `${field.name}.${column.name}`).toBe('number');
      }
    }
  }
  await expect(page.locator('.field-list .field[data-field="report_date"] input').first(), 'service date on screen').toHaveValue(before.report_date!);

  await finalizeFromReview(page);
  await expect(page.getByTestId('intake-success')).toBeVisible({ timeout: TIMEOUT.ui });
  await expect(page.getByTestId('intake-success')).toContainText('finalized');

  // Finalizing records the report as it was reviewed: same values, same date, same instrument.
  const after: ReportJson = await (await request.get(`${API_BASE}/reports/${mine.id}`)).json();
  expect(after.status).toBe('finalized');
  expect(after.finalized_at, 'a finalize time was recorded').toBeTruthy();
  expect(after.extracted_fields).toEqual(before.extracted_fields);
  expect(after.report_date).toBe(before.report_date);
  expect(after.instrument_id).toBe(before.instrument_id);
  expect(after.technician_name).toBe(marker);

  // "Start another report" returns to a clean intake screen — the state
  // machine's reset path, not just the finalize call itself.
  await page.click('button:has-text("Start another report")');
  await expect(page.getByTestId('intake-dropzone')).toBeVisible();
});
