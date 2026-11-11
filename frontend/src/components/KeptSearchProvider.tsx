import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { listInstrumentModels, listInstruments, listPlaces } from '../api';
import {
  clearKeptSearch,
  criteriaOf,
  goneKeys,
  goneNotice,
  hasCriteria,
  readKeptSearch,
  recordKeysOf,
  withoutCondition,
  writeKeptSearch,
  type GoneKey,
  type KeptSearch,
} from '../keptSearch';
import { KeptSearchContext, useKeptSearch } from '../keptSearchContext';

/** The ids that still exist for each kind of record the stored search names. Nothing is fetched for a kind it does not name. */
async function existingIds(keys: readonly GoneKey[]): Promise<Partial<Record<GoneKey, ReadonlySet<string>>>> {
  const [instruments, models, places] = await Promise.all([
    keys.includes('instrument_id') ? listInstruments() : undefined,
    keys.includes('model_id') ? listInstrumentModels() : undefined,
    keys.includes('place_id') ? listPlaces() : undefined,
  ]);
  const existing: Partial<Record<GoneKey, ReadonlySet<string>>> = {};
  if (instruments) existing.instrument_id = new Set(instruments.map((i) => i.id));
  if (models) existing.model_id = new Set(models.map((m) => m.id));
  if (places) existing.place_id = new Set(places.map((p) => p.id));
  return existing;
}

/**
 * Holds the one search the person asked for in plain words, for every screen. It starts from the browser's
 * storage, so a reload keeps it. A stored search that names an instrument, model or place is checked once
 * before screens use it: if any of them was deleted since, the search is dropped with a short notice instead
 * of filtering by something that is not there. If the check cannot be made (offline), the search is kept.
 */
export function KeptSearchProvider({ children }: { children: ReactNode }) {
  const [stored] = useState(readKeptSearch);
  const [kept, setKept] = useState<KeptSearch | null>(stored);
  const [checking, setChecking] = useState(() => stored !== null && recordKeysOf(stored.filters).length > 0);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!stored) return;
    const keys = recordKeysOf(stored.filters);
    if (keys.length === 0) return;
    let live = true;
    existingIds(keys)
      .then((existing) => {
        if (!live) return;
        const gone = goneKeys(stored.filters, existing);
        if (gone.length === 0) return;
        clearKeptSearch();
        setKept((current) => (current === stored ? null : current));
        setNotice(goneNotice(gone));
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setChecking(false);
      });
    return () => {
      live = false;
    };
    // Once, on opening the app: `stored` is what the browser held at that moment.
  }, [stored]);

  const save = useCallback((search: KeptSearch) => {
    writeKeptSearch(search);
    const filters = criteriaOf(search.filters);
    setKept(search.text.trim() && hasCriteria(filters) ? { ...search, filters } : null);
    setNotice(null);
  }, []);
  const clear = useCallback(() => {
    clearKeptSearch();
    setKept(null);
  }, []);
  const removeCondition = useCallback(
    (key: string) => {
      if (!kept) return;
      const next = withoutCondition(kept, key);
      if (next) save(next);
      else clear();
    },
    [kept, save, clear]
  );
  const dismissNotice = useCallback(() => setNotice(null), []);

  const value = useMemo(
    () => ({ kept, checking, notice, save, removeCondition, clear, dismissNotice }),
    [kept, checking, notice, save, removeCondition, clear, dismissNotice]
  );
  return <KeptSearchContext.Provider value={value}>{children}</KeptSearchContext.Provider>;
}

/** Holds back a screen that starts from the kept search until it has been checked, so it never loads with a deleted id. */
export function KeptSearchGate({ children }: { children: ReactNode }) {
  const { checking } = useKeptSearch();
  if (checking) {
    return (
      <div className="working-panel" data-testid="kept-search-checking">
        <div className="spinner" />
        <div>Loading…</div>
      </div>
    );
  }
  return <>{children}</>;
}
