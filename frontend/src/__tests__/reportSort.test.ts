import { describe, expect, it } from 'vitest';
import type { ReportListItem } from '../api';
import { defaultOrder, nextSort, sortReports } from '../reportSort';

function report(id: string, over: Partial<ReportListItem> = {}): ReportListItem {
  return {
    id,
    status: 'finalized',
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

const ids = (items: ReportListItem[]) => items.map((r) => r.id);

describe('nextSort', () => {
  it('goes ascending, descending, then none, and restarts on another column', () => {
    const asc = nextSort(null, 'date');
    expect(asc).toEqual({ key: 'date', direction: 'asc' });
    const desc = nextSort(asc, 'date');
    expect(desc).toEqual({ key: 'date', direction: 'desc' });
    expect(nextSort(desc, 'date')).toBeNull();
    expect(nextSort(desc, 'status')).toEqual({ key: 'status', direction: 'asc' });
  });
});

describe('defaultOrder', () => {
  it('puts the newest report date first and uses the upload day when there is no date', () => {
    const items = [
      report('old', { report_date: '2026-01-05' }),
      report('undated', { created_at: '2026-03-01T10:00:00Z' }),
      report('new', { report_date: '2026-02-10' }),
    ];
    expect(ids(defaultOrder(items))).toEqual(['undated', 'new', 'old']);
  });

  it('puts the later upload first on a tie and does not change its input', () => {
    const items = [
      report('a', { report_date: '2026-02-01', created_at: '2026-02-01T08:00:00Z' }),
      report('b', { report_date: '2026-02-01', created_at: '2026-02-01T09:00:00Z' }),
    ];
    expect(ids(defaultOrder(items))).toEqual(['b', 'a']);
    expect(ids(items)).toEqual(['a', 'b']);
  });
});

describe('sortReports', () => {
  it('returns the list as it is when there is no sort', () => {
    const items = [report('b'), report('a')];
    expect(sortReports(items, null)).toBe(items);
  });

  it('sorts by date in both directions and always puts empty cells last', () => {
    const items = [report('none'), report('mid', { report_date: '2026-02-01' }), report('early', { report_date: '2026-01-01' })];
    expect(ids(sortReports(items, { key: 'date', direction: 'asc' }))).toEqual(['early', 'mid', 'none']);
    expect(ids(sortReports(items, { key: 'date', direction: 'desc' }))).toEqual(['mid', 'early', 'none']);
  });

  it('sorts status by progress, not alphabetically', () => {
    const items = [report('f', { status: 'finalized' }), report('d', { status: 'draft' }), report('r', { status: 'in_review' })];
    expect(ids(sortReports(items, { key: 'status', direction: 'asc' }))).toEqual(['d', 'r', 'f']);
  });

  it('compares numbers inside text naturally and keeps equal rows in their order', () => {
    const items = [
      report('s10', { instrument_model: 'Unit', instrument_serial_number: '10' }),
      report('s2', { instrument_model: 'Unit', instrument_serial_number: '2' }),
      report('t1', { technician_name: 'Dana' }),
      report('t2', { technician_name: 'Dana' }),
    ];
    expect(ids(sortReports(items, { key: 'instrument', direction: 'asc' }))).toEqual(['s2', 's10', 't1', 't2']);
    expect(ids(sortReports(items, { key: 'lab_manager', direction: 'asc' }))).toEqual(['t1', 't2', 's10', 's2']);
  });
});
