import type { Page } from '@playwright/test';
import { test, expect } from './coverage';
import { API_BASE, seedReport } from './helpers/api';
import { downloadCsv, parseCsv } from './helpers/csv';

// What the Admin export really hands over. csv-export.spec.ts checks that the link follows the filters
// and that a file arrives with the marker in it; this one reads the file: its columns, that it holds
// exactly the reports the screen counts (and none of the others), that each filter narrows it, that an
// empty choice gives a file with only its header, and that awkward characters survive the quoting.

const COLUMNS = [
  'id',
  'status',
  'instrument_model',
  'instrument_serial',
  'report_type',
  'technician_name',
  'report_date',
  'finalized_at',
  'extracted_fields_json',
];

async function openExport(page: Page) {
  await page.goto('/#/new');
  await page.getByTestId('tab-admin').click();
  await expect(page.getByTestId('admin-screen')).toBeVisible();
  await expect(page.getByTestId('admin-export-link')).toHaveAttribute('href', /status=finalized/);
}

const link = (page: Page) => page.getByTestId('admin-export-link');
const countText = (page: Page) => page.getByTestId('admin-match-count');

test('the file holds exactly the reports the screen counts, with their own values, and no others', async ({ page, request }) => {
  const stamp = Date.now();
  const mine = `E2E-Csv-${stamp}`;
  const a = await seedReport(request, { model: 'FACSAria III', reportType: 'preventive_maintenance', technician: `${mine} A`, finalize: true });
  const b = await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: `${mine} B`, finalize: true });
  const draft = await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: `${mine} C` });
  const other = await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: `E2E-Else-${stamp}`, finalize: true });
  const draftStatus = (await (await request.get(`${API_BASE}/reports/${draft.reportId}`)).json()).status;
  expect(draftStatus, 'the third report is not finalized').not.toBe('finalized');

  await openExport(page);
  await page.getByLabel('Lab manager', { exact: true }).fill(mine);
  await expect(link(page)).toHaveAttribute('href', new RegExp(`technician=${mine}`));

  // Finalized is the default choice: two of the three that match the name.
  await expect(countText(page)).toContainText('2 reports');
  const finalized = await downloadCsv(page, link(page));
  expect(finalized.filename).toBe('reports_export.csv');
  expect(finalized.header).toEqual(COLUMNS);
  expect(finalized.rows.map((r) => r.id).sort()).toEqual([a.reportId, b.reportId].sort());
  expect(finalized.rows.map((r) => r.id), 'a draft or another name is not exported').not.toContain(draft.reportId);
  expect(finalized.rows.map((r) => r.id)).not.toContain(other.reportId);

  // Each row says what the report is, as the backend holds it.
  const rowA = finalized.rows.find((r) => r.id === a.reportId)!;
  const storedA = await (await request.get(`${API_BASE}/reports/${a.reportId}`)).json();
  const unit = await (await request.get(`${API_BASE}/instruments/${a.instrumentId}`)).json();
  expect(rowA).toMatchObject({
    status: 'finalized',
    instrument_model: 'FACSAria III',
    instrument_serial: unit.serial_number,
    report_type: 'preventive_maintenance',
    technician_name: `${mine} A`,
    report_date: storedA.report_date ?? '',
  });
  expect(rowA.finalized_at, 'a finalize time is exported').toMatch(/^\d{4}-\d{2}-\d{2}T/);
  // The fields are real JSON (not Python's repr), and the same ones the report holds.
  expect(JSON.parse(rowA.extracted_fields_json)).toEqual(storedA.extracted_fields);
  expect(Object.keys(JSON.parse(rowA.extracted_fields_json)).length, 'fields were exported').toBeGreaterThan(0);

  // Every status: the draft comes with it, and the count on the screen goes up to match.
  await page.getByLabel('Status', { exact: true }).selectOption('');
  await expect(link(page)).not.toHaveAttribute('href', /status=/);
  await expect(countText(page)).toContainText('3 reports');
  const all = await downloadCsv(page, link(page));
  expect(all.rows.map((r) => r.id).sort()).toEqual([a.reportId, b.reportId, draft.reportId].sort());
  expect(all.rows.find((r) => r.id === draft.reportId)!.status).toBe(draftStatus);
  expect(all.rows.find((r) => r.id === draft.reportId)!.finalized_at).toBe('');
  expect(all.rows.map((r) => r.id)).not.toContain(other.reportId);
});

test('the date range keeps the visits inside it, the end dates included', async ({ page, request }) => {
  const mine = `E2E-CsvDates-${Date.now()}`;
  const jan = await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: `${mine} jan`, reportDate: '2025-01-10', finalize: true });
  const mar = await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: `${mine} mar`, reportDate: '2025-03-10', finalize: true });

  await openExport(page);
  await page.getByLabel('Lab manager', { exact: true }).fill(mine);
  await expect(countText(page)).toContainText('2 reports');

  await page.getByLabel('From date').fill('2025-02-01');
  await expect(link(page)).toHaveAttribute('href', /date_from=2025-02-01/);
  await expect(countText(page)).toContainText('1 report ');
  expect((await downloadCsv(page, link(page))).rows.map((r) => r.id)).toEqual([mar.reportId]);

  await page.getByLabel('From date').fill('');
  await page.getByLabel('To date').fill('2025-02-28');
  await expect(link(page)).toHaveAttribute('href', /date_to=2025-02-28/);
  await expect(link(page)).not.toHaveAttribute('href', /date_from/);
  expect((await downloadCsv(page, link(page))).rows.map((r) => r.id)).toEqual([jan.reportId]);

  // A range that starts and ends on the two visit dates holds both.
  await page.getByLabel('From date').fill('2025-01-10');
  await page.getByLabel('To date').fill('2025-03-10');
  await expect(link(page)).toHaveAttribute('href', /date_from=2025-01-10.*date_to=2025-03-10|date_to=2025-03-10.*date_from=2025-01-10/);
  expect((await downloadCsv(page, link(page))).rows.map((r) => r.id).sort()).toEqual([jan.reportId, mar.reportId].sort());
});

test('the model and report type choices each narrow the file', async ({ page, request }) => {
  const mine = `E2E-CsvModel-${Date.now()}`;
  const aria = await seedReport(request, { model: 'FACSAria III', reportType: 'preventive_maintenance', technician: `${mine} aria`, finalize: true });
  const repair = await seedReport(request, { model: 'LSRFortessa', reportType: 'repair', technician: `${mine} repair`, finalize: true });
  const pm = await seedReport(request, { model: 'LSRFortessa', reportType: 'preventive_maintenance', technician: `${mine} pm`, finalize: true });

  await openExport(page);
  await page.getByLabel('Lab manager', { exact: true }).fill(mine);
  await expect(countText(page)).toContainText('3 reports');

  await page.getByLabel('Instrument model', { exact: true }).selectOption({ label: 'LSRFortessa' });
  await expect(link(page)).toHaveAttribute('href', /model_id=/);
  await expect(countText(page)).toContainText('2 reports');
  expect((await downloadCsv(page, link(page))).rows.map((r) => r.id).sort()).toEqual([repair.reportId, pm.reportId].sort());

  await page.getByLabel('Report type', { exact: true }).selectOption('repair');
  await expect(link(page)).toHaveAttribute('href', /report_type=repair/);
  await expect(countText(page)).toContainText('1 report ');
  const only = await downloadCsv(page, link(page));
  expect(only.rows.map((r) => r.id)).toEqual([repair.reportId]);
  expect(only.rows[0]).toMatchObject({ instrument_model: 'LSRFortessa', report_type: 'repair' });
  expect(only.rows.map((r) => r.id)).not.toContain(aria.reportId);
});

test('a choice that matches nothing gives a file with only its header', async ({ page }) => {
  await openExport(page);
  await page.getByLabel('Lab manager', { exact: true }).fill(`E2E-Nobody-${Date.now()}`);
  await expect(countText(page)).toContainText('0 reports');
  const empty = await downloadCsv(page, link(page));
  expect(empty.header).toEqual(COLUMNS);
  expect(empty.rows).toEqual([]);
});

test('commas, quotes, accents and line breaks in the data survive the file', async ({ page, request }) => {
  const stamp = Date.now();
  const name = `E2E-CsvOdd-${stamp}, "Quoted" Ünï – 日本`;
  const narrative = 'Line one, with a comma\nLine "two" has quotes and a tab\t.';
  const seeded = await seedReport(request, {
    model: 'FACSAria III',
    reportType: 'preventive_maintenance',
    technician: name,
    fields: { work_performed: narrative },
    finalize: true,
  });
  const stored = await (await request.get(`${API_BASE}/reports/${seeded.reportId}`)).json();
  expect(stored.extracted_fields.work_performed, 'the awkward text was stored as given').toBe(narrative);

  await openExport(page);
  await page.getByLabel('Lab manager', { exact: true }).fill(`E2E-CsvOdd-${stamp}`);
  await expect(countText(page)).toContainText('1 report ');
  const file = await downloadCsv(page, link(page));
  expect(file.rows).toHaveLength(1);
  expect(file.rows[0].technician_name).toBe(name);
  expect(JSON.parse(file.rows[0].extracted_fields_json).work_performed).toBe(narrative);
});

test('the file reader itself follows the quoting rules', () => {
  // The other tests lean on parseCsv, so its own edge cases are pinned here.
  expect(parseCsv('a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
  expect(parseCsv('a,b\r\n"x,y","he said ""hi"""\r\n')).toEqual([['a', 'b'], ['x,y', 'he said "hi"']]);
  expect(parseCsv('a\n"line1\nline2"\n,\n')).toEqual([['a'], ['line1\nline2'], ['', '']]);
  expect(() => parseCsv('a\n"never closed')).toThrow('inside a quoted field');
});
