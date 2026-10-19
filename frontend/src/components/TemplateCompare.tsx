import { useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  compareTemplates,
  getTemplateSuggestions,
  type CompareAttribute,
  type ReportTemplate,
  type TemplateCompare,
  type TemplateCompareRow,
  type TemplateField,
} from '../api';
import { diffWords, type Segment } from '../diffWords';
import { FIELD_TYPE_LABEL, REPORT_TYPE_LABEL } from '../labels';

/**
 * Two templates of one instrument type side by side, with the fields lined up
 * and the differences marked (proposal-template-comparison.md, phase 1).
 *
 * Advice for a person only: nothing here changes, merges or renames a
 * template. What to do about a difference (rename a field, share a base, or
 * leave it) is decided by the person, and done in the template editor.
 */

const templateLabel = (t: ReportTemplate) => `${REPORT_TYPE_LABEL[t.report_type]} · ${t.model ?? '(any model)'}`;

const STATUS_LABEL: Record<TemplateCompareRow['status'], string> = {
  same: 'Same',
  differs: 'Differs',
  only_left: 'Only on the left',
  only_right: 'Only on the right',
  possible_match: 'Possible match',
};

const ATTRIBUTE_LABEL: Record<CompareAttribute, string> = {
  name: 'spelling',
  type: 'type',
  unit: 'unit',
  notes: 'notes',
  options: 'choices',
  item_schema: 'table columns',
};

function Marked({ segments }: { segments: Segment[] }) {
  return (
    <>
      {segments.map((s, i) => (
        <span key={i}>
          {i > 0 && ' '}
          {s.changed ? <mark>{s.text}</mark> : s.text}
        </span>
      ))}
    </>
  );
}

function FieldCell({
  field,
  other,
  differences,
}: {
  field: TemplateField | null;
  other: TemplateField | null;
  differences: CompareAttribute[];
}) {
  if (!field) return <span className="muted compare-absent">Not in this template</span>;
  const changed = (a: CompareAttribute) => differences.includes(a);
  const notes = (field.notes ?? '').trim();
  const otherNotes = (other?.notes ?? '').trim();
  const noteSegments: Segment[] = notes
    ? other && otherNotes && changed('notes')
      ? diffWords(notes, otherNotes).left
      : [{ text: notes, changed: changed('notes') }]
    : [];
  const otherOptions = new Set(other?.options ?? []);
  const columnText = (f: TemplateField) => (f.item_schema ?? []).map((c) => `${c.name} (${c.type})`).join(', ');

  return (
    <div className="compare-cell">
      {changed('name') && (
        <div>
          Named <mark>{field.name}</mark>
        </div>
      )}
      <div>
        {changed('type') ? <mark>{FIELD_TYPE_LABEL[field.type]}</mark> : FIELD_TYPE_LABEL[field.type]}
        {field.unit && (
          <>
            {' · '}
            {changed('unit') ? <mark>{field.unit}</mark> : field.unit}
          </>
        )}
      </div>
      {field.options && field.options.length > 0 && (
        <div className="compare-detail">
          Choices:{' '}
          {field.options.map((o, i) => (
            <span key={o}>
              {i > 0 && ', '}
              {changed('options') && !otherOptions.has(o) ? <mark>{o}</mark> : o}
            </span>
          ))}
        </div>
      )}
      {field.item_schema && field.item_schema.length > 0 && (
        <div className="compare-detail">
          Columns: {changed('item_schema') ? <mark>{columnText(field)}</mark> : columnText(field)}
        </div>
      )}
      {noteSegments.length > 0 && (
        <div className="compare-notes">
          <Marked segments={noteSegments} />
        </div>
      )}
    </div>
  );
}

export function TemplateCompareScreen({
  templates,
  typeNames,
  initialLeft = null,
  onBack,
  onManageAliases,
}: {
  templates: ReportTemplate[];
  typeNames: Record<string, string>;
  /** The template the person started from (the row's Compare action), if any. */
  initialLeft?: ReportTemplate | null;
  onBack: () => void;
  /** Opens the field aliases screen, where possible matches come from. */
  onManageAliases?: () => void;
}) {
  const [leftId, setLeftId] = useState(initialLeft?.id ?? '');
  const [rightId, setRightId] = useState('');
  // Answers from the server are kept with the question they answer, so a late
  // answer to an earlier choice is never shown for the current one and nothing
  // has to be reset inside an effect.
  const [closestFor, setClosestFor] = useState<{ templateId: string; ids: string[] } | null>(null);
  const [answer, setAnswer] = useState<{ key: string; result: TemplateCompare | null; error: string | null } | null>(null);
  const [onlyDifferences, setOnlyDifferences] = useState(false);

  const left = templates.find((t) => t.id === leftId) ?? null;
  const typeName = (t: ReportTemplate) => typeNames[t.instrument_type] ?? t.instrument_type;

  // The second template can only come from the same instrument type, closest
  // first: the same report type ranked the way the "Start from" list ranks
  // them (same model family, then the any-model template, then others), then
  // the rest of that type's templates.
  useEffect(() => {
    if (!left) return;
    let current = true;
    const templateId = left.id;
    getTemplateSuggestions({
      reportType: left.report_type,
      instrumentType: left.instrument_type,
      model: left.model,
      limit: 10,
    })
      .then((rows) => current && setClosestFor({ templateId, ids: rows.map((r) => r.template.id) }))
      .catch(() => current && setClosestFor({ templateId, ids: [] }));
    return () => {
      current = false;
    };
  }, [left]);
  const closest = closestFor && closestFor.templateId === leftId ? closestFor.ids : [];

  const candidates = useMemo(
    () => (left ? templates.filter((t) => t.instrument_type === left.instrument_type && t.id !== left.id) : []),
    [templates, left],
  );
  const closestRows = closest.map((id) => candidates.find((t) => t.id === id)).filter((t): t is ReportTemplate => Boolean(t));
  const otherRows = candidates.filter((t) => !closest.includes(t.id));

  function chooseLeft(id: string) {
    setLeftId(id);
    setRightId('');
  }

  const key = leftId && rightId ? `${leftId}|${rightId}` : '';
  useEffect(() => {
    if (!key) return;
    let current = true;
    compareTemplates(leftId, rightId)
      .then((result) => current && setAnswer({ key, result, error: null }))
      .catch(
        (e: unknown) =>
          current &&
          setAnswer({ key, result: null, error: e instanceof ApiError ? e.message : 'Could not compare these templates.' }),
      );
    return () => {
      current = false;
    };
  }, [key, leftId, rightId]);
  const shown = answer && answer.key === key ? answer : null;
  const result = shown?.result ?? null;
  const error = shown?.error ?? null;
  const loading = key !== '' && shown === null;

  const rows = result ? result.rows.filter((r) => !onlyDifferences || r.status !== 'same') : [];

  return (
    <div className="section">
      <button type="button" className="btn small back-link" onClick={onBack}>
        ← Back to templates
      </button>
      <div className="section-title">Compare templates</div>
      <div className="muted compare-intro">
        See how two templates of the same instrument type differ. This only shows the differences; nothing is changed.
        {onManageAliases && (
          <>
            {' '}
            Differently named fields that mean the same thing are paired using the{' '}
            <button type="button" className="link-button" onClick={onManageAliases}>
              field aliases
            </button>
            .
          </>
        )}
      </div>

      <div className="schema-form-row">
        <label className="schema-form-label">
          First template
          <select id="compare-left" value={leftId} onChange={(e) => chooseLeft(e.target.value)}>
            <option value="">Choose a template…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {templateLabel(t)} ({typeName(t)})
              </option>
            ))}
          </select>
        </label>
        <label className="schema-form-label">
          Second template
          <select id="compare-right" value={rightId} disabled={!left} onChange={(e) => setRightId(e.target.value)}>
            <option value="">{left ? 'Choose a template…' : 'Choose the first template first'}</option>
            {closestRows.length > 0 && (
              <optgroup label="Closest">
                {closestRows.map((t) => (
                  <option key={t.id} value={t.id}>
                    {templateLabel(t)}
                  </option>
                ))}
              </optgroup>
            )}
            {otherRows.length > 0 && (
              <optgroup label={closestRows.length > 0 ? 'Other templates' : 'Templates'}>
                {otherRows.map((t) => (
                  <option key={t.id} value={t.id}>
                    {templateLabel(t)}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
      </div>
      {left && candidates.length === 0 && (
        <div className="empty-hint">There is no other {typeName(left)} template to compare this one with.</div>
      )}

      {error && <div className="banner banner-warn">{error}</div>}
      {loading && (
        <div className="working-panel">
          <div className="spinner" />
          <div>Comparing…</div>
        </div>
      )}

      {result && (
        <>
          <div className="banner banner-info" id="compare-summary">
            {result.summary.shared} of {Math.max(result.summary.left_count, result.summary.right_count)} fields shared
            {' · '}
            {result.summary.same} identical, {result.summary.differs} differ
            {' · '}
            {result.summary.only_left} only in “{templateLabel(result.left)}”
            {' · '}
            {result.summary.only_right} only in “{templateLabel(result.right)}”
            {result.summary.possible_match > 0 && (
              <>
                {' · '}
                {result.summary.possible_match} possible match{result.summary.possible_match === 1 ? '' : 'es'}
              </>
            )}
          </div>
          <label className="compare-filter">
            <input type="checkbox" checked={onlyDifferences} onChange={(e) => setOnlyDifferences(e.target.checked)} /> Show only the
            differences
          </label>
          {rows.length === 0 ? (
            <div className="empty-hint" id="compare-identical">
              {result.rows.length === 0 ? 'Neither template has any fields.' : 'These two templates have identical fields.'}
            </div>
          ) : (
            <div className="compare-scroll">
              <table className="compare-table">
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    <th scope="col">{templateLabel(result.left)}</th>
                    <th scope="col">{templateLabel(result.right)}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={`${row.name}-${i}`} className={`compare-row compare-${row.status}`} data-status={row.status} data-field={row.name}>
                      <th scope="row">
                        <div className="compare-name">{row.name}</div>
                        <span className={`compare-chip compare-chip-${row.status}`}>
                          {STATUS_LABEL[row.status]}
                          {(row.status === 'differs' || row.status === 'possible_match') &&
                            `: ${row.differences.map((d) => ATTRIBUTE_LABEL[d]).join(', ')}`}
                        </span>
                        {row.status === 'possible_match' && row.concept && (
                          <div className="muted compare-concept">Listed as the same thing: {row.concept.label ?? row.concept.names.join(', ')}</div>
                        )}
                      </th>
                      <td>
                        <FieldCell field={row.left} other={row.right} differences={row.status === 'differs' || row.status === 'possible_match' ? row.differences : []} />
                      </td>
                      <td>
                        <FieldCell field={row.right} other={row.left} differences={row.status === 'differs' || row.status === 'possible_match' ? row.differences : []} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
