import { createContext, useContext, useEffect } from 'react';
import type { ReportFilters } from './api';
import { sameFilters, type KeptSearch } from './keptSearch';

export interface KeptSearchApi {
  /** The search in force, or null. */
  kept: KeptSearch | null;
  /** True while a stored search that names an instrument, model or place is checked against the data. */
  checking: boolean;
  /** Set when the check found that what the stored search named is gone, so it was dropped. */
  notice: string | null;
  save: (search: KeptSearch) => void;
  clear: () => void;
  dismissNotice: () => void;
}

// Outside the provider (a component used on its own) nothing is kept and nothing is checked.
const NOTHING: KeptSearchApi = { kept: null, checking: false, notice: null, save: () => undefined, clear: () => undefined, dismissNotice: () => undefined };
export const KeptSearchContext = createContext<KeptSearchApi>(NOTHING);

export function useKeptSearch(): KeptSearchApi {
  return useContext(KeptSearchContext);
}

/**
 * For a screen that shows filters: once they stop matching the kept search (the person changed one, pressed Clear
 * or applied a saved filter), the kept search no longer describes what is on screen, so it is dropped.
 */
export function useDropKeptSearchWhenFiltersChange(filters: ReportFilters): void {
  const { kept, clear } = useKeptSearch();
  useEffect(() => {
    if (kept && !sameFilters(kept.filters, filters)) clear();
  }, [kept, filters, clear]);
}
