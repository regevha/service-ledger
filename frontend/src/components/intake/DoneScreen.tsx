import { type Report } from '../../api';

/** The day, as YYYY-MM-DD in the viewer's own time zone (the form the tables use). */
function isoDay(value: string): string {
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function DoneScreen({
  report,
  instrumentLabel,
  typeLabel,
  onReset,
  onOpenReport,
  onViewInstrument,
}: {
  report: Report;
  /** "Model · serial" of the unit the report is on, when it is known. */
  instrumentLabel?: string;
  typeLabel?: string;
  onReset: () => void;
  onOpenReport?: (reportId: string) => void;
  onViewInstrument?: (instrumentId: string) => void;
}) {
  return (
    <div className="section success-panel" data-testid="intake-success">
      <div className="tick">✓</div>
      <h3>Report finalized</h3>
      <p>{report.finalized_at ? `Saved on ${isoDay(report.finalized_at)}.` : 'Saved.'} It is now part of the instrument's history.</p>
      <div className="success-summary" data-testid="intake-success-summary">
        <span className="success-summary-unit">{instrumentLabel ?? 'Instrument'}</span>
        <span className="success-summary-chip">Finalized</span>
        <span className="success-summary-meta">
          {[typeLabel, report.report_date].filter(Boolean).join(' · ') || 'Service report'}
        </span>
      </div>
      <div className="cta-row success-actions">
        {onOpenReport && (
          <button className="btn primary" data-testid="intake-open-report" onClick={() => onOpenReport(report.id)}>
            Open report
          </button>
        )}
        {onViewInstrument && report.instrument_id && (
          <button className="btn" data-testid="intake-view-instrument" onClick={() => onViewInstrument(report.instrument_id!)}>
            View instrument
          </button>
        )}
        <button className={onOpenReport ? 'btn' : 'btn primary'} onClick={onReset}>
          Start another report
        </button>
      </div>
    </div>
  );
}
