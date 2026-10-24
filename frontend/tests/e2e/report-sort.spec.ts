import { test, expect } from '@playwright/test';
import { defaultOrder, nextSort, sortReports } from '../../src/reportSort';
import type { ReportListItem } from '../../src/api';

// The sorting rules of the Reports table (src/reportSort.ts), checked on plain
// data with no browser. The table itself is covered by reports-sort-table.spec.ts.

function row(id: string, over: Partial<ReportListItem> = {}): ReportListItem {
  return {
    id,
    status: 'draft',
    instrument_model: null,
    instrument_serial_number: null,
    report_type: null,
    technician_name: null,
    report_date: null,
    created_at: '2026-01-01T00:00:00Z',
    finalized_at: null,
    ...over,
  };
}
const ids = (rows: ReportListItem[]) => rows.map((r) => r.id);

test('no sort returns the list as it came, the same array', () => {
  const rows = [row('b'), row('a')];
  expect(sortReports(rows, null)).toBe(rows);
});

test('clicking a column goes ascending, descending, then back to no sort', () => {
  const asc = nextSort(null, 'date');
  expect(asc).toEqual({ key: 'date', direction: 'asc' });
  const desc = nextSort(asc, 'date');
  expect(desc).toEqual({ key: 'date', direction: 'desc' });
  expect(nextSort(desc, 'date')).toBeNull();
  // Another column starts again at ascending.
  expect(nextSort(desc, 'status')).toEqual({ key: 'status', direction: 'asc' });
});

test('dates sort as dates, and reports with no date go last in both directions', () => {
  const rows = [
    row('none-1'),
    row('sep', { report_date: '2026-09-22' }),
    row('jan', { report_date: '2026-01-05' }),
    row('none-2'),
    row('dec', { report_date: '2025-12-31' }),
  ];
  expect(ids(sortReports(rows, { key: 'date', direction: 'asc' }))).toEqual(['dec', 'jan', 'sep', 'none-1', 'none-2']);
  expect(ids(sortReports(rows, { key: 'date', direction: 'desc' }))).toEqual(['sep', 'jan', 'dec', 'none-1', 'none-2']);
});

test('text columns ignore case and spaces, and numbers inside text sort naturally', () => {
  const rows = [
    row('c', { technician_name: ' charlie ' }),
    row('a', { technician_name: 'Alice' }),
    row('b', { technician_name: 'bob' }),
    row('blank', { technician_name: '   ' }),
  ];
  expect(ids(sortReports(rows, { key: 'lab_manager', direction: 'asc' }))).toEqual(['a', 'b', 'c', 'blank']);
  expect(ids(sortReports(rows, { key: 'lab_manager', direction: 'desc' }))).toEqual(['c', 'b', 'a', 'blank']);

  const units = [
    row('u10', { instrument_model: 'LSRFortessa', instrument_serial_number: 'R10' }),
    row('u2', { instrument_model: 'LSRFortessa', instrument_serial_number: 'R2' }),
    row('aria', { instrument_model: 'FACSAria III', instrument_serial_number: 'P1' }),
  ];
  expect(ids(sortReports(units, { key: 'instrument', direction: 'asc' }))).toEqual(['aria', 'u2', 'u10']);
});

test('status sorts by how far along the report is, not alphabetically', () => {
  const rows = [
    row('fin', { status: 'finalized' }),
    row('draft', { status: 'draft' }),
    row('ext', { status: 'extracted' }),
    row('rev', { status: 'in_review' }),
    row('cls', { status: 'classified' }),
  ];
  expect(ids(sortReports(rows, { key: 'status', direction: 'asc' }))).toEqual(['draft', 'cls', 'ext', 'rev', 'fin']);
  expect(ids(sortReports(rows, { key: 'status', direction: 'desc' }))).toEqual(['fin', 'rev', 'ext', 'cls', 'draft']);
});

test('the type column sorts by the label people see', () => {
  const rows = [
    row('pm', { report_type: 'preventive_maintenance' }), // Preventive maintenance
    row('rep', { report_type: 'repair' }), // Malfunction / repair
    row('cal', { report_type: 'calibration' }), // Calibration
    row('inst', { report_type: 'installation_upgrade' }), // Installation / upgrade
  ];
  expect(ids(sortReports(rows, { key: 'type', direction: 'asc' }))).toEqual(['cal', 'inst', 'rep', 'pm']);
});

test('rows that compare equal keep the order they came in, and the input is not changed', () => {
  const rows = [
    row('first', { technician_name: 'Sam' }),
    row('second', { technician_name: 'sam' }),
    row('third', { technician_name: 'SAM' }),
  ];
  const before = ids(rows);
  expect(ids(sortReports(rows, { key: 'lab_manager', direction: 'asc' }))).toEqual(['first', 'second', 'third']);
  expect(ids(sortReports(rows, { key: 'lab_manager', direction: 'desc' }))).toEqual(['first', 'second', 'third']);
  expect(ids(rows)).toEqual(before);
});

test('the default order is newest report date first, undated reports by upload day, later upload first on a tie', () => {
  const rows = [
    row('jan', { report_date: '2026-01-12', created_at: '2026-10-24T09:00:00Z' }),
    row('sep', { report_date: '2026-09-08', created_at: '2026-10-24T09:00:00Z' }),
    row('draft-today', { created_at: '2026-10-24T10:00:00Z' }),
    row('draft-old', { created_at: '2026-03-01T10:00:00Z' }),
    row('sep-later-upload', { report_date: '2026-09-08', created_at: '2026-10-24T11:00:00Z' }),
  ];
  const before = ids(rows);
  expect(ids(defaultOrder(rows))).toEqual(['draft-today', 'sep-later-upload', 'sep', 'draft-old', 'jan']);
  // Same input in any order gives the same result, and the input is not changed.
  expect(ids(defaultOrder([...rows].reverse()))).toEqual(['draft-today', 'sep-later-upload', 'sep', 'draft-old', 'jan']);
  expect(ids(rows)).toEqual(before);
});
