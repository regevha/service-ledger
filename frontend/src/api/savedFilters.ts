import { apiFetch } from './http';
import type { ReportFilters } from './reports';

// ---------- Saved report filters ----------

// A named combination of the Reports list's six filters, shared by everyone
// (at most `cap` exist). `filters` holds only the criteria that were set.
export interface SavedFilter {
  id: string;
  name: string;
  filters: ReportFilters;
  created_at: string;
  /** A saved instrument, model or place no longer exists. */
  stale: boolean;
  /** Which saved criteria point at something that is gone. */
  stale_keys: ('instrument_id' | 'model_id' | 'place_id')[];
}

export interface SavedFilterList {
  items: SavedFilter[];
  cap: number;
}

/** The server keeps the number of a condition as a number; the filters here hold it as text, like every other value. */
function fromServer(saved: SavedFilter): SavedFilter {
  const value = (saved.filters as { number_value?: unknown }).number_value;
  return value === undefined || value === null ? saved : { ...saved, filters: { ...saved.filters, number_value: String(value) } };
}

export function listSavedFilters(): Promise<SavedFilterList> {
  return apiFetch<SavedFilterList>('/saved-report-filters').then((list) => ({ ...list, items: list.items.map(fromServer) }));
}

export function createSavedFilter(name: string, filters: ReportFilters): Promise<SavedFilter> {
  const body = { name, filters: filters.number_value ? { ...filters, number_value: Number(filters.number_value) } : filters };
  return apiFetch<SavedFilter>('/saved-report-filters', { method: 'POST', body: JSON.stringify(body) }).then(fromServer);
}

export function deleteSavedFilter(id: string): Promise<void> {
  return apiFetch(`/saved-report-filters/${id}`, { method: 'DELETE' });
}
