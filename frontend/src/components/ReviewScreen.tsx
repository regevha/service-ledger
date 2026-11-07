import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Notice } from './Notice';
import { ReadOnlyContext } from './FieldEditor';
import { PhoneScanSwitch, ScanSplit, useScanPreview } from './ScanPreview';
import { ReviewSearchBar } from './ReviewSearchBar';
import { useReviewSearch } from '../hooks/useReviewSearch';
import { REPORT_TYPE_LABEL } from '../labels';
import { fieldLabel } from '../fieldLabels';
import type { ReportTemplate } from '../api';
import { AttentionStrip } from './review/AttentionStrip';
import { EditConfirm, FinalizeConfirm } from './review/ConfirmBanners';
import { ReportDateField } from './review/ReportDateField';
import { ReviewActions } from './review/ReviewActions';
import { ReviewField } from './review/ReviewField';
import { ReviewHeader } from './review/ReviewHeader';
import { ReviewRail } from './review/ReviewRail';

/**
 * The field-by-field review/correction UI (§5) — shared between the live
 * intake flow (IntakeFlow.tsx, right after extraction) and an
 * already-saved report opened from the Reports tab (ReportDetailScreen.tsx).
 * The two call sites differ only in what they pass: live intake has fresh
 * per-field extraction confidences and always offers "Save & finalize";
 * browsing a saved report has neither (see `fieldConfidences`/`onFinalize`
 * below), and overrides the heading since "N fields need attention" is
 * meaningless without those confidences.
 */
const isEmptyValue = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

export function ReviewScreen({
  template,
  fields,
  reportDate,
  onReportDateChange,
  fieldConfidences,
  fieldConfidenceThreshold,
  placeholderValues = false,
  onChange,
  onSave,
  onFinalize,
  title,
  titleMeta,
  originalScanUrl,
  pdfUrl,
  scanInlineUrl,
  scanAttachmentId,
  readOnly = false,
  onEdit,
  onCancelEdit,
  linksInMenu = false,
  extractionSeconds,
  busy = null,
  saveError = null,
  onRetrySave,
  instrumentLine,
  onChangeInstrument,
  onBack,
}: {
  template: ReportTemplate;
  fields: Record<string, unknown>;
  // The service-visit date (Report.report_date) — not a template field, but
  // read off the document by the same extraction call, so it's reviewed and
  // corrected here alongside them. Its extraction confidence arrives in
  // fieldConfidences under the key "report_date" (a field name the backend
  // reserves, so it can't clash with a template field). YYYY-MM-DD or null.
  reportDate: string | null;
  onReportDateChange: (value: string | null) => void;
  fieldConfidences: Record<string, number>;
  fieldConfidenceThreshold: number;
  // True when extraction ran without an API key: the values and their
  // confidences are placeholders, not reads of the document, so badges say
  // "placeholder" and a notice asks the technician to fill everything in.
  placeholderValues?: boolean;
  onChange: (name: string, value: unknown) => void;
  onSave: () => void;
  // Undefined hides the finalize button entirely — used when browsing an
  // existing report whose status doesn't allow finalizing (§9: only
  // extracted/in_review can finalize; the backend 409s otherwise, so the
  // frontend just doesn't offer the button rather than surfacing that error).
  onFinalize?: () => void;
  // Override the computed "N fields need attention" heading — that count is
  // meaningless without fresh extraction confidences (an already-saved
  // report has none), so the reports list passes its own heading instead.
  title?: string;
  // A muted line under `title` (date and status of a saved report).
  titleMeta?: ReactNode;
  // Link to the scanned original this review screen's values came from.
  // Undefined hides the link — covers the brief window during live intake
  // before the attachment finishes uploading.
  originalScanUrl?: string;
  // §7/§11: a formatted PDF of this exact report, always available once a
  // template's resolved (GET /reports/{id}/pdf only 409s on that) — unlike
  // originalScanUrl, this is never undefined-because-still-uploading, since
  // the review screen itself only renders once `template` exists.
  pdfUrl?: string;
  // The same scan, for showing beside the fields on a wide screen (the attachment's inline URL).
  // Undefined (or a narrow screen) falls back to the "View original scan" link alone.
  scanInlineUrl?: string;
  // The scan's attachment id, for the phone's Fields | Scan switch (page images).
  scanAttachmentId?: string;
  // A finalized report opens read-only: its fields can't be typed into until Edit is pressed.
  readOnly?: boolean;
  onEdit?: () => void;
  // Shown while a finalized report is being edited: throws the changes away.
  onCancelEdit?: () => void;
  // On a phone the report screen's "⋯" menu carries these two links instead.
  linksInMenu?: boolean;
  // How long reading the document into these fields took, in seconds. Null or undefined: nothing to say.
  extractionSeconds?: number | null;
  // A save or finalize request is in flight. The screen stays where it is (so the scan view, the
  // "checked" marks and the scroll position survive); the buttons just show the progress and wait.
  busy?: 'save' | 'finalize' | null;
  // Why the last save or finalize failed. Shown on this screen with a retry; nothing typed is lost.
  saveError?: string | null;
  onRetrySave?: () => void;
  /** Intake only: which unit the report is on and how it was found, with a way back to change it. */
  instrumentLine?: string;
  onChangeInstrument?: () => void;
  /** Intake only: back to the Classify step. Shown in the heading row. */
  onBack?: () => void;
}) {
  // A low-confidence field stays flagged until the technician explicitly marks it checked.
  // Editing the value does not count: they may have typed over it without looking at the scan.
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  // A finalized report is the record; opening it for changes asks first.
  const [confirmingEdit, setConfirmingEdit] = useState(false);
  const markChecked = (name: string) => {
    setChecked((prev) => new Set(prev).add(name));
    // The button disappears once the field is checked; keep the keyboard where it was, on the field.
    const el = listRef.current?.querySelector<HTMLElement>(`[data-field="${name}"]`);
    el?.querySelector<HTMLElement>('input, textarea, select')?.focus({ preventScroll: true });
  };
  // Fields a person fills in (not printed on the form): the model's value is only a
  // suggestion, so it is flagged whatever its confidence, until marked as checked.
  const personFields = new Set(template.field_schema.fields.filter((f) => f.filled_by_person).map((f) => f.name));
  // Fields that may be left empty (root cause): empty is a fine answer, not a doubt.
  const optionalFields = new Set(template.field_schema.fields.filter((f) => f.optional).map((f) => f.name));
  const isFlagged = (name: string) => {
    if (checked.has(name)) return false;
    if (personFields.has(name) && !readOnly) return true;
    if (optionalFields.has(name) && isEmptyValue(fields[name])) return false;
    const confidence = fieldConfidences[name];
    return confidence !== undefined && confidence < fieldConfidenceThreshold;
  };
  const reportDateConfidence = fieldConfidences.report_date;
  const reportDateFlagged = isFlagged('report_date');
  const flaggedCount =
    template.field_schema.fields.filter((f) => isFlagged(f.name)).length + (reportDateFlagged ? 1 : 0);
  const heading = title ?? REPORT_TYPE_LABEL[template.report_type];
  const meta =
    titleMeta ??
    (title === undefined
      ? flaggedCount > 0
        ? `${flaggedCount} field${flaggedCount === 1 ? '' : 's'} ${flaggedCount === 1 ? 'needs' : 'need'} your attention`
        : 'Check the values against the scan'
      : undefined);

  const preview = useScanPreview(scanInlineUrl, scanAttachmentId);
  const { phone, phoneScan } = preview;

  // "Next ↓" walks the fields that need attention, one press at a time, wrapping round.
  const listRef = useRef<HTMLDivElement>(null);
  const nextFlagged = useRef(-1);
  // Find-on-screen over the values. Not offered where the field list is not showing (the phone's Scan view).
  const search = useReviewSearch(listRef, !(phone && phoneScan), fields, reportDate);
  function goToField(name: string) {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-field="${name}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.querySelector<HTMLElement>('input, textarea, select')?.focus({ preventScroll: true });
  }
  const flaggedList = [
    ...(reportDateFlagged ? [{ name: 'report_date', label: 'Service date' }] : []),
    ...template.field_schema.fields
      .filter((f) => isFlagged(f.name))
      .map((f) => ({ name: f.name, label: fieldLabel(f.name, f.unit) })),
  ];
  // Pressing "Save & finalize" with fields still flagged asks first, instead of closing the report silently.
  const [confirmingFinalize, setConfirmingFinalize] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  const showFinalizeConfirm = confirmingFinalize && flaggedCount > 0 && !readOnly;
  useEffect(() => {
    if (!showFinalizeConfirm) return;
    confirmRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    confirmRef.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }, [showFinalizeConfirm]);
  function requestFinalize() {
    if (flaggedCount > 0) setConfirmingFinalize(true);
    else onFinalize?.();
  }
  function reviewFlagged() {
    setConfirmingFinalize(false);
    if (flaggedList.length > 0) goToField(flaggedList[0].name);
  }
  function finalizeAnyway() {
    setConfirmingFinalize(false);
    onFinalize?.();
  }

  function goToNextFlagged() {
    const els = listRef.current?.querySelectorAll<HTMLElement>('.field.pending');
    if (!els || els.length === 0) return;
    nextFlagged.current = (nextFlagged.current + 1) % els.length;
    const el = els[nextFlagged.current];
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.querySelector<HTMLElement>('input, textarea, select, button')?.focus({ preventScroll: true });
  }

  return (
    <div className="section">
      <ReviewHeader
        heading={heading}
        meta={meta}
        extractionSeconds={extractionSeconds}
        instrumentLine={instrumentLine}
        onChangeInstrument={onChangeInstrument}
        onBack={onBack}
        search={search}
        preview={preview}
        originalScanUrl={originalScanUrl}
        pdfUrl={pdfUrl}
        linksInMenu={linksInMenu}
      />

      {search.open && (
        <ReviewSearchBar
          query={search.query}
          count={search.count}
          current={search.current}
          inputRef={search.inputRef}
          onChange={search.changeQuery}
          onNext={search.next}
          onPrevious={search.previous}
          onClose={search.closeSearch}
        />
      )}

      {placeholderValues && (
        <Notice tone="warn" id="placeholder-notice">
          No API key is set, so these values are placeholders, not read from the document. Check every field against the
          scan.
        </Notice>
      )}

      {saveError && (
        <div role="alert">
          <Notice
            tone="crit"
            id="save-error"
            actions={
              onRetrySave && (
                <button type="button" className="btn small" onClick={onRetrySave} disabled={busy !== null}>
                  Try again
                </button>
              )
            }
          >
            {saveError}
          </Notice>
        </div>
      )}

      {!readOnly && flaggedCount > 0 && (
        <AttentionStrip flaggedCount={flaggedCount} flaggedList={flaggedList} onGo={goToField} />
      )}

      <PhoneScanSwitch preview={preview} />

      <ScanSplit
        preview={preview}
        rail={
          <ReviewRail template={template} reportDateFlagged={reportDateFlagged} isFlagged={isFlagged} readOnly={readOnly} onGo={goToField} />
        }
      >
      <fieldset className="review-fieldset" disabled={readOnly}>
      <ReadOnlyContext.Provider value={readOnly}>
      <div className={`field-list${readOnly ? ' read-only' : ''}`} data-testid="field-list" data-read-only={readOnly ? 'true' : undefined} ref={listRef}>
        <div className="field-list-head">
          <h2 className="field-list-title">What the report says</h2>
          <span className="field-list-count" data-testid="checked-count">
            {readOnly ? `${template.field_schema.fields.length + 1} fields` : `${template.field_schema.fields.length + 1 - flaggedCount} of ${template.field_schema.fields.length + 1} checked`}
          </span>
        </div>
        <ReportDateField
          flagged={reportDateFlagged}
          readOnly={readOnly}
          confidence={reportDateConfidence}
          threshold={fieldConfidenceThreshold}
          placeholderValues={placeholderValues}
          value={reportDate}
          onChange={onReportDateChange}
          onMarkChecked={() => markChecked('report_date')}
        />
        {template.field_schema.fields.map((field, i) => (
          <ReviewField
            key={field.name}
            field={field}
            index={i}
            confidence={fieldConfidences[field.name]}
            flagged={isFlagged(field.name)}
            readOnly={readOnly}
            isPersonField={personFields.has(field.name)}
            threshold={fieldConfidenceThreshold}
            placeholderValues={placeholderValues}
            value={fields[field.name]}
            onChange={(v) => onChange(field.name, v)}
            onMarkChecked={() => markChecked(field.name)}
          />
        ))}
      </div>
      </ReadOnlyContext.Provider>

      </fieldset>

      {confirmingEdit && onEdit && readOnly && (
        <EditConfirm onEdit={() => { setConfirmingEdit(false); onEdit(); }} onClose={() => setConfirmingEdit(false)} />
      )}

      {showFinalizeConfirm && (
        <FinalizeConfirm
          flaggedCount={flaggedCount}
          busy={busy}
          confirmRef={confirmRef}
          onReview={reviewFlagged}
          onFinalizeAnyway={finalizeAnyway}
          onClose={() => setConfirmingFinalize(false)}
        />
      )}

      <ReviewActions
        readOnly={readOnly}
        flaggedCount={flaggedCount}
        busy={busy}
        confirmingEdit={confirmingEdit}
        onNext={goToNextFlagged}
        onAskEdit={onEdit ? () => setConfirmingEdit(true) : undefined}
        onCancelEdit={onCancelEdit}
        onSave={onSave}
        onRequestFinalize={onFinalize ? requestFinalize : undefined}
      />
      </ScanSplit>
    </div>
  );
}
