import { useEffect, useState } from 'react';
import { LoadError } from './LoadError';
import { ApiError, deleteReportTemplate, getTemplateUsage, listAllReportTemplates, listInstrumentTypes, type ReportTemplate, type TemplateUsage } from '../api';
import { RowMenu } from './RowMenu';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { FieldAliasManagerScreen } from './FieldAliasManager';
import { TemplateCompareScreen } from './TemplateCompare';
import { REPORT_TYPE_LABEL } from '../labels';
import type { TemplateRequest } from '../templateRequest';
import { TemplateFormScreen } from './template/TemplateFormScreen';

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
  const [loadFailed, setLoadFailed] = useState(false);
  const phone = useMediaQuery('(max-width: 620px)');
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
    setLoadFailed(false);
    // Usage is advisory (warnings, the Reports column): if it cannot be read
    // the list still works, without the counts.
    getTemplateUsage()
      .then((rows) => setUsage(Object.fromEntries(rows.map((u) => [u.template_id, u]))))
      .catch(() => setUsage({}));
    listAllReportTemplates()
      .then(setTemplates)
      .catch((e: unknown) => {
        setError(e instanceof ApiError ? e.message : 'Could not load templates.');
        setLoadFailed(true);
      })
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
      <div className="section-title-row templates-head">
        <div className="section-title">Report templates</div>
        <div className="section-title-actions">
          {phone ? (
            <RowMenu
              label="More template actions"
              items={[
                {
                  label: 'Compare templates',
                  disabled: templates.length < 2,
                  title: templates.length < 2 ? 'There need to be two templates to compare.' : undefined,
                  onSelect: () => setMode({ kind: 'compare', left: null }),
                },
                { label: 'Field aliases', onSelect: () => setMode({ kind: 'aliases' }) },
              ]}
            />
          ) : (
            <>
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
            </>
          )}
          <button type="button" className="btn small primary" onClick={() => setMode({ kind: 'create' })}>
            + New template
          </button>
        </div>
      </div>

      {error && <LoadError message={error} onRetry={loadFailed ? reload : undefined} />}

      {loading ? (
        <div className="working-panel">
          <div className="spinner" />
          <div>Loading templates…</div>
        </div>
      ) : templates.length === 0 ? (
        // A failed load says so above; it is not an empty list.
        loadFailed ? null : <div className="empty-hint">No templates yet.</div>
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
            <div className="template-row template-row-body" data-testid="template-row" key={tpl.id}>
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
