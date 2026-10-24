import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  createReportTemplate,
  deleteReportTemplate,
  getTemplateSuggestions,
  getTemplateUsage,
  listAllReportTemplates,
  listInstrumentTypes,
  updateReportTemplate,
  type FieldType,
  type InstrumentType,
  type ItemSchemaColumn,
  type ReportTemplate,
  type ReportType,
  type TemplateField,
  type TemplateFieldPayload,
  type TemplateUsage,
} from '../api';
import { EnumArrayInput } from './FieldEditor';
import { RowMenu } from './RowMenu';
import { fieldLabel } from '../fieldLabels';
import { FieldAliasManagerScreen } from './FieldAliasManager';
import { TemplateCompareScreen } from './TemplateCompare';
import { REPORT_TYPE_LABEL } from '../labels';
import type { TemplateRequest } from '../templateRequest';

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

/**
 * What stops a template from being saved, in words. Checked as the user
 * types so the reason is on screen, instead of a Save button that is just
 * greyed out (or a round trip to the backend's 422).
 */
export function templateProblems(fields: TemplateField[]): string[] {
  const problems: string[] = [];
  if (fields.length === 0) problems.push('Add at least one field.');
  if (fields.some((f) => !f.name.trim())) problems.push('Every field needs a name.');
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const f of fields) {
    const key = f.name.trim().toLowerCase();
    if (!key) continue;
    if (seen.has(key)) repeated.add(f.name.trim());
    seen.add(key);
  }
  if (repeated.size > 0) problems.push(`Field names must be unique: ${[...repeated].join(', ')} appears more than once.`);
  for (const f of fields) {
    const label = f.name.trim() || 'A choice field';
    if ((f.type === 'enum' || f.type === 'enum[]') && (f.options ?? []).length === 0) {
      problems.push(`${label} needs at least one option.`);
    }
    if (f.type === 'object[]' && (f.item_schema ?? []).length === 0) {
      problems.push(`${f.name.trim() || 'A table field'} needs at least one column.`);
    }
  }
  return problems;
}

/** Names that exist on the saved template but not in the edited one (removed or renamed). */
function droppedFieldNames(existing: ReportTemplate | undefined, fields: TemplateField[]): string[] {
  if (!existing) return [];
  const kept = new Set(fields.map((f) => f.name.trim()));
  return existing.field_schema.fields.map((f) => f.name).filter((name) => !kept.has(name));
}

/** One entry of the "Start from" list: an existing template and why it is offered. */
interface StartOption {
  template: ReportTemplate;
  reason: string;
}

function TemplateFormScreen({
  existing,
  copyOf,
  request,
  usage,
  knownModels,
  onCancel,
  onSaved,
}: {
  existing?: ReportTemplate;
  /** Start a new template from this one's fields (the Duplicate button). */
  copyOf?: ReportTemplate;
  /** A waiting report asked for this template: prefill it and start from the closest existing one. */
  request?: TemplateRequest;
  usage?: TemplateUsage;
  knownModels: string[];
  onCancel: () => void;
  onSaved: (saved?: ReportTemplate) => void;
}) {
  const seed = existing ?? copyOf;
  const isCreate = !existing && !copyOf;
  const [types, setTypes] = useState<InstrumentType[]>([]);
  const [instrumentType, setInstrumentType] = useState(seed?.instrument_type ?? request?.instrumentType ?? 'facs');
  useEffect(() => {
    listInstrumentTypes()
      .then(setTypes)
      .catch(() => setTypes([]));
  }, []);
  const [reportType, setReportType] = useState<ReportType>(seed?.report_type ?? request?.reportType ?? 'repair');
  // A copy starts with a blank model: the same report type + model already
  // has a template (the one being copied), and only one is allowed.
  const [model, setModel] = useState(existing ? (existing.model ?? '') : (request?.model ?? ''));
  const [fields, setFields] = useState<TemplateField[]>(() => structuredClone(seed?.field_schema.fields ?? []));

  // "Start from": the closest existing templates for this type and model, best
  // first. Picking one copies its fields in; nothing is applied until Create.
  const [startOptions, setStartOptions] = useState<StartOption[]>([]);
  const [startFrom, setStartFrom] = useState('');
  // The option that was applied, kept even when a later search for suggestions
  // (the model or report type changed) no longer lists it, so the select still
  // shows what the fields came from.
  const [startPinned, setStartPinned] = useState<StartOption | null>(null);
  // Remounts the field editor when the fields are replaced wholesale (it keeps
  // its own per-row identity, which would otherwise point at the old rows).
  const [fieldsVersion, setFieldsVersion] = useState(0);
  // True once the person has edited the fields, so replacing them asks first.
  const [touched, setTouched] = useState(false);
  const [pendingStart, setPendingStart] = useState<string | null>(null);
  const autoApplied = useRef(false);

  useEffect(() => {
    if (!isCreate) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      getTemplateSuggestions({ reportType, instrumentType, model: model.trim() || null })
        .then(async (list): Promise<StartOption[]> => {
          if (list.length > 0) return list.map((s) => ({ template: s.template, reason: `${s.reason}, ${s.field_count} fields` }));
          // Nothing shares the report type: fall back to every template of this
          // instrument type, labelled as a different report type.
          const all = await listAllReportTemplates();
          return all
            .filter((t) => t.instrument_type === instrumentType)
            .map((t) => ({
              template: t,
              reason: `${REPORT_TYPE_LABEL[t.report_type]} template (different report type), ${t.field_schema.fields.length} fields`,
            }));
        })
        .then((options) => {
          if (!cancelled) setStartOptions(options);
        })
        .catch(() => {
          if (!cancelled) setStartOptions([]);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isCreate, reportType, instrumentType, model]);

  function applyStart(id: string) {
    const option = startOptions.find((o) => o.template.id === id);
    setFields(option ? structuredClone(option.template.field_schema.fields) : []);
    setFieldsVersion((v) => v + 1);
    setTouched(false);
    setPendingStart(null);
    setStartFrom(id);
    setStartPinned(option ?? null);
  }

  function chooseStart(id: string) {
    if (id === startFrom) return;
    if (touched && fields.length > 0) {
      setPendingStart(id);
      return;
    }
    applyStart(id);
  }

  // Opened for a waiting report: start from the best suggestion without being
  // asked. The person can pick another one, or Blank, and edit everything.
  useEffect(() => {
    if (!request || autoApplied.current || startOptions.length === 0) return;
    autoApplied.current = true;
    applyStart(startOptions[0].template.id);
  }, [request, startOptions]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when saving would drop fields that reports already use — the user
  // has to confirm before it goes through.
  const [confirmDrop, setConfirmDrop] = useState<string[] | null>(null);
  const inUse = (usage?.report_count ?? 0) > 0;

  function requestSave() {
    const dropped = inUse ? droppedFieldNames(existing, fields) : [];
    if (dropped.length > 0 && confirmDrop === null) {
      setConfirmDrop(dropped);
      return;
    }
    void handleSave();
  }

  async function handleSave() {
    setConfirmDrop(null);
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
        onSaved();
      } else {
        const created = await createReportTemplate({
          instrument_type: instrumentType,
          report_type: reportType,
          model: model.trim() ? model.trim() : null,
          fields: payloadFields,
        });
        onSaved(created);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save this template.');
    } finally {
      setSaving(false);
    }
  }

  const problems = templateProblems(fields);
  const canSave = problems.length === 0 && !saving;

  return (
    <div className="section">
      <button type="button" className="btn small back-link" onClick={onCancel}>
        ← Back to templates
      </button>

      <div className="section-title">{existing ? 'Edit template' : 'New template'}</div>

      {request && (
        <div className="banner banner-info" id="template-request-notice">
          A {REPORT_TYPE_LABEL[request.reportType]} report for {request.model} is waiting. Save a template for it and the report is
          read again with it automatically.
        </div>
      )}
      {copyOf && (
        <div className="banner banner-warn" id="copy-notice">
          This is a copy of the {REPORT_TYPE_LABEL[copyOf.report_type]} template for {copyOf.model ?? 'any model'}. Each
          report type and model can have only one template, so choose a different model (or report type) before saving.
        </div>
      )}
      {existing && inUse && (
        <div className="banner banner-warn" id="template-in-use-notice">
          {usage!.report_count} report{usage!.report_count === 1 ? '' : 's'} use{usage!.report_count === 1 ? 's' : ''} this
          template ({usage!.finalized_count} finalized). Their saved values are kept, but a field you remove or rename stops
          appearing on them.
        </div>
      )}
      {error && <div className="banner banner-crit">{error}</div>}

      <div className="schema-form-row">
        <label className="schema-form-label">
          Instrument type
          <select
            id="template-instrument-type"
            value={instrumentType}
            disabled={existing !== undefined}
            onChange={(e) => setInstrumentType(e.target.value)}
          >
            {types.length === 0 && <option value={instrumentType}>{instrumentType}</option>}
            {types.map((t) => (
              <option key={t.key} value={t.key}>
                {t.display_name}
              </option>
            ))}
          </select>
        </label>
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
            list="known-models"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
          <datalist id="known-models">
            {knownModels.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
      </div>

      {isCreate && (
        <div className="schema-form-row" id="start-from">
          <label className="schema-form-label">
            Start from
            <select id="template-start-from" value={startFrom} onChange={(e) => chooseStart(e.target.value)}>
              <option value="">Blank (no starting template)</option>
              {[...startOptions, ...(startPinned && !startOptions.some((o) => o.template.id === startPinned.template.id) ? [startPinned] : [])].map((o) => (
                <option key={o.template.id} value={o.template.id}>
                  {REPORT_TYPE_LABEL[o.template.report_type]} · {o.template.model ?? '(any model)'}: {o.reason}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {pendingStart !== null && (
        <div className="banner banner-warn" role="alertdialog" aria-label="Confirm replacing fields">
          <div>Starting from another template replaces the fields below, including the changes you made.</div>
          <button type="button" className="btn small" onClick={() => applyStart(pendingStart)}>
            Replace fields
          </button>{' '}
          <button type="button" className="btn small" onClick={() => setPendingStart(null)}>
            Keep my fields
          </button>
        </div>
      )}

      <div className="section-title" style={{ marginTop: 18 }}>
        Fields
      </div>
      <FieldSchemaEditor
        key={fieldsVersion}
        fields={fields}
        onChange={(next) => {
          setFields(next);
          setTouched(true);
        }}
      />

      {problems.length > 0 && (
        <ul className="banner banner-warn template-problems" id="template-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      {confirmDrop && (
        <div className="banner banner-warn" role="alertdialog" aria-label="Confirm removing fields">
          <div>
            {confirmDrop.join(', ')} {confirmDrop.length === 1 ? 'is' : 'are'} no longer in this template, and{' '}
            {usage!.report_count} report{usage!.report_count === 1 ? ' uses' : 's use'} it. Those fields will stop
            appearing on them (the stored values are not deleted).
          </div>
          <button type="button" className="btn small" onClick={() => void handleSave()}>
            Save anyway
          </button>{' '}
          <button type="button" className="btn small" onClick={() => setConfirmDrop(null)}>
            Keep editing
          </button>
        </div>
      )}

      <div className="cta-row">
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="btn primary" onClick={requestSave} disabled={!canSave}>
          {saving ? 'Saving…' : existing ? 'Save changes' : 'Create template'}
        </button>
      </div>
    </div>
  );
}

type ManagerMode =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'compare'; left: ReportTemplate | null }
  | { kind: 'aliases' }
  | { kind: 'copy'; template: ReportTemplate }
  | { kind: 'edit'; template: ReportTemplate };

export function TemplateManagerScreen({
  knownModels = [],
  request = null,
  onRequestClose,
}: {
  knownModels?: string[];
  /** A waiting report's request: opens straight into a prefilled new-template form. */
  request?: TemplateRequest | null;
  /** The request is over: `saved` is the template that was created for it, absent when the form was cancelled. */
  onRequestClose?: (saved?: ReportTemplate) => void;
}) {
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);
  const [usage, setUsage] = useState<Record<string, TemplateUsage>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ManagerMode>(() => (request ? { kind: 'create' } : { kind: 'list' }));
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [typeNames, setTypeNames] = useState<Record<string, string>>({});

  useEffect(() => {
    listInstrumentTypes()
      .then((rows) => setTypeNames(Object.fromEntries(rows.map((t) => [t.key, t.display_name]))))
      .catch(() => setTypeNames({}));
  }, []);

  function reload() {
    setLoading(true);
    setError(null);
    // Usage is advisory (warnings, the Reports column): if it cannot be read
    // the list still works, without the counts.
    getTemplateUsage()
      .then((rows) => setUsage(Object.fromEntries(rows.map((u) => [u.template_id, u]))))
      .catch(() => setUsage({}));
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

  const backToList = () => {
    setMode({ kind: 'list' });
    if (request) onRequestClose?.();
  };
  const savedAndBack = (saved?: ReportTemplate) => {
    setMode({ kind: 'list' });
    reload();
    if (request && saved) onRequestClose?.(saved);
  };
  if (mode.kind === 'create') {
    return (
      <TemplateFormScreen
        knownModels={knownModels}
        request={request ?? undefined}
        onCancel={backToList}
        onSaved={savedAndBack}
      />
    );
  }
  if (mode.kind === 'compare') {
    return (
      <TemplateCompareScreen
        templates={templates}
        typeNames={typeNames}
        initialLeft={mode.left}
        onBack={() => setMode({ kind: 'list' })}
        onManageAliases={() => setMode({ kind: 'aliases' })}
      />
    );
  }
  if (mode.kind === 'aliases') {
    return <FieldAliasManagerScreen onBack={() => setMode({ kind: 'list' })} />;
  }
  if (mode.kind === 'copy') {
    return <TemplateFormScreen copyOf={mode.template} knownModels={knownModels} onCancel={backToList} onSaved={savedAndBack} />;
  }
  if (mode.kind === 'edit') {
    return (
      <TemplateFormScreen
        existing={mode.template}
        usage={usage[mode.template.id]}
        knownModels={knownModels}
        onCancel={backToList}
        onSaved={savedAndBack}
      />
    );
  }

  return (
    <div className="section">
      <div className="section-title-row">
        <div className="section-title">Report templates</div>
        <div className="section-title-actions">
          <button
            type="button"
            className="btn small"
            id="compare-templates"
            disabled={templates.length < 2}
            title={templates.length < 2 ? 'There need to be two templates to compare.' : undefined}
            onClick={() => setMode({ kind: 'compare', left: null })}
          >
            Compare templates
          </button>
          <button type="button" className="btn small" id="field-aliases" onClick={() => setMode({ kind: 'aliases' })}>
            Field aliases
          </button>
          <button type="button" className="btn small primary" onClick={() => setMode({ kind: 'create' })}>
            + New template
          </button>
        </div>
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
            <span>Reports</span>
            <span>Actions</span>
          </div>
          {templates.map((tpl) => (
            <div className="template-row template-row-body" key={tpl.id}>
              <span data-label="Report type">{REPORT_TYPE_LABEL[tpl.report_type]}</span>
              <span data-label="Model">
                {tpl.model ?? '(any model)'}
                <small className="muted"> · {typeNames[tpl.instrument_type] ?? tpl.instrument_type}</small>
              </span>
              <span data-label="Fields">{tpl.field_schema.fields.length}</span>
              <span className="template-usage" data-label="Reports">
                {usage[tpl.id] ? `${usage[tpl.id].report_count} (${usage[tpl.id].finalized_count} finalized)` : '0'}
              </span>
              <span className="template-row-actions">
                <button type="button" className="btn small" onClick={() => setMode({ kind: 'edit', template: tpl })}>
                  Edit
                </button>
                {confirmDeleteId === tpl.id ? (
                  <>
                    <button type="button" className="btn small danger solid" onClick={() => void handleDelete(tpl.id)}>
                      Confirm delete
                    </button>
                    <button type="button" className="btn small" onClick={() => setConfirmDeleteId(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <RowMenu
                    label={`More actions for ${REPORT_TYPE_LABEL[tpl.report_type]} template`}
                    items={[
                      { label: 'Duplicate', onSelect: () => setMode({ kind: 'copy', template: tpl }) },
                      { label: 'Compare', onSelect: () => setMode({ kind: 'compare', left: tpl }) },
                      {
                        label: 'Delete',
                        danger: true,
                        disabled: Boolean(usage[tpl.id]),
                        title: usage[tpl.id] ? `${usage[tpl.id].report_count} report(s) use this template, so it cannot be deleted.` : undefined,
                        onSelect: () => setConfirmDeleteId(tpl.id),
                      },
                    ]}
                  />
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
