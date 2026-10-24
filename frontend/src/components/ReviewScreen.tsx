import { useRef, useState } from 'react';
import { ConfidenceBadge } from './ConfidenceBadge';
import { FieldControl } from './FieldEditor';
import { REPORT_TYPE_LABEL } from '../labels';
import { fieldLabel } from '../fieldLabels';
import { useMediaQuery } from '../hooks/useMediaQuery';
import type { ReportTemplate } from '../api';

const SCAN_PREF_KEY = 'sl.review.showScan';

// Per-viewer convenience only: browser storage can be empty or throw, so the page works without it.
function readScanPref(): boolean {
  try {
    return localStorage.getItem(SCAN_PREF_KEY) !== 'off';
  } catch {
    return true;
  }
}
function writeScanPref(on: boolean) {
  try {
    localStorage.setItem(SCAN_PREF_KEY, on ? 'on' : 'off');
  } catch {
    /* not remembered; nothing else depends on it */
  }
}

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
  originalScanUrl,
  pdfUrl,
  scanInlineUrl,
  readOnly = false,
  onEdit,
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
  // A finalized report opens read-only: its fields can't be typed into until Edit is pressed.
  readOnly?: boolean;
  onEdit?: () => void;
}) {
  const isFlagged = (name: string) => {
    const confidence = fieldConfidences[name];
    return confidence !== undefined && confidence < fieldConfidenceThreshold;
  };
  const reportDateConfidence = fieldConfidences.report_date;
  const reportDateFlagged = isFlagged('report_date');
  const flaggedCount =
    template.field_schema.fields.filter((f) => isFlagged(f.name)).length + (reportDateFlagged ? 1 : 0);
  const heading =
    title ??
    `${REPORT_TYPE_LABEL[template.report_type]} — ${flaggedCount} field${flaggedCount === 1 ? '' : 's'} ${
      flaggedCount === 1 ? 'needs' : 'need'
    } your attention`;

  const wide = useMediaQuery('(min-width: 1100px)');
  const [scanOpen, setScanOpen] = useState(readScanPref);
  const showScan = Boolean(scanInlineUrl) && wide && scanOpen;

  // "Next ↓" walks the fields that need attention, one press at a time, wrapping round.
  const listRef = useRef<HTMLDivElement>(null);
  const nextFlagged = useRef(-1);
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
      <div className="section-title-row">
        <div className="section-title">{heading}</div>
        <div className="section-title-actions">
          {scanInlineUrl && wide && (
            <button
              type="button"
              className="btn small"
              onClick={() => {
                setScanOpen(!scanOpen);
                writeScanPref(!scanOpen);
              }}
            >
              {scanOpen ? 'Hide scan' : 'Show scan'}
            </button>
          )}
          {originalScanUrl && (
            <a className="btn small" href={originalScanUrl} target="_blank" rel="noreferrer">
              View original scan
            </a>
          )}
          {pdfUrl && (
            <a className="btn small" href={pdfUrl}>
              Download PDF
            </a>
          )}
        </div>
      </div>

      {placeholderValues && (
        <div className="banner banner-warn" id="placeholder-notice">
          No API key is set, so these values are placeholders, not read from the document. Check every field against the
          scan.
        </div>
      )}

      <div className={`review-split${showScan ? ' with-scan' : ''}`}>
        {showScan && (
          <aside className="review-scan" aria-label="Original scan">
            <iframe src={`${scanInlineUrl}#view=FitH`} title="Original scan" />
          </aside>
        )}
        <div className="review-fields">
      <fieldset className="review-fieldset" disabled={readOnly}>
      <div className={`field-list${readOnly ? ' read-only' : ''}`} ref={listRef}>
        <div className={`field ${reportDateFlagged ? 'pending' : 'ok'}`}>
          <div className="field-top">
            <label className="field-label" htmlFor="review-report-date">
              Service date
            </label>
            {reportDateConfidence !== undefined && (
              <ConfidenceBadge
                confidence={reportDateConfidence}
                threshold={fieldConfidenceThreshold}
                label={placeholderValues ? 'placeholder' : undefined}
              />
            )}
          </div>
          <input
            id="review-report-date"
            type="date"
            value={reportDate ?? ''}
            onChange={(e) => onReportDateChange(e.target.value || null)}
          />
          <div className="field-note">The date the service visit was carried out.</div>
        </div>
        {template.field_schema.fields.map((field, i) => {
          const confidence = fieldConfidences[field.name];
          const flagged = isFlagged(field.name);
          return (
            <div className={`field ${flagged ? 'pending' : 'ok'}`} key={field.name}>
              <div className="field-top">
                <span className="field-label">
                  <span className="badge-mini" style={{ background: flagged ? 'var(--warn)' : 'var(--good)' }}>
                    {i + 1}
                  </span>{' '}
                  {fieldLabel(field.name, field.unit)}
                  {field.unit && <span className="field-unit"> ({field.unit})</span>}
                </span>
                {confidence !== undefined && (
                  <ConfidenceBadge
                    confidence={confidence}
                    threshold={fieldConfidenceThreshold}
                    label={placeholderValues ? 'placeholder' : undefined}
                  />
                )}
              </div>
              <FieldControl field={field} value={fields[field.name]} onChange={(v) => onChange(field.name, v)} />
              {field.notes && <div className="field-note">{field.notes}</div>}
            </div>
          );
        })}
      </div>

      </fieldset>

      <div className="review-actions">
        <div className="review-actions-status">
          {readOnly ? (
            <span>Finalized. Press Edit to change it.</span>
          ) : flaggedCount > 0 ? (
            <>
              <span>
                {flaggedCount} field{flaggedCount === 1 ? '' : 's'} need{flaggedCount === 1 ? 's' : ''} attention
              </span>
              <button type="button" className="btn small" onClick={goToNextFlagged}>
                Next ↓
              </button>
            </>
          ) : null}
        </div>
        <div className="review-actions-buttons">
          {readOnly ? (
            onEdit && (
              <button className="btn" onClick={onEdit}>
                Edit
              </button>
            )
          ) : (
            <>
              <button className="btn" onClick={onSave}>
                Save corrections
              </button>
              {onFinalize && (
                <button className="btn primary" onClick={onFinalize}>
                  Save &amp; finalize report
                </button>
              )}
            </>
          )}
        </div>
      </div>
        </div>
      </div>
    </div>
  );
}
