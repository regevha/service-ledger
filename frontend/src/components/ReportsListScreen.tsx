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

const STATUS_OPTIONS: ReportStatus[] = ['draft', 'classified', 'extracted', 'in_review', 'finalized'];

// The reports list, one report's detail, and one instrument's detail are
// three screens sharing this one tab — a small nav stack (rather than three
// independent booleans) so "back" from a report opened via the instrument
// page returns to that instrument page, not all the way out to the list.
type ReportsScreen =
  | { kind: 'list' }
  | { kind: 'instrument'; instrumentId: string }
  | { kind: 'report'; item: ReportListItem; returnTo: { kind: 'list' } | { kind: 'instrument'; instrumentId: string } };

export function ReportsListScreen({
  instruments,
  fieldConfidenceThreshold,
}: {
  instruments: Instrument[];
  fieldConfidenceThreshold: number;
}) {
  const [filters, setFilters] = useState<ReportFilters>({});
  // Technician is free text (§4: typed at intake, not a dropdown), so it gets
  // its own local state that updates on every keystroke for a responsive
  // input, debounced into `filters` — the actual fetch trigger below — so
  // "Jane Smith" doesn't fire nine separate /reports requests as it's typed.
  const [technicianInput, setTechnicianInput] = useState(filters.technician ?? '');
  const [items, setItems] = useState<ReportListItem[]>([]);
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

  const { loading, error } = useAsyncEffect(
    async (isCancelled) => {
      const list = await listReports(filters);
      if (!isCancelled()) setItems(list);
    },
    [filters, refreshNonce],
    'Could not load reports.'
  );

  function leaveReport(next: ReportsScreen) {
    setRefreshNonce((n) => n + 1);
    setScreen(next);
  }

  if (screen.kind === 'report') {
    return (
      <ReportDetailScreen
        item={screen.item}
        instruments={instruments}
        onBack={() => leaveReport(screen.returnTo)}
        onViewInstrument={(instrumentId) => leaveReport({ kind: 'instrument', instrumentId })}
        fieldConfidenceThreshold={fieldConfidenceThreshold}
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
    filters.instrument_id || filters.report_type || filters.status || filters.date_from || filters.date_to || filters.technician
  );

  return (
    <div className="section">
      <div className="section-title">Reports</div>

      <div className="filter-row">
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
          aria-label="Technician"
          placeholder="Technician"
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
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {error && <div className="banner banner-warn">{error}</div>}

      {loading ? (
        <div className="working-panel">
          <div className="spinner" />
          <div>Loading reports…</div>
        </div>
      ) : items.length === 0 ? (
        <div className="empty-hint">No reports match these filters.</div>
      ) : (
        <>
          <div className="table-toolbar">
            <span className="table-toolbar-count">
              {items.length} report{items.length === 1 ? '' : 's'}
            </span>
            <a className="btn small" href={reportsExportUrl(filters)}>
              ⬇ Export CSV
            </a>
          </div>
          <div className="report-table">
            <div className="report-row report-row-head">
              <span>Instrument</span>
              <span>Type</span>
              <span>Technician</span>
              <span>Report date</span>
              <span>Status</span>
            </div>
            {items.map((r) => (
              <button
                className="report-row report-row-body"
                key={r.id}
                onClick={() => setScreen({ kind: 'report', item: r, returnTo: { kind: 'list' } })}
              >
                <span>
                  {r.instrument_model ?? '—'}
                  {r.instrument_serial_number ? ` (${r.instrument_serial_number})` : ''}
                </span>
                <span>{r.report_type ? REPORT_TYPE_LABEL[r.report_type] : '—'}</span>
                <span>{r.technician_name ?? '—'}</span>
                <span>{r.report_date ?? '—'}</span>
                <span className={`status-pill status-${r.status}`}>{STATUS_LABEL[r.status]}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
