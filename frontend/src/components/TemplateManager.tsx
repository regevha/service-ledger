import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  createReportTemplate,
  deleteReportTemplate,
  listAllReportTemplates,
  updateReportTemplate,
  type FieldType,
  type ItemSchemaColumn,
  type ReportTemplate,
  type ReportType,
  type TemplateField,
  type TemplateFieldPayload,
} from '../api';
import { EnumArrayInput } from './FieldEditor';
import { REPORT_TYPE_LABEL } from '../labels';

/**
 * The Templates tab: CRUD for report_templates rows, replacing "edit
 * seed_templates.py's Python literals and re-run the script" as the only
 * way to change what a report type's review screen asks for. A structured
 * form (add/remove/reorder fields, a per-field-type dropdown with
 * conditional inputs for options/item_schema) rather than a raw JSON
 * textarea — the whole field_schema shape it edits is exactly what
 * FieldEditor.tsx already knows how to render, so this is a purpose-built
 * editor for that shape, not a generic JSON blob editor.
 */

const FIELD_TYPE_OPTIONS: { value: FieldType; label: string }[] = [
  { value: 'text', label: 'Text (long)' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Yes / No' },
  { value: 'date', label: 'Date' },
  { value: 'enum', label: 'Choice (one of…)' },
  { value: 'enum[]', label: 'Choices (any of…)' },
  { value: 'object[]', label: 'Table of rows' },
  { value: 'number[detector]', label: 'Per-detector numbers' },
  { value: 'number[laser]', label: 'Per-laser numbers' },
];

// object[]'s item_schema columns are always a leaf control — the backend
// (schemas.py's TemplateFieldIn) rejects anything else, since
// ObjectArrayInput's own table cells can only render a leaf input.
const LEAF_TYPE_OPTIONS: { value: FieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Yes / No' },
  { value: 'date', label: 'Date' },
];

function defaultFieldFor(type: FieldType): TemplateField {
  const base: TemplateField = { name: '', type, unit: null, notes: null };
  if (type === 'enum' || type === 'enum[]') return { ...base, options: [] };
  if (type === 'object[]') return { ...base, item_schema: [] };
  return base;
}

// A list of {name, type} columns, not a {name: type} dict — see
// ItemSchemaColumn (api.ts) for why: a dict's key order doesn't survive
// Postgres's JSONB storage, only a JSON array's element order does, and this
// editor is exactly what determines that order in the first place. Columns
// are still addressed by name (not index) for rename/type-change/remove, the
// same identity the old dict-keyed version used — the backend now also
// rejects duplicate column names outright (schemas.py), which the old dict
// shape could silently merge into data loss on a rename collision.
function ItemSchemaEditor({
  itemSchema,
  onChange,
}: {
  itemSchema: ItemSchemaColumn[];
  onChange: (v: ItemSchemaColumn[]) => void;
}) {
  const columns = itemSchema;
  // Bumped per-column when a rename is rejected below, to force that
  // column's (uncontrolled) name input to remount and re-read its
  // defaultValue instead of keeping the rejected text on screen.
  const [revertNonce, setRevertNonce] = useState<Record<string, number>>({});

  function renameColumn(name: string, newName: string) {
    const trimmed = newName.trim();
    if (trimmed === name) return;
    // A blank name is rejected the same way as a collision below: the
    // input must be reset too, or it keeps showing empty while the old name
    // is what actually gets saved.
    if (!trimmed || columns.some((c) => c.name === trimmed)) {
      // Reject a rename that collides with another existing column name.
      // The backend rejects duplicate column names outright (schemas.py),
      // and setColumnType/removeColumn below both match "the" column by
      // c.name — silently allowing two columns to share a name here would
      // make a later type change or remove on either one act on both at
      // once instead of just the one the user touched.
      setRevertNonce((prev) => ({ ...prev, [name]: (prev[name] ?? 0) + 1 }));
      return;
    }
    onChange(columns.map((c) => (c.name === name ? { ...c, name: trimmed } : c)));
  }
  function setColumnType(name: string, type: FieldType) {
    onChange(columns.map((c) => (c.name === name ? { ...c, type } : c)));
  }
  function removeColumn(name: string) {
    onChange(columns.filter((c) => c.name !== name));
  }
  function addColumn() {
    const existingNames = new Set(columns.map((c) => c.name));
    let n = 1;
    while (existingNames.has(`column_${n}`)) n += 1;
    onChange([...columns, { name: `column_${n}`, type: 'text' }]);
  }

  return (
    <div className="schema-field-extra">
      <span className="schema-field-extra-label">Table columns</span>
      {columns.length === 0 && <div className="empty-hint">No columns yet.</div>}
      {columns.map((c) => (
        <div className="item-schema-row" key={c.name}>
          <input
            type="text"
            className="text-input"
            key={`name-${revertNonce[c.name] ?? 0}`}
            defaultValue={c.name}
            aria-label="Column name"
            onBlur={(e) => renameColumn(c.name, e.target.value)}
          />
          <select value={c.type} onChange={(e) => setColumnType(c.name, e.target.value as FieldType)} aria-label="Column type">
            {LEAF_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <button type="button" className="row-remove" onClick={() => removeColumn(c.name)}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="btn small" onClick={addColumn}>
        + Add column
      </button>
    </div>
  );
}

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
  // reads name/type/unit/notes/options/item_schema off a field) — kept in
  // lockstep with `fields` by this component's own add/remove/move handlers,
  // the only things that ever change its length or order.
  const [fieldKeys, setFieldKeys] = useState<number[]>(() => fields.map((_, i) => i));
  const nextFieldKey = useRef(fields.length);

  function updateField(i: number, patch: Partial<TemplateField>) {
    onChange(fields.map((f, j) => (i === j ? { ...f, ...patch } : f)));
  }
  function changeType(i: number, type: FieldType) {
    const current = fields[i];
    onChange(fields.map((f, j) => (i === j ? { ...defaultFieldFor(type), name: current.name, unit: current.unit, notes: current.notes } : f)));
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
            <input
              type="text"
              className="text-input"
              placeholder="field_name"
              aria-label="Field name"
              value={field.name}
              onChange={(e) => updateField(i, { name: e.target.value })}
            />
            <select value={field.type} onChange={(e) => changeType(i, e.target.value as FieldType)} aria-label="Field type">
              {FIELD_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button type="button" className="row-remove" onClick={() => removeField(i)}>
              Remove
            </button>
          </div>

          <div className="schema-field-meta">
            <input
              type="text"
              className="text-input"
              placeholder="Unit (optional, e.g. psi)"
              aria-label="Unit"
              value={field.unit ?? ''}
              onChange={(e) => updateField(i, { unit: e.target.value || null })}
            />
            <input
              type="text"
              className="text-input"
              placeholder="Notes for the technician (optional)"
              aria-label="Notes"
              value={field.notes ?? ''}
              onChange={(e) => updateField(i, { notes: e.target.value || null })}
            />
          </div>

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

function fieldToPayload(field: TemplateField): TemplateFieldPayload {
  return {
    name: field.name.trim(),
    type: field.type,
    unit: field.unit || null,
    notes: field.notes || null,
    ...(field.options ? { options: field.options } : {}),
    ...(field.item_schema ? { item_schema: field.item_schema } : {}),
  };
}

function TemplateFormScreen({
  existing,
  onCancel,
  onSaved,
}: {
  existing?: ReportTemplate;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [reportType, setReportType] = useState<ReportType>(existing?.report_type ?? 'repair');
  const [model, setModel] = useState(existing?.model ?? '');
  const [fields, setFields] = useState<TemplateField[]>(existing?.field_schema.fields ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const payloadFields = fields.map(fieldToPayload);
      if (existing) {
        await updateReportTemplate(existing.id, {
          report_type: reportType,
          model: model.trim() ? model.trim() : null,
          fields: payloadFields,
        });
      } else {
        await createReportTemplate({
          report_type: reportType,
          model: model.trim() ? model.trim() : null,
          fields: payloadFields,
        });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save this template.');
    } finally {
      setSaving(false);
    }
  }

  const canSave = fields.length > 0 && fields.every((f) => f.name.trim().length > 0) && !saving;

  return (
    <div className="section">
      <button type="button" className="btn small back-link" onClick={onCancel}>
        ← Back to templates
      </button>

      <div className="section-title">{existing ? 'Edit template' : 'New template'}</div>

      {error && <div className="banner banner-crit">{error}</div>}

      <div className="schema-form-row">
        <label className="schema-form-label">
          Report type
          <select value={reportType} onChange={(e) => setReportType(e.target.value as ReportType)}>
            {(Object.keys(REPORT_TYPE_LABEL) as ReportType[]).map((rt) => (
              <option key={rt} value={rt}>
                {REPORT_TYPE_LABEL[rt]}
              </option>
            ))}
          </select>
        </label>
        <label className="schema-form-label">
          Model
          <input
            type="text"
            className="text-input"
            placeholder="e.g. FACSDiscover S8 — blank applies to every model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </label>
      </div>

      <div className="section-title" style={{ marginTop: 18 }}>
        Fields
      </div>
      <FieldSchemaEditor fields={fields} onChange={setFields} />

      <div className="cta-row">
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="btn primary" onClick={() => void handleSave()} disabled={!canSave}>
          {saving ? 'Saving…' : existing ? 'Save changes' : 'Create template'}
        </button>
      </div>
    </div>
  );
}

type ManagerMode = { kind: 'list' } | { kind: 'create' } | { kind: 'edit'; template: ReportTemplate };

export function TemplateManagerScreen() {
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ManagerMode>({ kind: 'list' });
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  function reload() {
    setLoading(true);
    setError(null);
    listAllReportTemplates()
      .then(setTemplates)
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not load templates.'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    reload();
  }, []);

  async function handleDelete(id: string) {
    try {
      await deleteReportTemplate(id);
      setConfirmDeleteId(null);
      reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not delete this template.');
      setConfirmDeleteId(null);
    }
  }

  if (mode.kind === 'create') {
    return <TemplateFormScreen onCancel={() => setMode({ kind: 'list' })} onSaved={() => { setMode({ kind: 'list' }); reload(); }} />;
  }
  if (mode.kind === 'edit') {
    return (
      <TemplateFormScreen
        existing={mode.template}
        onCancel={() => setMode({ kind: 'list' })}
        onSaved={() => {
          setMode({ kind: 'list' });
          reload();
        }}
      />
    );
  }

  return (
    <div className="section">
      <div className="section-title-row">
        <div className="section-title">Report templates</div>
        <button type="button" className="btn small primary" onClick={() => setMode({ kind: 'create' })}>
          + New template
        </button>
      </div>

      {error && <div className="banner banner-warn">{error}</div>}

      {loading ? (
        <div className="working-panel">
          <div className="spinner" />
          <div>Loading templates…</div>
        </div>
      ) : templates.length === 0 ? (
        <div className="empty-hint">No templates yet.</div>
      ) : (
        <div className="template-table">
          <div className="template-row template-row-head">
            <span>Report type</span>
            <span>Model</span>
            <span>Fields</span>
            <span>Actions</span>
          </div>
          {templates.map((tpl) => (
            <div className="template-row template-row-body" key={tpl.id}>
              <span>{REPORT_TYPE_LABEL[tpl.report_type]}</span>
              <span>{tpl.model ?? '(any model)'}</span>
              <span>{tpl.field_schema.fields.length}</span>
              <span className="template-row-actions">
                <button type="button" className="btn small" onClick={() => setMode({ kind: 'edit', template: tpl })}>
                  Edit
                </button>
                {confirmDeleteId === tpl.id ? (
                  <>
                    <button type="button" className="btn small" onClick={() => void handleDelete(tpl.id)}>
                      Confirm delete
                    </button>
                    <button type="button" className="btn small" onClick={() => setConfirmDeleteId(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn small" onClick={() => setConfirmDeleteId(tpl.id)}>
                    Delete
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
