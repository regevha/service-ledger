import { useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { listPlaces, type Instrument, type Place, type ReportFilters, type ReportStatus, type ReportType } from '../api';
import { REPORT_TYPE_LABEL, STATUS_LABEL } from '../labels';
import { idsInside, placeLabel } from '../placeUtils';
import { DateInput } from './DateInput';
import { SavedFilters } from './SavedFilters';

const MIN_SEARCH_LENGTH = 2;
const COLLAPSE_KEY = 'sl.filters.collapsed';

// Per-viewer convenience only (shared by both tabs): browser storage can be empty or throw.
function readCollapsed(): boolean {
  try {
    const saved = localStorage.getItem(COLLAPSE_KEY);
    if (saved === 'yes') return true;
    if (saved === 'no') return false;
  } catch {
    /* fall through to the default */
  }
  // Never chosen: folded on a phone, so the list is on the first screen; open elsewhere.
  return typeof window !== 'undefined' && window.matchMedia?.('(max-width: 620px)').matches === true;
}
function writeCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? 'yes' : 'no');
  } catch {
    /* not remembered; nothing else depends on it */
  }
}
const STATUS_OPTIONS: ReportStatus[] = ['draft', 'classified', 'extracted', 'in_review', 'finalized'];

/** A model as this bar knows it: one per model record that has instruments in the list it is given. */
export type ModelOption = { id: string; name: string; manufacturer: string | null };

function modelsOf(instruments: Instrument[]): ModelOption[] {
  const byId = new Map<string, ModelOption>();
  for (const i of instruments) {
    if (i.model_id && !byId.has(i.model_id)) byId.set(i.model_id, { id: i.model_id, name: i.model, manufacturer: i.manufacturer });
  }
  return [...byId.values()];
}

/** The filters this bar edits: the Reports list's, with a status that may also be 'all' (Analytics). */
export type BarFilters = Omit<ReportFilters, 'status'> & { status?: string };

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
  // Institutions, faculties and rooms to filter by (an empty list hides the control).
  const [places, setPlaces] = useState<Place[]>([]);
  useEffect(() => {
    let live = true;
    listPlaces()
      .then((p) => live && setPlaces(p))
      .catch(() => live && setPlaces([]));
    return () => {
      live = false;
    };
  }, []);
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
  const byMaker = (instrumentFilter ? instruments.filter(instrumentFilter) : instruments).filter(byPlace);
  const shownInstruments = filters.model_id ? byMaker.filter((i) => i.model_id === filters.model_id) : byMaker;
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
  const statusText = filters.status === 'all' ? 'All statuses' : filters.status ? STATUS_LABEL[filters.status as ReportStatus] : '';
  const dates =
    filters.date_from && filters.date_to
      ? `${filters.date_from} to ${filters.date_to}`
      : filters.date_from
        ? `from ${filters.date_from}`
        : filters.date_to
          ? `until ${filters.date_to}`
          : '';
  const summary = [
    filters.q ? `“${filters.q}”` : '',
    ...summaryExtra,
    place ? placeLabel(place) : '',
    model ? model.name : '',
    instrument ? `${instrument.model} (${instrument.serial_number})` : '',
    filters.report_type ? REPORT_TYPE_LABEL[filters.report_type] : '',
    statusText,
    dates,
    filters.technician ? `Lab manager: ${filters.technician}` : '',
  ].filter(Boolean);

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
        {hasFilters && (
          <button
            type="button"
            className="btn small"
            onClick={() => {
              setFilters({} as F);
              setTechnicianInput('');
              setSearchInput('');
              onClear?.();
            }}
          >
            Clear filters
          </button>
        )}
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
        <span className="search-box">
          <input
            type="search"
            aria-label="Search reports"
            placeholder="Search report text…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            title='Finds finalized reports containing all the words. Use "quotes" for an exact phrase and a minus sign to leave a word out. Numbers are not searched.'
          />
          {searchInput && (
            <button type="button" className="btn small" aria-label="Clear search" onClick={() => setSearchInput('')}>
              ×
            </button>
          )}
        </span>

        {leading}

        {places.length > 0 && (
          <select
            aria-label="Place"
            value={filters.place_id ?? ''}
            onChange={(e) =>
              setFilters((f) => {
                const kept = instruments.find((i) => i.id === f.instrument_id);
                const next = e.target.value || undefined;
                const inside = idsInside(places, next);
                // An instrument outside the newly chosen place cannot stay chosen.
                const clash = next && kept && !(kept.place_id != null && inside?.has(kept.place_id));
                return { ...f, place_id: next, instrument_id: clash ? undefined : f.instrument_id };
              })
            }
          >
            <option value="">All places</option>
            {places.map((p) => (
              <option key={p.id} value={p.id}>
                {placeLabel(p)}
              </option>
            ))}
          </select>
        )}

        <select
          aria-label="Model"
          value={filters.model_id ?? ''}
          onChange={(e) => {
            const model_id = e.target.value || undefined;
            // Drop a chosen instrument that is not of this model, so the two never contradict.
            setFilters((f) => {
              const kept = instruments.find((i) => i.id === f.instrument_id);
              const clash = model_id && kept && kept.model_id !== model_id;
              return { ...f, model_id, instrument_id: clash ? undefined : f.instrument_id };
            });
          }}
        >
          <option value="">All models</option>
          {filters.model_id && !model && <option value={filters.model_id}>(model no longer in use)</option>}
          {shownModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>

        <select
          aria-label="Instrument"
          value={filters.instrument_id ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, instrument_id: e.target.value || undefined }))}
        >
          <option value="">All instruments</option>
          {shownInstruments.map((inst) => (
            <option key={inst.id} value={inst.id}>
              {inst.model} ({inst.serial_number})
            </option>
          ))}
        </select>

        <select
          aria-label="Report type"
          value={filters.report_type ?? ''}
          onChange={(e) =>
            setFilters((f) => ({ ...f, report_type: (e.target.value || undefined) as ReportType | undefined }))
          }
        >
          <option value="">All report types</option>
          {(Object.keys(REPORT_TYPE_LABEL) as ReportType[]).map((rt) => (
            <option key={rt} value={rt}>
              {REPORT_TYPE_LABEL[rt]}
            </option>
          ))}
        </select>

        <select
          aria-label="Status"
          value={filters.status ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value || undefined }))}
        >
          {analytics ? (
            <>
              <option value="">Finalized</option>
              <option value="all">All statuses</option>
            </>
          ) : (
            <option value="">All statuses</option>
          )}
          {statuses.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>

        <span className="date-pair-label" aria-hidden="true">
          From
        </span>
        <DateInput
          ariaLabel="From date"
          value={filters.date_from ?? ''}
          onChange={(v) => setFilters((f) => ({ ...f, date_from: v || undefined }))}
        />
        <span className="filter-sep">to</span>
        <span className="date-pair-label" aria-hidden="true">
          To
        </span>
        <DateInput
          ariaLabel="To date"
          value={filters.date_to ?? ''}
          onChange={(v) => setFilters((f) => ({ ...f, date_to: v || undefined }))}
        />

        <input
          type="text"
          aria-label="Lab manager"
          placeholder="Lab manager"
          value={technicianInput}
          onChange={(e) => setTechnicianInput(e.target.value)}
        />

        {extra}

        {hasFilters && (
          <button
            type="button"
            className="btn small"
            onClick={() => {
              setFilters({} as F);
              setTechnicianInput('');
              setSearchInput('');
              onClear?.();
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {searchTooShort && <div className="muted search-hint">Type at least {MIN_SEARCH_LENGTH} characters to search.</div>}
    </>
  );
}
