import { describe, expect, it } from 'vitest';
import type { ReportListItem } from './api';
import { defaultOrder, nextSort, sortReports, type SortState } from './reportSort';

function item(id: string, over: Partial<ReportListItem> = {}): ReportListItem {
  return {
    id,
    status: 'draft',
    instrument_model: null,
    instrument_serial_number: null,
    report_type: null,
    technician_name: null,
    report_date: null,
    created_at: '2031-01-01T00:00:00Z',
    finalized_at: null,
    ...over,
  };
}
const ids = (xs: ReportListItem[]) => xs.map((x) => x.id);
const asc = (key: SortState['key']): SortState => ({ key, direction: 'asc' });
const desc = (key: SortState['key']): SortState => ({ key, direction: 'desc' });

describe('nextSort', () => {
  it('cycles ascending, descending, none on the same column', () => {
    const a = nextSort(null, 'date');
    expect(a).toEqual(asc('date'));
    const d = nextSort(a, 'date');
    expect(d).toEqual(desc('date'));
    expect(nextSort(d, 'date')).toBeNull();
  });

  it('starts ascending when another column is clicked', () => {
    expect(nextSort(desc('date'), 'status')).toEqual(asc('status'));
  });
});

describe('defaultOrder', () => {
  it('puts the newest report date first', () => {
    const r = [item('a', { report_date: '2031-01-05' }), item('b', { report_date: '2031-03-01' }), item('c', { report_date: '2030-12-31' })];
    expect(ids(defaultOrder(r))).toEqual(['b', 'a', 'c']);
  });

  it('uses the upload day for a report without a date', () => {
    const r = [
      item('dated', { report_date: '2031-02-01' }),
      item('undated-later', { created_at: '2031-02-02T08:00:00Z' }),
      item('undated-earlier', { created_at: '2031-01-15T08:00:00Z' }),
    ];
    expect(ids(defaultOrder(r))).toEqual(['undated-later', 'dated', 'undated-earlier']);
  });

  it('breaks a date tie by the later upload, then by id', () => {
    const r = [
      item('z', { report_date: '2031-02-01', created_at: '2031-02-03T10:00:00Z' }),
      item('b', { report_date: '2031-02-01', created_at: '2031-02-03T12:00:00Z' }),
      item('a', { report_date: '2031-02-01', created_at: '2031-02-03T12:00:00Z' }),
    ];
    expect(ids(defaultOrder(r))).toEqual(['a', 'b', 'z']);
  });

  it('returns a copy and handles an empty list', () => {
    const r = [item('a'), item('b')];
    expect(defaultOrder(r)).not.toBe(r);
    expect(defaultOrder([])).toEqual([]);
  });
});

describe('sortReports', () => {
  it('returns the same list when there is no sort', () => {
    const r = [item('b'), item('a')];
    expect(sortReports(r, null)).toBe(r);
  });

  it('does not mutate its input', () => {
    const r = [item('a', { report_date: '2031-02-01' }), item('b', { report_date: '2031-01-01' })];
    sortReports(r, asc('date'));
    expect(ids(r)).toEqual(['a', 'b']);
  });

  it('sorts by date in both directions', () => {
    const r = [item('a', { report_date: '2031-02-01' }), item('b', { report_date: '2030-11-20' }), item('c', { report_date: '2031-12-02' })];
    expect(ids(sortReports(r, asc('date')))).toEqual(['b', 'a', 'c']);
    expect(ids(sortReports(r, desc('date')))).toEqual(['c', 'a', 'b']);
  });

  it('keeps empty cells last in either direction', () => {
    const r = [item('none1'), item('a', { report_date: '2031-02-01' }), item('blank', { report_date: '   ' }), item('b', { report_date: '2030-01-01' })];
    expect(ids(sortReports(r, asc('date')))).toEqual(['b', 'a', 'none1', 'blank']);
    expect(ids(sortReports(r, desc('date')))).toEqual(['a', 'b', 'none1', 'blank']);
  });

  it('keeps the incoming order of equal rows, also when descending', () => {
    const r = [item('x', { technician_name: 'Ada' }), item('y', { technician_name: 'ada' }), item('z', { technician_name: 'Bo' })];
    expect(ids(sortReports(r, asc('lab_manager')))).toEqual(['x', 'y', 'z']);
    expect(ids(sortReports(r, desc('lab_manager')))).toEqual(['z', 'x', 'y']);
  });

  it('orders status by progress, not alphabetically', () => {
    const r = [
      item('fin', { status: 'finalized' }),
      item('dra', { status: 'draft' }),
      item('rev', { status: 'in_review' }),
      item('ext', { status: 'extracted' }),
      item('cla', { status: 'classified' }),
    ];
    expect(ids(sortReports(r, asc('status')))).toEqual(['dra', 'cla', 'ext', 'rev', 'fin']);
    expect(ids(sortReports(r, desc('status')))).toEqual(['fin', 'rev', 'ext', 'cla', 'dra']);
  });

  it('puts an unknown status last', () => {
    const r = [item('odd', { status: 'bogus' as ReportListItem['status'] }), item('fin', { status: 'finalized' })];
    expect(ids(sortReports(r, asc('status')))).toEqual(['fin', 'odd']);
    expect(ids(sortReports(r, desc('status')))).toEqual(['fin', 'odd']);
  });

  it('sorts instruments by model then serial, numerically within the serial', () => {
    const r = [
      item('m2', { instrument_model: 'Zeta', instrument_serial_number: 'S10' }),
      item('m1', { instrument_model: 'Zeta', instrument_serial_number: 'S9' }),
      item('a', { instrument_model: 'alpha', instrument_serial_number: null }),
      item('noModel', { instrument_serial_number: 'S1' }),
    ];
    expect(ids(sortReports(r, asc('instrument')))).toEqual(['a', 'm1', 'm2', 'noModel']);
  });

  it('sorts the type column by its label', () => {
    const r = [
      item('inst', { report_type: 'installation_upgrade' }),
      item('rep', { report_type: 'repair' }),
      item('pm', { report_type: 'preventive_maintenance' }),
    ];
    expect(ids(sortReports(r, asc('type')))).toEqual(['inst', 'rep', 'pm']);
  });

  it('trims names and ignores case when sorting', () => {
    const r = [item('b', { technician_name: 'bruno' }), item('a', { technician_name: '  Anna ' })];
    expect(ids(sortReports(r, asc('lab_manager')))).toEqual(['a', 'b']);
  });
});
