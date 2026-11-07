import { useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { type Instrument, type ReportFilters, type ReportStatus } from '../api';
import { idsInside } from '../placeUtils';
import { SavedFilters } from './SavedFilters';
import { ClearFiltersButton, DateRangeInputs, InstrumentSelect, ModelSelect, PlaceSelect, ReportTypeSelect, SearchBox, StatusSelect } from './reportFilters/FilterControls';
import { readCollapsed, writeCollapsed } from './reportFilters/collapsePreference';
import { modelsOf, summarizeFilters, type BarFilters, type ModelOption } from './reportFilters/filterSummary';
import { usePlaces } from './reportFilters/usePlaces';

// The types the bar's callers use still come from here.
export type { BarFilters, ModelOption };

const MIN_SEARCH_LENGTH = 2;
const STATUS_OPTIONS: ReportStatus[] = ['draft', 'classified', 'extracted', 'in_review', 'finalized'];

/**
 * The one filter bar of the Reports tab and the Analytics tab: saved filters, text search,
 * instrument model, instrument, report type, status, report dates and lab manager. Both tabs use this component, so
 * they cannot drift apart. Lab manager and search are typed freely, so they keep their own text and
 * reach `filters` after a short pause (a name does not fire a request per letter).
 *
 * The two tabs differ only where they must:
 * - `analytics` (status): Analytics counts finalized reports unless told otherwise, so its first
 *   status choice is "Finalized" (the default) and "All statuses" is a separate choice.
 * - `leading` / `extra`: controls only that tab has (Analytics' manufacturer, Reports' link to the
 *   instrument page), and `instrumentFilter` / `modelFilter` narrow the instrument and model
 *   lists (to the chosen maker).
 * - The instrument list also narrows to the chosen model, so the two filters never contradict.
 */
export function ReportFilterBar<F extends BarFilters>({
  filters,
  setFilters,
  instruments,
  analytics = false,
  leading,
  extra,
  instrumentFilter,
  modelFilter,
  summaryExtra = [],
  testId,
  onClear,
}: {
  filters: F;
  setFilters: Dispatch<SetStateAction<F>>;
  instruments: Instrument[];
  analytics?: boolean;
  leading?: ReactNode;
  extra?: ReactNode;
  instrumentFilter?: (instrument: Instrument) => boolean;
  /** Narrows the model list (Analytics: to the chosen maker). */
  modelFilter?: (model: ModelOption) => boolean;
  /** Summary entries for the controls only this tab has (e.g. "Manufacturer: BD"). */
  summaryExtra?: string[];
  testId?: string;
  /** Extra clean-up when "Clear filters" is pressed (the bar already resets what it owns). */
  onClear?: () => void;
}) {
  const [technicianInput, setTechnicianInput] = useState(filters.technician ?? '');
  const places = usePlaces();
  const [searchInput, setSearchInput] = useState(filters.q ?? '');
  // The filters can be folded away to leave room for the list; a one-line summary stays in their place.
  const [collapsed, setCollapsed] = useState(readCollapsed);
  function toggleCollapsed() {
    setCollapsed(!collapsed);
    writeCollapsed(!collapsed);
  }

  useEffect(() => {
    const handle = setTimeout(() => {
      // Leave the filters object alone when nothing changed (it does on every mount): a new object
      // reloads the list, which flashes the table away for no reason.
      setFilters((f) => (f.technician === (technicianInput || undefined) ? f : { ...f, technician: technicianInput || undefined }));
    }, 300);
    return () => clearTimeout(handle);
  }, [technicianInput, setFilters]);

  useEffect(() => {
    const handle = setTimeout(() => {
      const q = searchInput.trim();
      const next = q.length >= MIN_SEARCH_LENGTH ? q : undefined;
      setFilters((f) => (f.q === next ? f : { ...f, q: next }));
    }, 300);
    return () => clearTimeout(handle);
  }, [searchInput, setFilters]);

  const hasFilters = Object.values(filters).some(Boolean);
  const searchTooShort = searchInput.trim().length > 0 && searchInput.trim().length < MIN_SEARCH_LENGTH;
  const insidePlace = idsInside(places, filters.place_id);
  const byPlace = (inst: Instrument) => !insidePlace || (inst.place_id != null && insidePlace.has(inst.place_id));
  const byMaker = instrumentFilter ? instruments.filter(instrumentFilter) : instruments;
  const byModel = filters.model_id ? byMaker.filter((i) => i.model_id === filters.model_id) : byMaker;
  const shownInstruments = byModel.filter(byPlace);
  const place = places.find((p) => p.id === filters.place_id);
  // The models of the instruments we were handed (so no request of its own: this bar mounts on every
  // visit to Reports and Analytics), narrowed like the instruments.
  const models = modelsOf(instruments);
  const shownModels = models
    .filter((m) => m.id === filters.model_id || !modelFilter || modelFilter(m))
    .sort((a, b) => a.name.localeCompare(b.name));
  const statuses = analytics ? STATUS_OPTIONS.filter((s) => s !== 'finalized') : STATUS_OPTIONS;

  const instrument = instruments.find((i) => i.id === filters.instrument_id);
  const model = models.find((m) => m.id === filters.model_id);
  const summary = summarizeFilters({ filters, instrument, model, place, summaryExtra });

  function clearAll() {
    setFilters({} as F);
    setTechnicianInput('');
    setSearchInput('');
    onClear?.();
  }

  const toggle = (
    <button
      type="button"
      className="btn small filters-toggle"
      aria-expanded={!collapsed}
      onClick={toggleCollapsed}
    >
      {collapsed ? 'Show filters ▾' : 'Hide filters ▴'}
    </button>
  );

  if (collapsed) {
    return (
      <div className="filters-summary" data-testid={testId ? `${testId}-summary` : undefined}>
        {toggle}
        <span className="filters-summary-text">
          {summary.length > 0 ? summary.join(' · ') : 'No filters'}
        </span>
        {hasFilters && <ClearFiltersButton onClick={clearAll} />}
      </div>
    );
  }

  return (
    <>
      <div className="filters-summary">{toggle}</div>
      <SavedFilters
        filters={filters as ReportFilters}
        onApply={(applied) => {
          setFilters(applied as unknown as F);
          setTechnicianInput(applied.technician ?? '');
          // A saved search refills the search box too (and an empty one clears it).
          setSearchInput(applied.q ?? '');
        }}
      />

      <div className="filter-row" data-testid={testId}>
        <SearchBox value={searchInput} onChange={setSearchInput} />

        {leading}

        {places.length > 0 && <PlaceSelect filters={filters} setFilters={setFilters} instruments={instruments} places={places} />}

        <ModelSelect filters={filters} setFilters={setFilters} instruments={instruments} models={shownModels} chosenModel={model} />

        <InstrumentSelect filters={filters} setFilters={setFilters} instruments={shownInstruments} />

        <ReportTypeSelect filters={filters} setFilters={setFilters} />

        <StatusSelect filters={filters} setFilters={setFilters} analytics={analytics} statuses={statuses} />

        <DateRangeInputs filters={filters} setFilters={setFilters} />

        <input
          type="text"
          aria-label="Lab manager"
          placeholder="Lab manager"
          value={technicianInput}
          onChange={(e) => setTechnicianInput(e.target.value)}
        />

        {extra}

        {hasFilters && <ClearFiltersButton onClick={clearAll} />}
      </div>

      {searchTooShort && <div className="muted search-hint">Type at least {MIN_SEARCH_LENGTH} characters to search.</div>}
    </>
  );
}
