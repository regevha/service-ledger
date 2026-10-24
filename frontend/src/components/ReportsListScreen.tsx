import { useEffect, useRef, useState } from 'react';
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
import { DateInput } from './DateInput';
import { SavedFilters } from './SavedFilters';
import { defaultOrder, nextSort, SORT_LABEL, sortReports, type SortKey, type SortState } from '../reportSort';

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

function screenPath(screen: ReportsScreen): string {
  return screen.kind === 'list' ? '' : screen.kind === 'instrument' ? `instrument/${screen.instrumentId}` : screen.item.id;
}

// Free-text search needs at least this many characters (the backend refuses less).
const MIN_SEARCH_LENGTH = 2;

/** An upload that was never classified: it has no instrument or type to show yet. */
function isUnread(r: ReportListItem): boolean {
  return r.status !== 'finalized' && !r.instrument_model && !r.report_type;
}

export function ReportsListScreen({
  instruments,
  fieldConfidenceThreshold,
  path = '',
  onPath,
}: {
  instruments: Instrument[];
  fieldConfidenceThreshold: number;
  /** What the address bar says is open on this tab: '' (the list), '<report id>' or 'instrument/<id>'. */
  path?: string;
  /** Called when the person opens or leaves a report or instrument, so the address bar can follow. */
  onPath?: (path: string) => void;
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

  // The address bar and this screen's own nav stack follow each other: opening a report
  // or instrument here updates the path; a path set elsewhere (the Back button, a link,
  // the intake flow's "Open report") opens that screen.
  const current = screenPath(screen);
  const lastCurrent = useRef(current);
  useEffect(() => {
    if (path === current) return;
    if (path === '') {
      setScreen({ kind: 'list' });
      return;
    }
    if (path.startsWith('instrument/')) {
      setScreen({ kind: 'instrument', instrumentId: path.slice('instrument/'.length) });
      return;
    }
    // The list endpoint gives the full list item the detail screen takes; unfiltered,
    // so the current filters can't hide it.
    let cancelled = false;
    listReports({})
      .then((all) => {
        if (cancelled) return;
        const item = all.find((r) => r.id === path);
        if (item) setScreen({ kind: 'report', item, returnTo: { kind: 'list' } });
        else onPath?.('');
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // Only a new path from outside should open something; `current` changing is the other effect's business.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  useEffect(() => {
    // Only a real change of screen counts: a screen opened from a link must not be reset to the
    // list while it is still loading (this effect also runs once on mount).
    if (lastCurrent.current === current) return;
    lastCurrent.current = current;
    onPath?.(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

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
  // Best match first only means something for a search; otherwise the newest report leads.
  const shown = sort || searching ? sortReports(items, sort) : defaultOrder(items);
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
                <span data-label="Instrument">
                  {r.instrument_model ?? (isUnread(r) ? 'Not read yet' : '—')}
                  {r.instrument_serial_number ? ` (${r.instrument_serial_number})` : ''}
                </span>
                <span data-label="Report type">{r.report_type ? REPORT_TYPE_LABEL[r.report_type] : '—'}</span>
                <span data-label="Lab manager">{r.technician_name ?? '—'}</span>
                <span data-label="Report date">
                  {r.report_date ??
                    (isUnread(r) ? <span className="muted">uploaded {r.created_at.slice(0, 10)}</span> : '—')}
                </span>
                <span data-label="Status">
                  <span className={`status-pill status-${r.status}`}>{STATUS_LABEL[r.status]}</span>
                </span>
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
