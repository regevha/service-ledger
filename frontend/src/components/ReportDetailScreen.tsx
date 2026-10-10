import { useState } from 'react';
import {
  ApiError,
  attachmentFileUrl,
  deleteReport,
  finalizeReport,
  getReport,
  getReportTemplate,
  reportPdfUrl,
  updateReportFields,
  type Instrument,
  type Report,
  type ReportListItem,
  type ReportTemplate,
} from '../api';
import { useAsyncEffect } from '../hooks/useAsyncEffect';
import { REPORT_TYPE_LABEL, STATUS_LABEL } from '../labels';
import { ReviewScreen } from './ReviewScreen';

/**
 * One already-saved report, opened from ReportsListScreen.tsx's table (or
 * from InstrumentDetailScreen.tsx's report history). Reuses the same
 * ReviewScreen the live intake flow (IntakeFlow.tsx) uses to review a
 * freshly-extracted report — the two differ only in what they pass it: this
 * screen has no fresh extraction confidences to flag fields with, and only
 * offers "finalize" when the report's current status still allows it.
 */
export function ReportDetailScreen({
  item,
  instruments,
  onBack,
  onDeleted,
  onViewInstrument,
  fieldConfidenceThreshold,
}: {
  item: ReportListItem;
  instruments: Instrument[];
  onBack: () => void;
  /** Called after the report has been deleted, instead of onBack, so the caller can refresh its list. */
  onDeleted: () => void;
  onViewInstrument: (instrumentId: string) => void;
  fieldConfidenceThreshold: number;
}) {
  const [report, setReport] = useState<Report | null>(null);
  const [template, setTemplate] = useState<ReportTemplate | null>(null);
  const [fields, setFields] = useState<Record<string, unknown>>({});
  const [reportDate, setReportDate] = useState<string | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // `setError` is reused below by handleSave — a failure saving corrections
  // lands in this same banner rather than a second, separate error state.
  const { loading, error, setError } = useAsyncEffect(
    async (isCancelled) => {
      const r = await getReport(item.id);
      if (isCancelled()) return;
      setReport(r);
      setFields(r.extracted_fields ?? {});
      setReportDate(r.report_date);
      // Fetch the report's own template_id directly (GET /report-templates/
      // {id}), not re-resolve "the" template for its instrument model +
      // report type (findTemplate) the way this used to. resolve_template's
      // model/report_type match can point at a *different* template than
      // the one this report was actually confirmed against — a new
      // model-specific template added after this report was finalized, or
      // the instrument being renamed to a different model, would both
      // change what findTemplate(model, reportType) returns without ever
      // changing this report's own template_id. Rendering that
      // newly-resolved template's field_schema against this report's
      // already-saved extracted_fields silently showed the wrong fields —
      // and since PATCH /reports/{id}/fields is a merge-overlay allowed even
      // on a finalized report, saving corrections from here could
      // permanently write the wrong template's field keys into it.
      if (r.template_id) {
        const tpl = await getReportTemplate(r.template_id);
        if (!isCancelled()) setTemplate(tpl);
      }
    },
    [item],
    'Could not load report.'
  );

  async function handleSave(finalize: boolean) {
    if (!report) return;
    setBusyLabel(finalize ? 'Saving and finalizing…' : 'Saving corrections…');
    try {
      const updated = await updateReportFields(report.id, { extracted_fields: fields, report_date: reportDate });
      const final = finalize ? await finalizeReport(report.id) : updated;
      setReport(final);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Saving failed unexpectedly.');
    } finally {
      setBusyLabel(null);
    }
  }

  async function handleDelete() {
    if (!report) return;
    setBusyLabel('Deleting report…');
    try {
      // A finalized report is service history; the confirm text below says so,
      // and confirming sends force.
      await deleteReport(report.id, report.status === 'finalized');
      onDeleted();
    } catch (e) {
      setConfirmingDelete(false);
      setError(e instanceof ApiError ? e.message : 'Could not delete this report.');
      setBusyLabel(null);
    }
  }

  // report.instrument_id (raw ReportOut, §9) rather than item's own
  // instrument_model/instrument_serial_number — those are already resolved
  // display strings (§7), not the id this screen needs to navigate with.
  const instrument = report?.instrument_id ? instruments.find((i) => i.id === report.instrument_id) : undefined;

  return (
    <div className="section">
      <div className="detail-nav-row">
        <button className="btn small back-link" onClick={onBack}>
          ← Back to reports
        </button>
        {instrument && (
          <button className="btn small" onClick={() => onViewInstrument(instrument.id)}>
            View instrument: {instrument.model} ({instrument.serial_number}) →
          </button>
        )}
        {report && !confirmingDelete && (
          <button className="btn small" onClick={() => setConfirmingDelete(true)}>
            Delete report
          </button>
        )}
      </div>

      {report && confirmingDelete && (
        <div className="banner banner-warn" role="alertdialog" aria-label="Confirm delete">
          <div>
            {report.status === 'finalized'
              ? 'This report is finalized. Deleting it permanently removes it and its scan from the service history.'
              : 'Delete this report and its scan permanently?'}{' '}
            This cannot be undone.
          </div>
          <button className="btn small" onClick={() => void handleDelete()}>
            Confirm delete
          </button>{' '}
          <button className="btn small" onClick={() => setConfirmingDelete(false)}>
            Cancel
          </button>
        </div>
      )}

      {error && <div className="banner banner-warn">{error}</div>}

      {loading || busyLabel ? (
        <div className="working-panel">
          <div className="spinner" />
          <div>{busyLabel ?? 'Loading report…'}</div>
        </div>
      ) : report && template ? (
        <ReviewScreen
          template={template}
          fields={fields}
          reportDate={reportDate}
          onReportDateChange={setReportDate}
          fieldConfidences={{}}
          fieldConfidenceThreshold={fieldConfidenceThreshold}
          onChange={(name, value) => setFields((prev) => ({ ...prev, [name]: value }))}
          onSave={() => void handleSave(false)}
          onFinalize={
            report.status === 'extracted' || report.status === 'in_review' ? () => void handleSave(true) : undefined
          }
          title={`${REPORT_TYPE_LABEL[template.report_type]} — ${STATUS_LABEL[report.status]}`}
          // §4: "one file per report" for MVP, so the first (only) attachment
          // is the original this report's fields came from.
          originalScanUrl={report.attachments[0] ? attachmentFileUrl(report.attachments[0].id) : undefined}
          pdfUrl={reportPdfUrl(report.id)}
        />
      ) : report ? (
        <div className="empty-hint">
          No template could be resolved for this report (its instrument or report type isn't set), so its fields
          can't be shown here.
        </div>
      ) : null}
    </div>
  );
}
