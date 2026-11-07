import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './coverage';
import { API_BASE, okJson, seedReport } from './helpers/api';
import { markFor, sameValue } from '../../src/reviewMarks';

// The review screen draws every field on the document where its value was read; pointing at either one lights the other.

// The scan is hidden by default in the e2e browser (see coverage.ts); these tests are about it, so show it.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('sl.review.showScan', 'on'));
});

const FORM = readFileSync(path.join(process.cwd(), 'tests/e2e/fixtures/pick-fields-form.pdf'));

test('pure helpers: same value, and which mark wins', () => {
  expect(sameValue(' 29.40 ', '29.40')).toBe(true);
  expect(sameValue(undefined, null)).toBe(true);
  expect(sameValue('a', 'b')).toBe(false);
  expect(sameValue([{ a: 1 }], [{ a: 1 }])).toBe(true);
  expect(markFor(true, true)).toBe('changed');
  expect(markFor(false, true)).toBe('flag');
  expect(markFor(false, false)).toBe('ok');
});

test('a value read from a PDF is boxed on the page, and the box and the field answer each other', async ({ page, request }) => {
  const templates = await okJson<{ id: string; field_schema: { fields: { name: string; type: string }[] } }[]>(
    await request.get(`${API_BASE}/report-templates`, { params: { report_type: 'repair', model: 'LSRFortessa' } }),
    'list templates',
  );
  const numeric = templates[0].field_schema.fields.find((f) => f.type === 'number');
  const text = templates[0].field_schema.fields.find((f) => f.type === 'text');
  expect(numeric && text).toBeTruthy();
  // Values that are written on the sample form: "Laser delay 29.40" and "Technician: Dana Levi".
  const seeded = await seedReport(request, {
    model: 'LSRFortessa',
    reportType: 'repair',
    file: { name: 'pick-fields-form.pdf', contents: FORM },
    fields: { [numeric!.name]: 29.4, [text!.name]: 'Dana Levi' },
  });

  const res = await okJson<{ has_text: boolean; fields: Record<string, { page: number; rects: unknown[]; source: string }> }>(
    await request.get(`${API_BASE}/attachments/${seeded.attachmentId}/field-locations`),
    'field locations',
  );
  expect(res.has_text).toBe(true);
  expect(res.fields[numeric!.name]).toMatchObject({ page: 1, source: 'text' });
  expect(res.fields[text!.name].rects.length).toBeGreaterThan(0);

  await page.goto(`/#/reports/${seeded.reportId}`);
  const onPage = page.getByTestId('fields-on-page');
  await expect(onPage).toBeVisible();
  const box = onPage.locator(`[data-box="${numeric!.name}"]`).first();
  await expect(box).toBeVisible();
  await expect(box).not.toHaveClass(/active/);

  // Pointing at the field in the list lights its box.
  const field = page.locator(`[data-field="${numeric!.name}"]`);
  await field.hover();
  await expect(box).toHaveClass(/active/);

  // Pointing at the box shows its name, and clicking it goes to the field's input.
  await box.hover();
  await expect(box.locator('.fop-name')).toBeVisible();
  await box.click();
  await expect(field.locator('input, textarea, select').first()).toBeFocused();

  // A value that is nowhere on the page gets no box.
  const others = res.fields;
  const missing = templates[0].field_schema.fields.find((f) => !(f.name in others));
  if (missing) await expect(onPage.locator(`[data-box="${missing.name}"]`)).toHaveCount(0);

  // The browser's own PDF viewer is one click away, and back.
  await page.getByTestId('scan-mode-original').click();
  await expect(onPage).toHaveCount(0);
  await page.getByTestId('scan-mode-fields').click();
  await expect(page.getByTestId('fields-on-page')).toBeVisible();
});

test('editing a field turns its box to the "changed" colour', async ({ page, request }) => {
  const templates = await okJson<{ field_schema: { fields: { name: string; type: string }[] } }[]>(
    await request.get(`${API_BASE}/report-templates`, { params: { report_type: 'repair', model: 'LSRFortessa' } }),
    'list templates',
  );
  const text = templates[0].field_schema.fields.find((f) => f.type === 'text')!;
  const seeded = await seedReport(request, {
    model: 'LSRFortessa',
    reportType: 'repair',
    file: { name: 'pick-fields-form.pdf', contents: FORM },
    fields: { [text.name]: 'Dana Levi' },
  });
  await page.goto(`/#/reports/${seeded.reportId}`);
  const box = page.getByTestId('fields-on-page').locator(`[data-box="${text.name}"]`).first();
  await expect(box).toBeVisible();
  await expect(box).not.toHaveClass(/changed/);
  // A finalized report opens read-only; this one is only extracted, so its fields can be typed into.
  await page.locator(`[data-field="${text.name}"]`).locator('input, textarea').first().fill('Someone Else');
  await expect(box).toHaveClass(/changed/);
});

test('a scan with no text shows its pages plain and says why', async ({ page, request }) => {
  const seeded = await seedReport(request, { model: 'LSRFortessa', reportType: 'repair' });
  await page.goto(`/#/reports/${seeded.reportId}`);
  // The seed file is not a real PDF, so no page can be drawn or searched; the note explains.
  const note = page.getByTestId('fields-on-page-note');
  await expect(note).toBeVisible();
});

test('a scan whose reading recorded positions gets dashed approximate boxes', async ({ page, request }) => {
  const templates = await okJson<{ field_schema: { fields: { name: string; type: string }[] } }[]>(
    await request.get(`${API_BASE}/report-templates`, { params: { report_type: 'repair', model: 'LSRFortessa' } }),
    'list templates',
  );
  const text = templates[0].field_schema.fields.find((f) => f.type === 'text')!;
  const seeded = await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', fields: { [text.name]: 'Dana Levi' } });
  // The backend side is covered by its own tests; here the screen is given what a scan's reading would return.
  await page.route('**/attachments/*/field-locations', (route) =>
    route.fulfill({
      json: {
        has_text: false,
        page_count: 1,
        fields: {
          [text.name]: { page: 1, rects: [{ x: 0.1, y: 0.2, w: 0.4, h: 0.05 }], matches: 1, ambiguous: false, source: 'model' },
        },
      },
    }),
  );
  await page.goto(`/#/reports/${seeded.reportId}`);
  const box = page.getByTestId('fields-on-page').locator(`[data-box="${text.name}"]`).first();
  await expect(box).toBeVisible();
  await expect(box).toHaveClass(/guess/);
  await expect(page.getByTestId('fields-on-page-note')).toContainText('approximate');
});
