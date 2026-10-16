import { useEffect, useState } from 'react';
import {
  listReports,
  reportsExportUrl,
  type Instrument,
  type ReportFilters,
  type ReportListItem,
  type ReportStatus,
  type ReportType,
} from '../api';
import { useAsyncEffect } from '../hooks/useAsyncEffect';
import { REPORT_TYPE_LABEL, STATUS_LABEL } from '../labels';
import { InstrumentDetailScreen } from './InstrumentDetailScreen';
import { ReportDetailScreen } from './ReportDetailScreen';
import { SavedFilters } from './SavedFilters';
import { nextSort, SORT_LABEL, sortReports, type SortKey, type SortState } from '../reportSort';

const STATUS_OPTIONS: ReportStatus[] = ['draft', 'classified', 'extracted', 'in_review', 'finalized'];

// The reports list, one report's detail, and one instrument's detail are
// three screens sharing this one tab — a small nav stack (rather than three
// independent booleans) so "back" from a report opened via the instrument
// page returns to that instrument page, not all the way out to the list.
type ReportsScreen =
  | { kind: 'list' }
  | { kind: 'instrument'; instrumentId: string }
  | {
      kind: 'report';
      item: ReportListItem;
      returnTo: { kind: 'list' } | { kind: 'instrument'; instrumentId: string };
      /** The search text the report was opened from; its matches are highlighted on the report screen. */
      highlight?: string;
    };

// Free-text search needs at least this many characters (the backend refuses less).
const MIN_SEARCH_LENGTH = 2;

export function ReportsListScreen({
  instruments,
  fieldConfidenceThreshold,
  openReportId = null,
  onOpenReportHandled,
}: {
  instruments: Instrument[];
  fieldConfidenceThreshold: number;
  /** A report to open straight away (e.g. the existing copy of a file that was just refused as already on file). */
  openReportId?: string | null;
  onOpenReportHandled?: () => void;
}) {
  const [filters, setFilters] = useState<ReportFilters>({});
  // Lab manager is free text (§4: typed at intake, not a dropdown), so it gets
  // its own local state that updates on every keystroke for a responsive
  // input, debounced into `filters` — the actual fetch trigger below — so
  // "Jane Smith" doesn't fire nine separate /reports requests as it's typed.
  const [technicianInput, setTechnicianInput] = useState(filters.technician ?? '');
  // Free-text search: same debounce idea, and only sent once it is long enough.
  const [searchInput, setSearchInput] = useState(filters.q ?? '');
  const [items, setItems] = useState<ReportListItem[]>([]);
  // Column the table is sorted by (null: the server's order). Sorting is done here, on the rows already loaded.
  const [sort, setSort] = useState<SortState | null>(null);
  const [screen, setScreen] = useState<ReportsScreen>({ kind: 'list' });
  // `items` lives here, and this component stays mounted while a report is
  // open, so the list doesn't refetch on its own when the technician comes
  // back — and a save/finalize inside ReportDetailScreen only updates that
  // screen's own state. Bumped on every way out of a report (see
  // leaveReport) so the list shows the report's new status instead of the
  // pre-save one. InstrumentDetailScreen needs nothing extra: it's unmounted
  // while a report is open and fetches fresh when it mounts again.
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    const handle = setTimeout(() => {
      setFilters((f) => ({ ...f, technician: technicianInput || undefined }));
    }, 300);
    return () => clearTimeout(handle);
  }, [technicianInput]);

  useEffect(() => {
    const handle = setTimeout(() => {
      const q = searchInput.trim();
      setFilters((f) => ({ ...f, q: q.length >= MIN_SEARCH_LENGTH ? q : undefined }));
    }, 300);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const { loading, error } = useAsyncEffect(
    async (isCancelled) => {
      const list = await listReports(filters);
      if (!isCancelled()) setItems(list);
    },
    [filters, refreshNonce],
    'Could not load reports.'
  );

  // Open a report handed down from elsewhere in the app. The list endpoint
  // gives the full list item the detail screen takes; unfiltered, so the
  // current filters can't hide it.
  useEffect(() => {
    if (!openReportId) return;
    let cancelled = false;
    listReports({})
      .then((all) => {
        const item = all.find((r) => r.id === openReportId);
        if (!cancelled && item) setScreen({ kind: 'report', item, returnTo: { kind: 'list' } });
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) onOpenReportHandled?.();
      });
    return () => {
      cancelled = true;
    };
  }, [openReportId, onOpenReportHandled]);

  function leaveReport(next: ReportsScreen) {
    setRefreshNonce((n) => n + 1);
    setScreen(next);
  }

  if (screen.kind === 'report') {
    return (
      <ReportDetailScreen
        key={screen.item.id}
        item={screen.item}
        instruments={instruments}
        onBack={() => leaveReport(screen.returnTo)}
        onDeleted={() => leaveReport(screen.returnTo)}
        onOpenReport={(other) => setScreen({ kind: 'report', item: other, returnTo: screen.returnTo })}
        onViewInstrument={(instrumentId) => leaveReport({ kind: 'instrument', instrumentId })}
        fieldConfidenceThreshold={fieldConfidenceThreshold}
        highlight={screen.highlight}
      />
    );
  }

  if (screen.kind === 'instrument') {
    const instrumentId = screen.instrumentId;
    return (
      <InstrumentDetailScreen
        instrumentId={instrumentId}
        instruments={instruments}
        onBack={() => setScreen({ kind: 'list' })}
        onOpenReport={(item) => setScreen({ kind: 'report', item, returnTo: { kind: 'instrument', instrumentId } })}
      />
    );
  }

  const hasFilters = Boolean(
    filters.instrument_id ||
      filters.report_type ||
      filters.status ||
      filters.date_from ||
      filters.date_to ||
      filters.technician ||
      filters.q
  );
  const searching = Boolean(filters.q);
  const shown = sortReports(items, sort);
  const searchTooShort = searchInput.trim().length > 0 && searchInput.trim().length < MIN_SEARCH_LENGTH;
  // Search covers finalized reports only, so another status filter can only be empty.
  const statusBlocksSearch = searching && Boolean(filters.status) && filters.status !== 'finalized';

  return (
    <div className="section">
      <div className="section-title">Reports</div>

      <SavedFilters
        filters={filters}
        onApply={(applied) => {
          setFilters(applied);
          setTechnicianInput(applied.technician ?? '');
          // A saved search refills the search box too (and an empty one clears it).
          setSearchInput(applied.q ?? '');
        }}
      />

      <div className="filter-row">
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

        <select
          value={filters.instrument_id ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, instrument_id: e.target.value || undefined }))}
        >
          <option value="">All instruments</option>
          {instruments.map((inst) => (
            <option key={inst.id} value={inst.id}>
              {inst.model} ({inst.serial_number})
            </option>
          ))}
        </select>

        <select
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
          value={filters.status ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, status: (e.target.value || undefined) as ReportStatus | undefined }))}
        >
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>

        <input
          type="date"
          aria-label="From date"
          value={filters.date_from ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, date_from: e.target.value || undefined }))}
        />
        <span className="filter-sep">to</span>
        <input
          type="date"
          aria-label="To date"
          value={filters.date_to ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, date_to: e.target.value || undefined }))}
        />

        <input
          type="text"
          aria-label="Lab manager"
          placeholder="Lab manager"
          value={technicianInput}
          onChange={(e) => setTechnicianInput(e.target.value)}
        />

        {filters.instrument_id && (
          <button
            className="btn small"
            onClick={() => setScreen({ kind: 'instrument', instrumentId: filters.instrument_id! })}
          >
            View instrument details →
          </button>
        )}

        {hasFilters && (
          <button
            className="btn small"
            onClick={() => {
              setFilters({});
              setTechnicianInput('');
              setSearchInput('');
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {searchTooShort && <div className="muted search-hint">Type at least {MIN_SEARCH_LENGTH} characters to search.</div>}
      {error && <div className="banner banner-warn">{error}</div>}

      {loading ? (
        <div className="working-panel">
          <div className="spinner" />
          <div>Loading reports…</div>
        </div>
      ) : items.length === 0 ? (
        <div className="empty-hint" data-testid="empty-hint">
          {statusBlocksSearch
            ? 'Search covers finalized reports only. Set the status filter to Finalized or clear it.'
            : searching
              ? `No finalized reports contain “${filters.q}” with these filters.`
              : 'No reports match these filters.'}
        </div>
      ) : (
        <>
          <div className="table-toolbar">
            <span className="table-toolbar-count" data-testid="result-count">
              {searching
                ? `${items.length} finalized report${items.length === 1 ? '' : 's'} match “${filters.q}” · ${
                    sort ? `sorted by ${SORT_LABEL[sort.key].toLowerCase()}` : 'best match first'
                  }`
                : `${items.length} report${items.length === 1 ? '' : 's'}${
                    sort ? ` · sorted by ${SORT_LABEL[sort.key].toLowerCase()}` : ''
                  }`}
            </span>
            <a className="btn small" href={reportsExportUrl(filters)}>
              ⬇ Export CSV
            </a>
          </div>
          <div className="report-table">
            <div className="report-row report-row-head">
              {(Object.keys(SORT_LABEL) as SortKey[]).map((key) => {
                const active = sort?.key === key ? sort.direction : null;
                return (
                  <button
                    key={key}
                    type="button"
                    className={`sort-head${active ? ' sort-head-active' : ''}`}
                    data-sort={active ?? 'none'}
                    data-testid={`sort-${key}`}
                    title={`Sort by ${SORT_LABEL[key].toLowerCase()}`}
                    aria-label={`Sort by ${SORT_LABEL[key].toLowerCase()}${
                      active ? `, currently ${active === 'asc' ? 'ascending' : 'descending'}` : ''
                    }`}
                    onClick={() => setSort((cur) => nextSort(cur, key))}
                  >
                    {SORT_LABEL[key]}
                    <span className="sort-arrow" aria-hidden="true">
                      {active === 'asc' ? '▲' : active === 'desc' ? '▼' : ''}
                    </span>
                  </button>
                );
              })}
            </div>
            {shown.map((r) => (
              <button
                className="report-row report-row-body"
                key={r.id}
                onClick={() => setScreen({ kind: 'report', item: r, returnTo: { kind: 'list' }, highlight: filters.q })}
              >
                <span>
                  {r.instrument_model ?? '—'}
                  {r.instrument_serial_number ? ` (${r.instrument_serial_number})` : ''}
                </span>
                <span>{r.report_type ? REPORT_TYPE_LABEL[r.report_type] : '—'}</span>
                <span>{r.technician_name ?? '—'}</span>
                <span>{r.report_date ?? '—'}</span>
                <span className={`status-pill status-${r.status}`}>{STATUS_LABEL[r.status]}</span>
                {r.snippet && r.snippet.length > 0 && (
                  <span className="report-excerpt" data-testid="excerpt">
                    {r.matched_field && <span className="excerpt-field">{r.matched_field}: </span>}
                    {r.snippet.map((piece, i) =>
                      piece.matched ? <mark key={i}>{piece.text}</mark> : <span key={i}>{piece.text}</span>
                    )}
                  </span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
