import { useEffect, useRef, useState } from 'react';
import {
  listReports,
  type Instrument,
  type ReportFilters,
  type ReportListItem,
  type ReportStatus,
} from '../api';
import { useAsyncEffect } from '../hooks/useAsyncEffect';
import { REPORT_TYPE_LABEL, STATUS_LABEL } from '../labels';
import { InstrumentDetailScreen } from './InstrumentDetailScreen';
import { ReportDetailScreen } from './ReportDetailScreen';
import { ReportFilterBar } from './ReportFilterBar';
import { defaultOrder, nextSort, SORT_LABEL, sortReports, type SortKey, type SortState } from '../reportSort';

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

type GroupMode = 'instrument' | 'none';
const GROUP_KEY = 'sl.reports.group';

// Per-viewer convenience only: browser storage can be empty or throw.
function readGroupMode(): GroupMode {
  try {
    return localStorage.getItem(GROUP_KEY) === 'none' ? 'none' : 'instrument';
  } catch {
    return 'instrument';
  }
}
function writeGroupMode(mode: GroupMode) {
  try {
    localStorage.setItem(GROUP_KEY, mode);
  } catch {
    /* not remembered; nothing else depends on it */
  }
}

/** Reports of one instrument (or of the uploads that have no instrument yet), newest first. */
interface ReportGroup {
  key: string;
  title: string;
  serial: string | null;
  instrument: Instrument | null;
  items: ReportListItem[];
  needsReview: number;
}

function groupByInstrument(items: ReportListItem[], instruments: Instrument[]): ReportGroup[] {
  const byKey = new Map<string, ReportGroup>();
  for (const r of items) {
    const key = r.instrument_model || r.instrument_serial_number ? `${r.instrument_model ?? ''}|${r.instrument_serial_number ?? ''}` : 'unread';
    let g = byKey.get(key);
    if (!g) {
      const instrument = instruments.find((i) => i.model === r.instrument_model && i.serial_number === r.instrument_serial_number) ?? null;
      g = {
        key,
        title: key === 'unread' ? 'Not read yet' : (r.instrument_model ?? 'Unknown instrument'),
        serial: r.instrument_serial_number,
        instrument,
        items: [],
        needsReview: 0,
      };
      byKey.set(key, g);
    }
    g.items.push(r);
    if (r.status === 'in_review' || r.status === 'extracted') g.needsReview += 1;
  }
  // Instruments with the most recent report first; "Not read yet" last.
  const newest = (g: ReportGroup) => g.items.reduce((m, r) => (r.created_at > m ? r.created_at : m), '');
  return [...byKey.values()].sort((a, b) => (a.key === 'unread' ? 1 : b.key === 'unread' ? -1 : newest(b).localeCompare(newest(a))));
}

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
  const [items, setItems] = useState<ReportListItem[]>([]);
  // Column the table is sorted by (null: the server's order). Sorting is done here, on the rows already loaded.
  const [sort, setSort] = useState<SortState | null>(null);
  const [groupMode, setGroupMode] = useState<GroupMode>(readGroupMode);
  const [screen, setScreen] = useState<ReportsScreen>({ kind: 'list' });
  // `items` lives here, and this component stays mounted while a report is
  // open, so the list doesn't refetch on its own when the technician comes
  // back — and a save/finalize inside ReportDetailScreen only updates that
  // screen's own state. Bumped on every way out of a report (see
  // leaveReport) so the list shows the report's new status instead of the
  // pre-save one. InstrumentDetailScreen needs nothing extra: it's unmounted
  // while a report is open and fetches fresh when it mounts again.
  const [refreshNonce, setRefreshNonce] = useState(0);

  // How many reports each status has under the other filters, for the pills above the list. Counted apart
  // from `items` because the list itself is already narrowed by the status that is chosen.
  const [statusCounts, setStatusCounts] = useState<Partial<Record<ReportStatus, number>> | null>(null);
  const { status: chosenStatus, ...withoutStatus } = filters;
  const withoutStatusKey = JSON.stringify(withoutStatus);
  useEffect(() => {
    let cancelled = false;
    listReports(JSON.parse(withoutStatusKey) as ReportFilters)
      .then((all) => {
        if (cancelled) return;
        const counts: Partial<Record<ReportStatus, number>> = {};
        for (const r of all) counts[r.status] = (counts[r.status] ?? 0) + 1;
        setStatusCounts(counts);
      })
      .catch(() => {
        if (!cancelled) setStatusCounts(null);
      });
    return () => {
      cancelled = true;
    };
  }, [withoutStatusKey, refreshNonce]);

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

  const searching = Boolean(filters.q);
  // Best match first only means something for a search; otherwise the newest report leads.
  const shown = sort || searching ? sortReports(items, sort) : defaultOrder(items);
  // Search covers finalized reports only, so another status filter can only be empty.
  const renderRow = (r: ReportListItem) => (
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
  );

  // Grouping suits browsing; a search (best match first) and a chosen sort order need one flat list.
  const grouped = groupMode === 'instrument' && !searching && !sort;
  const groups = grouped ? groupByInstrument(defaultOrder(items), instruments) : [];
  const statusBlocksSearch = searching && Boolean(filters.status) && filters.status !== 'finalized';

  return (
    <div className="section">
      <div className="section-title">Reports</div>

      <div className="reports-layout">
      <aside className="reports-filters" aria-label="Filters">
      <ReportFilterBar
        filters={filters}
        setFilters={setFilters}
        instruments={instruments}
        extra={
          filters.instrument_id && (
            <button
              className="btn small"
              onClick={() => setScreen({ kind: 'instrument', instrumentId: filters.instrument_id! })}
            >
              View instrument details →
            </button>
          )
        }
      />
      </aside>
      <div className="reports-results">
      {statusCounts && (
        <div className="status-filter" role="group" aria-label="Filter by status" data-testid="status-pills">
          <button
            type="button"
            className="status-filter-pill"
            aria-pressed={!chosenStatus}
            onClick={() => setFilters((f) => ({ ...f, status: undefined }))}
          >
            All <span className="status-filter-count">{Object.values(statusCounts).reduce((a, b) => a + (b ?? 0), 0)}</span>
          </button>
          {(['draft', 'classified', 'extracted', 'in_review', 'finalized'] as ReportStatus[])
            .filter((st) => (statusCounts[st] ?? 0) > 0 || chosenStatus === st)
            .map((st) => (
              <button
                key={st}
                type="button"
                className="status-filter-pill"
                aria-pressed={chosenStatus === st}
                onClick={() => setFilters((f) => ({ ...f, status: st }))}
              >
                {STATUS_LABEL[st]} <span className="status-filter-count">{statusCounts[st] ?? 0}</span>
              </button>
            ))}
        </div>
      )}
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
            <label className="group-select-wrap">
              <span>Group</span>
              <select
                className="group-select"
                data-testid="group-select"
                value={groupMode}
                onChange={(e) => {
                  const mode: GroupMode = e.target.value === 'none' ? 'none' : 'instrument';
                  setGroupMode(mode);
                  writeGroupMode(mode);
                }}
              >
                <option value="instrument">Instrument</option>
                <option value="none">None</option>
              </select>
            </label>
          </div>
          {grouped ? (
            <div className="report-table report-groups" data-testid="report-groups">
              {groups.map((g) => (
                <section className="report-group" key={g.key} data-testid="report-group">
                  <header className="report-group-head">
                    <div className="report-group-title">
                      <strong>{g.title}</strong>
                      {g.serial && <span className="report-group-serial">{g.serial}</span>}
                      {g.instrument?.location && <span className="report-group-place">{g.instrument.location}</span>}
                    </div>
                    <div className="report-group-meta">
                      <span className="report-group-count">{g.items.length} report{g.items.length === 1 ? '' : 's'}</span>
                      {g.needsReview > 0 && <span className="badge badge-warn">{g.needsReview} need{g.needsReview === 1 ? 's' : ''} review</span>}
                      {g.instrument && (
                        <button type="button" className="btn small" onClick={() => setScreen({ kind: 'instrument', instrumentId: g.instrument!.id })}>
                          Instrument page →
                        </button>
                      )}
                    </div>
                  </header>
                  <div className="report-group-rows">{g.items.map(renderRow)}</div>
                </section>
              ))}
            </div>
          ) : (
          <>
          <label className="sort-select-wrap">
            <span>Sort by</span>
            <select
              className="sort-select"
              data-testid="sort-select"
              value={sort ? `${sort.key}:${sort.direction}` : ''}
              onChange={(e) => {
                const [key, direction] = e.target.value.split(':');
                setSort(key ? { key: key as SortKey, direction: direction as 'asc' | 'desc' } : null);
              }}
            >
              <option value="">{searching ? 'Best match' : 'Default order'}</option>
              {(Object.keys(SORT_LABEL) as SortKey[]).flatMap((key) => [
                <option key={`${key}:asc`} value={`${key}:asc`}>{`${SORT_LABEL[key]} ▲`}</option>,
                <option key={`${key}:desc`} value={`${key}:desc`}>{`${SORT_LABEL[key]} ▼`}</option>,
              ])}
            </select>
          </label>
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
            {shown.map(renderRow)}
          </div>
          </>
          )}
        </>
      )}
      </div>
      </div>
    </div>
  );
}
