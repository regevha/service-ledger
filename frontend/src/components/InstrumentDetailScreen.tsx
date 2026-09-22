import { useState } from 'react';
import { listReports, type Instrument, type ReportListItem } from '../api';
import { useAsyncEffect } from '../hooks/useAsyncEffect';
import { INSTRUMENT_STATUS_LABEL, REPORT_TYPE_LABEL, STATUS_LABEL } from '../labels';
import { InstrumentTrendSection } from './InstrumentTrendChart';

/**
 * One instrument's detail page — its header/status, the trend chart
 * (InstrumentTrendChart.tsx), and its full report history. Reached from
 * ReportsListScreen.tsx's nav stack (either the filter row's "View
 * instrument details" shortcut or a report's own "View instrument" link),
 * which is also how a report opened from here returns to this same page
 * instead of all the way out to the plain reports list.
 */
export function InstrumentDetailScreen({
  instrumentId,
  instruments,
  onBack,
  onOpenReport,
}: {
  instrumentId: string;
  instruments: Instrument[];
  onBack: () => void;
  onOpenReport: (item: ReportListItem) => void;
}) {
  // The fleet is small and already fully loaded by App's own useEffect
  // (§1: a fixed instrument list) — no need for a GET /instruments/{id}
  // endpoint just to look one row up.
  const instrument = instruments.find((i) => i.id === instrumentId);

  const [items, setItems] = useState<ReportListItem[]>([]);
  const { loading, error } = useAsyncEffect(
    async (isCancelled) => {
      const list = await listReports({ instrument_id: instrumentId });
      if (!isCancelled()) setItems(list);
    },
    [instrumentId],
    "Could not load this instrument's reports."
  );

  // search_reports (GET /reports, §7) orders by created_at desc, so items[0]
  // is the most recently touched report regardless of status — a draft
  // someone just started is still "recent activity" worth surfacing here,
  // not just the most recently finalized one.
  const mostRecent = items[0];
  const finalizedCount = items.filter((r) => r.status === 'finalized').length;

  return (
    <div className="section">
      <button className="btn small back-link" onClick={onBack}>
        ← Back to reports
      </button>

      {error && <div className="banner banner-warn">{error}</div>}

      {!instrument ? (
        <div className="empty-hint">This instrument could not be found.</div>
      ) : (
        <>
          <div className="instrument-header">
            <div>
              <div className="section-title">{instrument.name}</div>
              <div className="instrument-meta">
                {instrument.model} · S/N {instrument.serial_number}
                {instrument.location ? ` · ${instrument.location}` : ''}
              </div>
            </div>
            <span className={`status-pill instrument-status-${instrument.status}`}>
              {INSTRUMENT_STATUS_LABEL[instrument.status]}
            </span>
          </div>

          <div className="stat-row">
            <div className="stat-tile">
              <span className="stat-value">{items.length}</span>
              <span className="stat-label">Reports on file ({finalizedCount} finalized)</span>
            </div>
            <div className="stat-tile">
              <span className="stat-value">
                {mostRecent ? mostRecent.report_date ?? mostRecent.created_at.slice(0, 10) : '—'}
              </span>
              <span className="stat-label">
                {mostRecent
                  ? `Most recent activity — ${mostRecent.report_type ? REPORT_TYPE_LABEL[mostRecent.report_type] : 'report'}`
                  : 'No reports on file yet'}
              </span>
            </div>
          </div>

          <InstrumentTrendSection instrumentId={instrumentId} />

          <div className="section-title" style={{ marginTop: 18 }}>
            Report history
          </div>

          {loading ? (
            <div className="working-panel">
              <div className="spinner" />
              <div>Loading report history…</div>
            </div>
          ) : items.length === 0 ? (
            <div className="empty-hint">No reports on file for this instrument yet.</div>
          ) : (
            <div className="instrument-report-table">
              <div className="instrument-report-row instrument-report-row-head">
                <span>Type</span>
                <span>Technician</span>
                <span>Report date</span>
                <span>Status</span>
              </div>
              {items.map((r) => (
                <button className="instrument-report-row instrument-report-row-body" key={r.id} onClick={() => onOpenReport(r)}>
                  <span>{r.report_type ? REPORT_TYPE_LABEL[r.report_type] : '—'}</span>
                  <span>{r.technician_name ?? '—'}</span>
                  <span>{r.report_date ?? '—'}</span>
                  <span className={`status-pill status-${r.status}`}>{STATUS_LABEL[r.status]}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
