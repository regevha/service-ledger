import { useEffect, useRef, useState } from 'react';
import { ApiError, createReportTemplate, getTemplateSuggestions, listAllReportTemplates, listInstrumentTypes, updateReportTemplate, type InstrumentType, type ReportTemplate, type ReportType, type TemplateField, type TemplateUsage } from '../../api';
import { REPORT_TYPE_LABEL } from '../../labels';
import { type TemplateRequest } from '../../templateRequest';
import { SuggestInput } from '../SuggestInput';
import { droppedFieldNames, fieldToPayload, templateProblems } from './fieldSchema';
import { FieldSchemaEditor } from './FieldSchemaEditor';

/** One entry of the "Start from" list: an existing template and why it is offered. */
export interface StartOption {
  template: ReportTemplate;
  reason: string;
}

export function TemplateFormScreen({
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
  const [instrumentType, setInstrumentType] = useState(seed?.instrument_type ?? request?.instrumentType ?? '');
  useEffect(() => {
    listInstrumentTypes()
      .then((list) => {
        setTypes(list);
        // A new template starts with the default type (an existing one keeps its own).
        setInstrumentType((current) => current || (list.find((t) => t.is_default)?.key ?? list[0]?.key ?? ''));
      })
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
        <label className="schema-form-label" data-testid="form-label">
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
        <label className="schema-form-label" data-testid="form-label">
          Report type
          <select value={reportType} onChange={(e) => setReportType(e.target.value as ReportType)}>
            {(Object.keys(REPORT_TYPE_LABEL) as ReportType[]).map((rt) => (
              <option key={rt} value={rt}>
                {REPORT_TYPE_LABEL[rt]}
              </option>
            ))}
          </select>
        </label>
        <label className="schema-form-label" data-testid="form-label">
          Model
          <SuggestInput
            className="text-input"
            placeholder="e.g. Aurora — blank applies to every model"
            value={model}
            onChange={setModel}
            options={knownModels}
          />
        </label>
      </div>

      {isCreate && (
        <div className="schema-form-row" id="start-from">
          <label className="schema-form-label" data-testid="form-label">
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
