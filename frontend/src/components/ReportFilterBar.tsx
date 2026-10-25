import { useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import type { Instrument, ReportFilters, ReportStatus, ReportType } from '../api';
import { REPORT_TYPE_LABEL, STATUS_LABEL } from '../labels';
import { DateInput } from './DateInput';
import { SavedFilters } from './SavedFilters';

const MIN_SEARCH_LENGTH = 2;
const STATUS_OPTIONS: ReportStatus[] = ['draft', 'classified', 'extracted', 'in_review', 'finalized'];

/** The filters this bar edits: the Reports list's, with a status that may also be 'all' (Analytics). */
export type BarFilters = Omit<ReportFilters, 'status'> & { status?: string };

/**
 * The one filter bar of the Reports tab and the Analytics tab: saved filters, text search,
 * instrument, report type, status, report dates and lab manager. Both tabs use this component, so
 * they cannot drift apart. Lab manager and search are typed freely, so they keep their own text and
 * reach `filters` after a short pause (a name does not fire a request per letter).
 *
 * The two tabs differ only where they must:
 * - `analytics` (status): Analytics counts finalized reports unless told otherwise, so its first
 *   status choice is "Finalized" (the default) and "All statuses" is a separate choice.
 * - `leading` / `extra`: controls only that tab has (Analytics' manufacturer, Reports' link to the
 *   instrument page), and `instrumentFilter` narrows the instrument list (to the chosen maker).
 */
export function ReportFilterBar<F extends BarFilters>({
  filters,
  setFilters,
  instruments,
  analytics = false,
  leading,
  extra,
  instrumentFilter,
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
  testId?: string;
  /** Extra clean-up when "Clear filters" is pressed (the bar already resets what it owns). */
  onClear?: () => void;
}) {
  const [technicianInput, setTechnicianInput] = useState(filters.technician ?? '');
  const [searchInput, setSearchInput] = useState(filters.q ?? '');

  useEffect(() => {
    const handle = setTimeout(() => {
      setFilters((f) => ({ ...f, technician: technicianInput || undefined }));
    }, 300);
    return () => clearTimeout(handle);
  }, [technicianInput, setFilters]);

  useEffect(() => {
    const handle = setTimeout(() => {
      const q = searchInput.trim();
      setFilters((f) => ({ ...f, q: q.length >= MIN_SEARCH_LENGTH ? q : undefined }));
    }, 300);
    return () => clearTimeout(handle);
  }, [searchInput, setFilters]);

  const hasFilters = Object.values(filters).some(Boolean);
  const searchTooShort = searchInput.trim().length > 0 && searchInput.trim().length < MIN_SEARCH_LENGTH;
  const shownInstruments = instrumentFilter ? instruments.filter(instrumentFilter) : instruments;
  const statuses = analytics ? STATUS_OPTIONS.filter((s) => s !== 'finalized') : STATUS_OPTIONS;

  return (
    <>
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

        <DateInput
          ariaLabel="From date"
          value={filters.date_from ?? ''}
          onChange={(v) => setFilters((f) => ({ ...f, date_from: v || undefined }))}
        />
        <span className="filter-sep">to</span>
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
