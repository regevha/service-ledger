import { useRef, useState } from 'react';
import { type FieldType, type TemplateField } from '../../api';
import { EnumArrayInput } from '../FieldEditor';
import { fieldLabel } from '../../fieldLabels';
import { FIELD_TYPE_OPTIONS, defaultFieldFor } from './fieldSchema';
import { ItemSchemaEditor } from './ItemSchemaEditor';

export function FieldSchemaEditor({ fields, onChange }: { fields: TemplateField[]; onChange: (fields: TemplateField[]) => void }) {
  // TemplateField has no id of its own (api.ts) — key={i} used to key each
  // row on its *position*. moveField's array-swap changes which index each
  // field object lives at without ever unmounting anything, so on a reorder
  // React reused the row-i DOM node (now holding row-j's data) in place —
  // including any genuinely uncontrolled input inside it (an enum/enum[]
  // field's option-tag input in EnumArrayInput, see FieldEditor.tsx), whose
  // in-progress, uncommitted keystrokes then silently landed on whichever
  // field ended up in that same screen position instead of following the
  // row the user was actually typing into. fieldKeys is a locally-invented,
  // per-row identity — never sent to the backend (fieldToPayload only ever
  // reads name/type/unit/notes/options/item_schema/filled_by_person off a field) — kept in
  // lockstep with `fields` by this component's own add/remove/move handlers,
  // the only things that ever change its length or order.
  const [fieldKeys, setFieldKeys] = useState<number[]>(() => fields.map((_, i) => i));
  const nextFieldKey = useRef(fields.length);

  function updateField(i: number, patch: Partial<TemplateField>) {
    onChange(fields.map((f, j) => (i === j ? { ...f, ...patch } : f)));
  }
  function changeType(i: number, type: FieldType) {
    const current = fields[i];
    onChange(fields.map((f, j) => (i === j ? { ...defaultFieldFor(type), name: current.name, unit: current.unit, notes: current.notes, filled_by_person: current.filled_by_person, optional: current.optional, source: current.source } : f)));
  }
  function removeField(i: number) {
    onChange(fields.filter((_, j) => j !== i));
    setFieldKeys((prev) => prev.filter((_, j) => j !== i));
  }
  function moveField(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= fields.length) return;
    const next = [...fields];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
    setFieldKeys((prev) => {
      const nextKeys = [...prev];
      [nextKeys[i], nextKeys[j]] = [nextKeys[j], nextKeys[i]];
      return nextKeys;
    });
  }
  function addField() {
    onChange([...fields, defaultFieldFor('text')]);
    setFieldKeys((prev) => [...prev, nextFieldKey.current++]);
  }

  return (
    <div className="schema-editor">
      {fields.length === 0 && <div className="empty-hint">No fields yet — add the first one below.</div>}
      {fields.map((field, i) => (
        <div className="schema-field-row" key={fieldKeys[i] ?? i}>
          <div className="schema-field-main">
            <div className="schema-field-order">
              <button type="button" className="btn small" disabled={i === 0} onClick={() => moveField(i, -1)} aria-label="Move field up">
                ↑
              </button>
              <button
                type="button"
                className="btn small"
                disabled={i === fields.length - 1}
                onClick={() => moveField(i, 1)}
                aria-label="Move field down"
              >
                ↓
              </button>
            </div>
            <label className="schema-field-input">
              <span className="schema-field-caption">Field name</span>
              <input
                type="text"
                className="text-input"
                placeholder="field_name"
                aria-label="Field name"
                value={field.name}
                onChange={(e) => updateField(i, { name: e.target.value })}
              />
            </label>
            <label className="schema-field-input">
              <span className="schema-field-caption">Type</span>
              <select value={field.type} onChange={(e) => changeType(i, e.target.value as FieldType)} aria-label="Field type">
                {FIELD_TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="row-remove" onClick={() => removeField(i)}>
              Remove
            </button>
          </div>

          <div className="schema-field-meta">
            <label className="schema-field-input">
              <span className="schema-field-caption">Unit (optional)</span>
              <input
                type="text"
                className="text-input"
                placeholder="e.g. psi"
                aria-label="Unit"
                value={field.unit ?? ''}
                onChange={(e) => updateField(i, { unit: e.target.value || null })}
              />
            </label>
            <label className="schema-field-input">
              <span className="schema-field-caption">Notes for the lab manager (optional)</span>
              <input
                type="text"
                className="text-input"
                placeholder="Shown with the field on the review screen"
                aria-label="Notes"
                value={field.notes ?? ''}
                onChange={(e) => updateField(i, { notes: e.target.value || null })}
              />
            </label>
          </div>
          <label className="schema-field-check">
            <input
              type="checkbox"
              checked={Boolean(field.filled_by_person)}
              onChange={(e) => updateField(i, { filled_by_person: e.target.checked || undefined })}
            />
            Filled in by a person: not on the form, so the reading is only a suggestion and Review always asks to check it
          </label>
          <label className="schema-field-check">
            <input
              type="checkbox"
              checked={Boolean(field.optional)}
              onChange={(e) => updateField(i, { optional: e.target.checked || undefined })}
            />
            May be left empty: when the form does not state it, an empty value is fine and is not flagged
          </label>
          {field.name.trim() !== '' && (
            <div className="schema-field-preview">
              Shown as <b>{fieldLabel(field.name, field.unit ?? undefined)}</b>
              {field.unit ? ` (${field.unit})` : ''}
            </div>
          )}

          {(field.type === 'enum' || field.type === 'enum[]') && (
            <div className="schema-field-extra">
              <span className="schema-field-extra-label">Options</span>
              <EnumArrayInput value={field.options ?? []} onChange={(options) => updateField(i, { options })} />
            </div>
          )}

          {field.type === 'object[]' && (
            <ItemSchemaEditor itemSchema={field.item_schema ?? []} onChange={(item_schema) => updateField(i, { item_schema })} />
          )}
        </div>
      ))}
      <button type="button" className="btn small" onClick={addField}>
        + Add field
      </button>
    </div>
  );
}
