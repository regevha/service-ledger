import type { ReportListItem, ReportStatus } from './api';
import { REPORT_TYPE_LABEL } from './labels';

// Sorting for the Reports table. The list endpoint returns every matching
// report (no paging), so the screen sorts what it already has; the server's own
// order (newest first, or best match first while searching) is the default and
// is restored by clearing the sort.

export type SortKey = 'instrument' | 'type' | 'lab_manager' | 'date' | 'status';
export type SortDirection = 'asc' | 'desc';
export interface SortState {
  key: SortKey;
  direction: SortDirection;
}

export const SORT_LABEL: Record<SortKey, string> = {
  instrument: 'Instrument',
  type: 'Type',
  lab_manager: 'Lab manager',
  date: 'Report date',
  status: 'Status',
};

// Status sorts by how far along the report is, not alphabetically.
const STATUS_ORDER: ReportStatus[] = ['draft', 'classified', 'extracted', 'in_review', 'finalized'];

/** What a row is compared by for this column; null means the cell is empty. */
function sortValue(r: ReportListItem, key: SortKey): string | number | null {
  const text = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
  switch (key) {
    case 'instrument':
      return text(r.instrument_model ? `${r.instrument_model} ${r.instrument_serial_number ?? ''}` : null);
    case 'type':
      return r.report_type ? REPORT_TYPE_LABEL[r.report_type] : null;
    case 'lab_manager':
      return text(r.technician_name);
    case 'date':
      return text(r.report_date); // YYYY-MM-DD, so text order is date order
    case 'status': {
      const i = STATUS_ORDER.indexOf(r.status);
      return i === -1 ? null : i;
    }
  }
}

/** The next sort after clicking a column: ascending, then descending, then none. */
export function nextSort(current: SortState | null, key: SortKey): SortState | null {
  if (!current || current.key !== key) return { key, direction: 'asc' };
  if (current.direction === 'asc') return { key, direction: 'desc' };
  return null;
}

/**
 * The order the list shows when nothing is sorted and nothing was searched:
 * newest report date first, a report with no date (a draft, or a form that
 * carries none) by the day it was uploaded, and the later upload first on a tie.
 * Without this the order was whatever the server returned, which is arbitrary
 * for reports uploaded together (seeded or batch uploads share one timestamp).
 */
export function defaultOrder(items: ReportListItem[]): ReportListItem[] {
  const day = (r: ReportListItem) => r.report_date ?? r.created_at.slice(0, 10);
  return [...items].sort((a, b) => {
    const d = day(b).localeCompare(day(a));
    if (d !== 0) return d;
    const c = b.created_at.localeCompare(a.created_at);
    return c !== 0 ? c : a.id.localeCompare(b.id);
  });
}

/**
 * A sorted copy of `items`. Empty cells always go last, in either direction;
 * rows that compare equal keep the order they came in. With no sort the list is
 * returned as it is.
 */
export function sortReports(items: ReportListItem[], sort: SortState | null): ReportListItem[] {
  if (!sort) return items;
  const sign = sort.direction === 'asc' ? 1 : -1;
  return items
    .map((item, index) => ({ item, index, value: sortValue(item, sort.key) }))
    .sort((a, b) => {
      if (a.value === null || b.value === null) {
        if (a.value === b.value) return a.index - b.index;
        return a.value === null ? 1 : -1;
      }
      const order =
        typeof a.value === 'number' && typeof b.value === 'number'
          ? a.value - b.value
          : String(a.value).localeCompare(String(b.value), undefined, { numeric: true, sensitivity: 'base' });
      return order !== 0 ? order * sign : a.index - b.index;
    })
    .map((x) => x.item);
}
