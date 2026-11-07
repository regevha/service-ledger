import { ConfidenceBadge } from '../ConfidenceBadge';
import { DateInput } from '../DateInput';

/** The "Service date" row at the top of the field list. */
export function ReportDateField({
  flagged: reportDateFlagged,
  readOnly,
  confidence: reportDateConfidence,
  threshold: fieldConfidenceThreshold,
  placeholderValues,
  value: reportDate,
  onChange: onReportDateChange,
  onMarkChecked,
}: {
  flagged: boolean;
  readOnly: boolean;
  confidence: number | undefined;
  threshold: number;
  placeholderValues: boolean;
  value: string | null;
  onChange: (value: string | null) => void;
  onMarkChecked: () => void;
}) {
  return (
    <div
      className={`field ${reportDateFlagged ? 'pending' : 'ok'}`}
      data-field="report_date"
      role="group"
      aria-labelledby="review-report-date-label"
    >
      <div className="field-top">
        <label className="field-label" id="review-report-date-label" htmlFor="review-report-date">
          Service date
        </label>
        {reportDateFlagged && !readOnly && <span className="sr-only">Needs checking.</span>}
        {reportDateConfidence !== undefined && (
          <ConfidenceBadge
            confidence={reportDateConfidence}
            threshold={fieldConfidenceThreshold}
            label={placeholderValues ? 'placeholder' : undefined}
          />
        )}
      </div>
      {reportDateFlagged && !readOnly && (
        <button
          type="button"
          className="btn small mark-checked"
          aria-label="Mark as checked: Service date"
          onClick={() => onMarkChecked()}
        >
          Mark as checked
        </button>
      )}
      <DateInput id="review-report-date" value={reportDate ?? ''} onChange={(v) => onReportDateChange(v || null)} />
      <div className="field-note">The date the service visit was carried out.</div>
    </div>
  );
}
