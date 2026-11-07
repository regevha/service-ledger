import { fieldLabel } from '../../fieldLabels';
import type { ReportTemplate } from '../../api';

/** The side rail listing every field (and the service date) with a mark for checked or needs checking. */
export function ReviewRail({
  template,
  reportDateFlagged,
  isFlagged,
  readOnly,
  onGo,
}: {
  template: ReportTemplate;
  reportDateFlagged: boolean;
  isFlagged: (name: string) => boolean;
  readOnly: boolean;
  onGo: (name: string) => void;
}) {
  return (
    <nav className="review-rail" aria-label="Fields" data-testid="review-rail">
      <div className="review-rail-title">Fields</div>
      <ul>
        {[{ name: 'report_date', label: 'Service date', n: '', flagged: reportDateFlagged }, ...template.field_schema.fields.map((f, i) => ({ name: f.name, label: fieldLabel(f.name, f.unit), n: String(i + 1), flagged: isFlagged(f.name) }))].map((r) => (
          <li key={r.name}>
            <button type="button" className={`review-rail-item${r.flagged && !readOnly ? ' flagged' : ''}`} onClick={() => onGo(r.name)}>
              <span className="review-rail-num">{r.n}</span>
              <span className="review-rail-label">{r.label}</span>
              <span className="review-rail-mark" aria-label={r.flagged && !readOnly ? 'needs checking' : 'checked'}>{r.flagged && !readOnly ? '!' : '✓'}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
