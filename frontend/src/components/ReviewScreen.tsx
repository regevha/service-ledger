import { ConfidenceBadge } from './ConfidenceBadge';
import { FieldControl } from './FieldEditor';
import { REPORT_TYPE_LABEL } from '../labels';
import type { ReportTemplate } from '../api';

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
  fieldConfidences,
  fieldConfidenceThreshold,
  onChange,
  onSave,
  onFinalize,
  title,
  originalScanUrl,
  pdfUrl,
}: {
  template: ReportTemplate;
  fields: Record<string, unknown>;
  fieldConfidences: Record<string, number>;
  fieldConfidenceThreshold: number;
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
}) {
  const flaggedCount = template.field_schema.fields.filter(
    (f) => (fieldConfidences[f.name] ?? 1) < fieldConfidenceThreshold
  ).length;
  const heading =
    title ??
    `${REPORT_TYPE_LABEL[template.report_type]} — ${flaggedCount} field${flaggedCount === 1 ? '' : 's'} ${
      flaggedCount === 1 ? 'needs' : 'need'
    } your attention`;

  return (
    <div className="section">
      <div className="section-title-row">
        <div className="section-title">{heading}</div>
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

      <div className="field-list">
        {template.field_schema.fields.map((field, i) => {
          const confidence = fieldConfidences[field.name];
          const flagged = confidence !== undefined && confidence < fieldConfidenceThreshold;
          return (
            <div className={`field ${flagged ? 'pending' : 'ok'}`} key={field.name}>
              <div className="field-top">
                <span className="field-label">
                  <span className="badge-mini" style={{ background: flagged ? 'var(--warn)' : 'var(--good)' }}>
                    {i + 1}
                  </span>{' '}
                  {field.name.replace(/_/g, ' ')}
                  {field.unit && <span className="field-unit"> ({field.unit})</span>}
                </span>
                {confidence !== undefined && <ConfidenceBadge confidence={confidence} threshold={fieldConfidenceThreshold} />}
              </div>
              <FieldControl field={field} value={fields[field.name]} onChange={(v) => onChange(field.name, v)} />
              {field.notes && <div className="field-note">{field.notes}</div>}
            </div>
          );
        })}
      </div>

      <div className="cta-row">
        <button className="btn" onClick={onSave}>
          Save corrections
        </button>
        {onFinalize && (
          <button className="btn primary" onClick={onFinalize}>
            Save &amp; finalize report
          </button>
        )}
      </div>
    </div>
  );
}
