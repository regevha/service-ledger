import { createContext, useContext, useEffect, useRef } from 'react';
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
  /** Takes one condition (one chip) out of the search; the last one takes the whole search. */
  removeCondition: (key: string) => void;
  clear: () => void;
  dismissNotice: () => void;
}

// Outside the provider (a component used on its own) nothing is kept and nothing is checked.
const NOTHING: KeptSearchApi = {
  kept: null,
  checking: false,
  notice: null,
  save: () => undefined,
  removeCondition: () => undefined,
  clear: () => undefined,
  dismissNotice: () => undefined,
};
export const KeptSearchContext = createContext<KeptSearchApi>(NOTHING);

export function useKeptSearch(): KeptSearchApi {
  return useContext(KeptSearchContext);
}

/**
 * Keeps a screen that shows filters in step with the kept search, in both directions.
 *
 * - The search was changed from outside this screen (a chip removed or Clear on the line at the top, a new question
 *   on another screen): the screen takes on the filters of the new search, or none if it is gone (`adopt`).
 * - The screen's own filters moved away from the kept search (a hand edit, Clear filters, a saved filter): the kept
 *   search no longer describes what is on screen, so it is dropped.
 */
export function useKeptSearchSync(filters: ReportFilters, adopt: (next: ReportFilters) => void): void {
  const { kept, clear } = useKeptSearch();
  // The kept search this screen has already matched itself to.
  const seen = useRef(kept);
  useEffect(() => {
    if (kept === seen.current) {
      if (kept && !sameFilters(kept.filters, filters)) {
        // Set first: the search going away is then this screen's own doing, not news to follow.
        seen.current = null;
        clear();
      }
      return;
    }
    seen.current = kept;
    const next = kept ? kept.filters : {};
    if (!sameFilters(next, filters)) adopt(next);
  }, [kept, filters, clear, adopt]);
}
