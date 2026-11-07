import type { ReportListItem } from '../../api';
import { REPORT_TYPE_LABEL, STATUS_LABEL } from '../../labels';
import { isUnread } from './grouping';

/** One report in the list: instrument, type, lab manager, date, status and the matching excerpt of a search. */
export function ReportRow({ r, onOpen }: { r: ReportListItem; onOpen: () => void }) {
  return (
    <button
      className="report-row report-row-body" data-testid="report-row"
      onClick={onOpen}
    >
      <span data-label="Instrument">
        {r.instrument_model ?? (isUnread(r) ? 'Not read yet' : '—')}
        {r.instrument_serial_number ? ` (${r.instrument_serial_number})` : ''}
      </span>
      <span data-label="Report type">{r.report_type ? REPORT_TYPE_LABEL[r.report_type] : '—'}</span>
      <span data-label="Lab manager" data-empty={r.technician_name ? undefined : ''}>{r.technician_name ?? '—'}</span>
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
}
