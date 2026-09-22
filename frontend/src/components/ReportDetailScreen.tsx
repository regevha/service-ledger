import { useState } from 'react';
import {
  ApiError,
  attachmentFileUrl,
  findTemplate,
  finalizeReport,
  getReport,
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
  onViewInstrument,
  fieldConfidenceThreshold,
}: {
  item: ReportListItem;
  instruments: Instrument[];
  onBack: () => void;
  onViewInstrument: (instrumentId: string) => void;
  fieldConfidenceThreshold: number;
}) {
  const [report, setReport] = useState<Report | null>(null);
  const [template, setTemplate] = useState<ReportTemplate | null>(null);
  const [fields, setFields] = useState<Record<string, unknown>>({});
  const [busyLabel, setBusyLabel] = useState<string | null>(null);

  // `setError` is reused below by handleSave — a failure saving corrections
  // lands in this same banner rather than a second, separate error state.
  const { loading, error, setError } = useAsyncEffect(
    async (isCancelled) => {
      const r = await getReport(item.id);
      if (isCancelled()) return;
      setReport(r);
      setFields(r.extracted_fields ?? {});
      // GET /reports/{id} only carries instrument_id/template_id (raw
      // ReportOut, §9) — the list item already resolved those to display
      // names (§7), which is exactly what findTemplate needs, so reuse it
      // instead of adding a get-template-by-id endpoint for this one screen.
      if (item.instrument_model && item.report_type) {
        const tpl = await findTemplate(item.instrument_model, item.report_type);
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
      const updated = await updateReportFields(report.id, { extracted_fields: fields });
      const final = finalize ? await finalizeReport(report.id) : updated;
      setReport(final);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Saving failed unexpectedly.');
    } finally {
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
      </div>

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
