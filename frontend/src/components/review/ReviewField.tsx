import { ConfidenceBadge } from '../ConfidenceBadge';
import { FieldControl, FieldLabelContext } from '../FieldEditor';
import { fieldLabel } from '../../fieldLabels';
import type { ReportTemplate } from '../../api';

/** One field of the report: label, confidence or "suggested" badge, mark-as-checked button and its editor. */
export function ReviewField({
  field,
  index: i,
  confidence,
  flagged,
  readOnly,
  isPersonField,
  threshold: fieldConfidenceThreshold,
  placeholderValues,
  value,
  onChange,
  onMarkChecked,
}: {
  field: ReportTemplate['field_schema']['fields'][number];
  index: number;
  confidence: number | undefined;
  flagged: boolean;
  readOnly: boolean;
  isPersonField: boolean;
  threshold: number;
  placeholderValues: boolean;
  value: unknown;
  onChange: (value: unknown) => void;
  onMarkChecked: () => void;
}) {
  return (
    <div
      className={`field ${flagged ? 'pending' : 'ok'}`}
      data-field={field.name}
      role="group"
      aria-labelledby={`review-field-${i}-label`}
    >
      <div className="field-top">
        <span className="field-label" id={`review-field-${i}-label`}>
          <span className="badge-mini" style={{ background: flagged ? 'var(--flag)' : 'var(--good)' }}>
            {i + 1}
          </span>{' '}
          {fieldLabel(field.name, field.unit)}
          {field.unit && <span className="field-unit"> ({field.unit})</span>}
        </span>
        {flagged && !readOnly && <span className="sr-only">Needs checking.</span>}
        {isPersonField && !readOnly ? (
          <span className={`badge ${flagged ? 'badge-warn' : 'badge-good'}`} data-testid="person-field-badge">
            {flagged ? 'suggested, check it' : 'checked'}
          </span>
        ) : (
          confidence !== undefined && (
            <ConfidenceBadge
              confidence={confidence}
              threshold={fieldConfidenceThreshold}
              label={placeholderValues ? 'placeholder' : undefined}
            />
          )
        )}
      </div>
      {flagged && !readOnly && (
        <button
          type="button"
          className="btn small mark-checked"
          aria-label={`Mark as checked: ${fieldLabel(field.name, field.unit)}`}
          onClick={() => onMarkChecked()}
        >
          Mark as checked
        </button>
      )}
      <FieldLabelContext.Provider value={fieldLabel(field.name, field.unit)}>
        <FieldControl field={field} value={value} onChange={onChange} />
      </FieldLabelContext.Provider>
      {field.notes && <div className="field-note">{field.notes}</div>}
    </div>
  );
}
