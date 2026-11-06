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

export function listSavedFilters(): Promise<SavedFilterList> {
  return apiFetch('/saved-report-filters');
}

export function createSavedFilter(name: string, filters: ReportFilters): Promise<SavedFilter> {
  return apiFetch('/saved-report-filters', { method: 'POST', body: JSON.stringify({ name, filters }) });
}

export function deleteSavedFilter(id: string): Promise<void> {
  return apiFetch(`/saved-report-filters/${id}`, { method: 'DELETE' });
}
