import { useState } from 'react';
import type { Instrument, MaintenanceState, Place } from '../api';
import { idsInside } from '../placeUtils';

/**
 * The Instruments list's three filters (place, model, maintenance) and the
 * rows they leave. The pickers narrow each other: Model lists only models that
 * have an instrument in the chosen place, Place lists only places that hold an
 * instrument of the chosen model. A choice that no longer fits counts as
 * "all", so the list is never empty because of a stale choice.
 */
export function useInstrumentFilters(instruments: Instrument[], allPlaces: Place[]) {
  const [stateFilter, setStateFilter] = useState<'all' | MaintenanceState>('all');
  const [modelFilter, setModelFilter] = useState('all');
  const [placeFilter, setPlaceFilter] = useState('');

  const inPlace = (i: Instrument, ids: Set<string> | null) => !ids || (i.place_id != null && ids.has(i.place_id));
  const insideRaw = idsInside(allPlaces, placeFilter || undefined);
  const modelOptions = Array.from(
    new Map(
      instruments.filter((i) => i.model_id && inPlace(i, insideRaw)).map((i) => [i.model_id as string, i.model])
    ).entries()
  ).sort((a, b) => a[1].localeCompare(b[1]));
  const activeModel = modelOptions.some(([id]) => id === modelFilter) ? modelFilter : 'all';
  const modelMatches = instruments.filter((i) => activeModel === 'all' || i.model_id === activeModel);
  const placeOptions = allPlaces.filter((p) => {
    const ids = idsInside(allPlaces, p.id);
    return modelMatches.some((i) => inPlace(i, ids));
  });
  const activePlace = !placeFilter || placeOptions.some((p) => p.id === placeFilter) ? placeFilter : '';
  const insidePlace = idsInside(allPlaces, activePlace || undefined);
  const shownInstruments = modelMatches
    .filter((i) => stateFilter === 'all' || i.maintenance_state === stateFilter)
    .filter((i) => inPlace(i, insidePlace));
  const filtersActive = stateFilter !== 'all' || activeModel !== 'all' || activePlace !== '';
  function clearFilters() {
    setStateFilter('all');
    setModelFilter('all');
    setPlaceFilter('');
  }

  return {
    stateFilter,
    setStateFilter,
    setModelFilter,
    setPlaceFilter,
    modelOptions,
    activeModel,
    placeOptions,
    activePlace,
    shownInstruments,
    filtersActive,
    clearFilters,
  };
}
