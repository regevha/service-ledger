import { useEffect, useRef, useState } from 'react';
import { LoadError } from './LoadError';
import {
  listReports,
  type Instrument,
  type ReportFilters,
  type ReportListItem,
} from '../api';
import { useAsyncEffect } from '../hooks/useAsyncEffect';
import { InstrumentDetailScreen } from './InstrumentDetailScreen';
import { ReportDetailScreen } from './ReportDetailScreen';
import { ReportFilterBar } from './ReportFilterBar';
import { ReportGroups } from './reports/ReportGroups';
import { ReportRow } from './reports/ReportRow';
import { ReportTableHead } from './reports/ReportTableHead';
import { ResultsToolbar } from './reports/ResultsToolbar';
import { SortSelect } from './reports/SortSelect';
import { StatusPills } from './reports/StatusPills';
import { useStatusCounts } from './reports/useStatusCounts';
import { groupByInstrument, groupByModel, readGroupMode, writeGroupMode, type GroupMode } from './reports/grouping';
import { defaultOrder, sortReports, type SortState } from '../reportSort';

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

  const { status: chosenStatus, ...withoutStatus } = filters;
  const withoutStatusKey = JSON.stringify(withoutStatus);
  const statusCounts = useStatusCounts(withoutStatusKey, refreshNonce);

  const { loading, error, retry } = useAsyncEffect(
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
    <ReportRow
      key={r.id}
      r={r}
      onOpen={() => setScreen({ kind: 'report', item: r, returnTo: { kind: 'list' }, highlight: filters.q })}
    />
  );

  // Grouping suits browsing; a search (best match first) needs one flat list. A chosen sort order applies
  // to the rows inside each group (the groups keep their order), so it works with either grouping.
  const grouped = groupMode !== 'none' && !searching;
  const groups = grouped ? (groupMode === 'model' ? groupByModel : groupByInstrument)(sort ? sortReports(items, sort) : defaultOrder(items), instruments) : [];
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
        <StatusPills statusCounts={statusCounts} chosenStatus={chosenStatus} setFilters={setFilters} />
      )}
      {error && <LoadError message={error} onRetry={retry} />}

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
          <ResultsToolbar
            count={items.length}
            searching={searching}
            query={filters.q}
            sort={sort}
            groupMode={groupMode}
            onGroupMode={(mode) => {
              setGroupMode(mode);
              writeGroupMode(mode);
            }}
          />
          <SortSelect grouped={grouped} searching={searching} sort={sort} setSort={setSort} />
          {grouped ? (
            <ReportGroups
              groups={groups}
              renderRow={renderRow}
              onOpenInstrument={(instrumentId) => setScreen({ kind: 'instrument', instrumentId })}
            />
          ) : (
          <>
          <div className="report-table">
            <ReportTableHead sort={sort} setSort={setSort} />
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
