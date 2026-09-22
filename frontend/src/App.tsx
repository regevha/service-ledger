import { useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  attachmentFileUrl,
  classifyAttachment,
  confirmTemplate,
  createReport,
  extractAttachment,
  findTemplate,
  finalizeReport,
  getAppConfig,
  getReport,
  listInstruments,
  listReports,
  pollExtractionJob,
  reportsExportUrl,
  updateReportFields,
  uploadAttachment,
  type AppConfig,
  type ClassificationResult,
  type Instrument,
  type Report,
  type ReportFilters,
  type ReportListItem,
  type ReportStatus,
  type ReportTemplate,
  type ReportType,
} from './api';
import { AnalyticsScreen } from './components/AnalyticsScreen';
import { FieldControl } from './components/FieldEditor';
import { REPORT_TYPE_LABEL } from './labels';
import './App.css';

// Fallback only, for the brief window before GET /config resolves (or if it
// fails) — matches backend/app/config.py's own defaults so behavior is
// unchanged in that window. The real values always come from the backend
// from then on (see the config state below); this used to be two hardcoded
// constants with no connection to the backend's actual settings at all.
const DEFAULT_APP_CONFIG: AppConfig = {
  field_confidence_threshold: 0.7,
  classification_confidence_threshold: 0.85,
};

const STATUS_LABEL: Record<ReportStatus, string> = {
  draft: 'Draft',
  classified: 'Classified',
  extracted: 'Extracted',
  in_review: 'In review',
  finalized: 'Finalized',
};

const STATUS_OPTIONS: ReportStatus[] = ['draft', 'classified', 'extracted', 'in_review', 'finalized'];

type Phase =
  | { name: 'intake' }
  | { name: 'working'; label: string }
  | { name: 'confirm-classification' }
  | { name: 'review' }
  | { name: 'done' }
  | { name: 'error'; message: string; retry: () => void };

function ConfidenceBadge({ confidence, threshold }: { confidence: number; threshold: number }) {
  const pct = Math.round(confidence * 100);
  const ok = confidence >= threshold;
  return <span className={`badge ${ok ? 'badge-good' : 'badge-warn'}`}>{pct}% {ok ? 'confident' : 'needs review'}</span>;
}

export default function App() {
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [instrumentsError, setInstrumentsError] = useState<string | null>(null);
  const [config, setConfig] = useState<AppConfig>(DEFAULT_APP_CONFIG);

  // Independent of `phase` below — `phase` is the single-report intake state
  // machine (upload → classify → review → done), while `view` just switches
  // which top-level screen is showing. Switching to 'reports' and back
  // leaves an in-progress intake exactly where it was.
  const [view, setView] = useState<'new' | 'reports' | 'analytics'>('new');

  const [phase, setPhase] = useState<Phase>({ name: 'intake' });

  const [technicianName, setTechnicianName] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const [report, setReport] = useState<Report | null>(null);
  const [classification, setClassification] = useState<ClassificationResult | null>(null);
  const [attachmentId, setAttachmentId] = useState<string | null>(null);
  const [template, setTemplate] = useState<ReportTemplate | null>(null);
  const [fieldConfidences, setFieldConfidences] = useState<Record<string, number>>({});
  const [fields, setFields] = useState<Record<string, unknown>>({});

  const [pickInstrumentModel, setPickInstrumentModel] = useState('');
  const [pickReportType, setPickReportType] = useState<ReportType>('repair');

  useEffect(() => {
    listInstruments()
      .then(setInstruments)
      .catch((e: unknown) => setInstrumentsError(e instanceof ApiError ? e.message : 'Could not load instruments.'));
  }, []);

  useEffect(() => {
    // Cosmetic-only if this never resolves (badge color / review-flagging),
    // so failure here just means staying on DEFAULT_APP_CONFIG rather than
    // surfacing a banner the way instrumentsError does above.
    getAppConfig()
      .then(setConfig)
      .catch(() => undefined);
  }, []);

  const instrumentByModel = useMemo(() => {
    const map = new Map<string, Instrument>();
    for (const inst of instruments) map.set(inst.model, inst);
    return map;
  }, [instruments]);

  function resetToIntake() {
    setPhase({ name: 'intake' });
    setTechnicianName('');
    setFile(null);
    setReport(null);
    setClassification(null);
    setAttachmentId(null);
    setTemplate(null);
    setFieldConfidences({});
    setFields({});
  }

  async function runExtraction(attId: string, reportId: string, tpl: ReportTemplate) {
    setPhase({ name: 'working', label: 'Reading the resolved template with Claude vision…' });
    try {
      // §3/§9: this only enqueues the job — app/worker.py is what actually
      // runs it — so wait for it to leave pending/extracting before reading
      // the result back.
      const submitted = await extractAttachment(attId);
      const job = await pollExtractionJob(submitted.id);
      if (job.status === 'failed') {
        setPhase({
          name: 'error',
          message: job.error_message || 'Extraction failed for an unknown reason.',
          retry: () => void runExtraction(attId, reportId, tpl),
        });
        return;
      }
      const refreshed = await getReport(reportId);
      setReport(refreshed);
      setFieldConfidences(job.field_confidences ?? {});
      setFields(refreshed.extracted_fields ?? {});
      setPhase({ name: 'review' });
    } catch (e) {
      setPhase({
        name: 'error',
        message: e instanceof ApiError ? e.message : 'Extraction failed unexpectedly.',
        retry: () => void runExtraction(attId, reportId, tpl),
      });
    }
  }

  async function resolveAndExtract(reportId: string, attId: string, model: string, reportType: ReportType, instrumentId: string) {
    setPhase({ name: 'working', label: 'Resolving the matching template…' });
    try {
      const tpl = await findTemplate(model, reportType);
      if (!tpl) throw new ApiError(404, `No template resolves for ${model} / ${reportType}.`);
      const updated = await confirmTemplate(reportId, instrumentId, tpl.id);
      setReport(updated);
      setTemplate(tpl);
      await runExtraction(attId, reportId, tpl);
    } catch (e) {
      setPhase({
        name: 'error',
        message: e instanceof ApiError ? e.message : 'Could not resolve a template.',
        retry: () => void resolveAndExtract(reportId, attId, model, reportType, instrumentId),
      });
    }
  }

  async function runClassification(attId: string, reportId: string) {
    setPhase({ name: 'working', label: 'Classifying instrument & report type…' });
    try {
      // §3/§9: submit returns a pending job immediately; app/worker.py picks
      // it up in the background and this polls until it's done.
      const submitted = await classifyAttachment(attId);
      const job = await pollExtractionJob(submitted.id);
      if (job.status === 'failed') {
        setPhase({
          name: 'error',
          message: job.error_message || 'Classification failed for an unknown reason.',
          retry: () => void runClassification(attId, reportId),
        });
        return;
      }
      const result = job.classification as unknown as ClassificationResult;
      setClassification(result);
      if (result.resolved_template_id && result.resolved_instrument_id) {
        const tpl = await findTemplate(result.instrument.value, result.report_type.value as ReportType);
        if (!tpl) throw new ApiError(404, 'Classification resolved a template id the frontend could not look up.');
        setTemplate(tpl);
        const refreshed = await getReport(reportId);
        setReport(refreshed);
        await runExtraction(attId, reportId, tpl);
      } else {
        setPickInstrumentModel(result.instrument.value);
        setPickReportType((result.report_type.value as ReportType) ?? 'repair');
        setPhase({ name: 'confirm-classification' });
      }
    } catch (e) {
      setPhase({
        name: 'error',
        message: e instanceof ApiError ? e.message : 'Classification failed unexpectedly.',
        retry: () => void runClassification(attId, reportId),
      });
    }
  }

  async function handleStart() {
    if (!file) return;
    setPhase({ name: 'working', label: 'Uploading scan…' });
    try {
      const newReport = await createReport({ technician_name: technicianName || null });
      setReport(newReport);
      const attachment = await uploadAttachment(newReport.id, file);
      setAttachmentId(attachment.id);
      await runClassification(attachment.id, newReport.id);
    } catch (e) {
      setPhase({
        name: 'error',
        message: e instanceof ApiError ? e.message : 'Upload failed unexpectedly.',
        retry: () => void handleStart(),
      });
    }
  }

  async function handleConfirmClassification() {
    if (!report || !attachmentId) return;
    const instrument = instrumentByModel.get(pickInstrumentModel);
    if (!instrument) return;
    await resolveAndExtract(report.id, attachmentId, pickInstrumentModel, pickReportType, instrument.id);
  }

  async function handleSaveFields(finalize: boolean) {
    if (!report) return;
    setPhase({ name: 'working', label: finalize ? 'Saving and finalizing…' : 'Saving corrections…' });
    try {
      const updated = await updateReportFields(report.id, { extracted_fields: fields });
      let final = updated;
      if (finalize) final = await finalizeReport(report.id);
      setReport(final);
      setPhase(finalize ? { name: 'done' } : { name: 'review' });
    } catch (e) {
      setPhase({
        name: 'error',
        message: e instanceof ApiError ? e.message : 'Saving failed unexpectedly.',
        retry: () => void handleSaveFields(finalize),
      });
    }
  }

  return (
    <div className="wrap">
      <div className="masthead">
        <span className="mark" /> ServiceLedger
        <span className="masthead-sub">core review loop</span>
      </div>

      <div className="view-tabs">
        <button className={`view-tab ${view === 'new' ? 'active' : ''}`} onClick={() => setView('new')}>
          New report
        </button>
        <button className={`view-tab ${view === 'reports' ? 'active' : ''}`} onClick={() => setView('reports')}>
          Reports
        </button>
        <button className={`view-tab ${view === 'analytics' ? 'active' : ''}`} onClick={() => setView('analytics')}>
          Analytics
        </button>
      </div>

      <div className="app-shell">
        {view === 'analytics' ? (
          <AnalyticsScreen />
        ) : view === 'reports' ? (
          <ReportsListScreen instruments={instruments} fieldConfidenceThreshold={config.field_confidence_threshold} />
        ) : (
          <>
            <StepBar phase={phase} />

            {instrumentsError && <div className="banner banner-warn">{instrumentsError}</div>}

            {phase.name === 'intake' && (
              <IntakeScreen
                technicianName={technicianName}
                setTechnicianName={setTechnicianName}
                file={file}
                setFile={setFile}
                onStart={() => void handleStart()}
              />
            )}

            {phase.name === 'working' && (
              <div className="section working-panel">
                <div className="spinner" />
                <div>{phase.label}</div>
              </div>
            )}

            {phase.name === 'confirm-classification' && classification && (
              <ConfirmClassificationScreen
                classification={classification}
                instruments={instruments}
                pickInstrumentModel={pickInstrumentModel}
                setPickInstrumentModel={setPickInstrumentModel}
                pickReportType={pickReportType}
                setPickReportType={setPickReportType}
                classificationConfidenceThreshold={config.classification_confidence_threshold}
                onConfirm={() => void handleConfirmClassification()}
              />
            )}

            {phase.name === 'review' && template && (
              <ReviewScreen
                template={template}
                fields={fields}
                fieldConfidences={fieldConfidences}
                fieldConfidenceThreshold={config.field_confidence_threshold}
                onChange={(name, value) => setFields((prev) => ({ ...prev, [name]: value }))}
                onSave={() => void handleSaveFields(false)}
                onFinalize={() => void handleSaveFields(true)}
                originalScanUrl={attachmentId ? attachmentFileUrl(attachmentId) : undefined}
              />
            )}

            {phase.name === 'done' && report && <DoneScreen report={report} onReset={resetToIntake} />}

            {phase.name === 'error' && (
              <div className="section">
                <div className="banner banner-crit">{phase.message}</div>
                <div className="cta-row">
                  <button className="btn" onClick={resetToIntake}>
                    Start over
                  </button>
                  <button className="btn primary" onClick={phase.retry}>
                    Try again
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function StepBar({ phase }: { phase: Phase }) {
  const stepIndex =
    phase.name === 'intake'
      ? 0
      : phase.name === 'confirm-classification' || (phase.name === 'working' && phase.label.includes('lassif'))
        ? 1
        : phase.name === 'review' || phase.name === 'done'
          ? 2
          : phase.name === 'working'
            ? 1
            : 0;
  const steps = ['Upload', 'Classify', 'Review & finalize'];
  return (
    <div className="steps">
      {steps.map((label, i) => (
        <div key={label} className={`step ${i === stepIndex ? 'active' : ''} ${i < stepIndex ? 'done' : ''}`}>
          <span className="num">{i < stepIndex ? '✓' : i + 1}</span> {label}
        </div>
      ))}
    </div>
  );
}

function IntakeScreen({
  technicianName,
  setTechnicianName,
  file,
  setFile,
  onStart,
}: {
  technicianName: string;
  setTechnicianName: (v: string) => void;
  file: File | null;
  setFile: (f: File | null) => void;
  onStart: () => void;
}) {
  return (
    <div className="section">
      <div className="section-title">Technician</div>
      <input
        type="text"
        className="text-input"
        placeholder="Your name (optional)"
        value={technicianName}
        onChange={(e) => setTechnicianName(e.target.value)}
      />

      <div className="section-title" style={{ marginTop: 18 }}>
        Scanned original
      </div>
      <label className="dropzone">
        <div className="icon">📄</div>
        <div className="primary">{file ? file.name : 'Click to choose a scan or PDF'}</div>
        <div className="secondary">Printed BD service forms and PDF exports — one file per report, any instrument, any report type</div>
        <input type="file" accept="application/pdf,image/*" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>

      <div className="cta-row">
        <button className="btn primary" disabled={!file} onClick={onStart}>
          Upload &amp; classify
        </button>
      </div>
    </div>
  );
}

function ConfirmClassificationScreen({
  classification,
  instruments,
  pickInstrumentModel,
  setPickInstrumentModel,
  pickReportType,
  setPickReportType,
  classificationConfidenceThreshold,
  onConfirm,
}: {
  classification: ClassificationResult;
  instruments: Instrument[];
  pickInstrumentModel: string;
  setPickInstrumentModel: (v: string) => void;
  pickReportType: ReportType;
  setPickReportType: (v: ReportType) => void;
  classificationConfidenceThreshold: number;
  onConfirm: () => void;
}) {
  return (
    <div className="section">
      <div className="section-title">Detected from the document</div>
      <p className="hint-text">
        Instrument ID is usually a confident read. Report type is the harder call — a repair, a PM visit, and a
        calibration can share the same generic layout — so it needs your confirmation this time.
      </p>

      <div className="class-row">
        <div className="crow-top">
          <span className="clabel">Instrument</span>
          <ConfidenceBadge confidence={classification.instrument.confidence} threshold={classificationConfidenceThreshold} />
        </div>
        <select value={pickInstrumentModel} onChange={(e) => setPickInstrumentModel(e.target.value)}>
          {instruments.map((inst) => (
            <option key={inst.id} value={inst.model}>
              {inst.model} ({inst.serial_number})
            </option>
          ))}
        </select>
      </div>

      <div className="class-row">
        <div className="crow-top">
          <span className="clabel">Report type</span>
          <ConfidenceBadge confidence={classification.report_type.confidence} threshold={classificationConfidenceThreshold} />
        </div>
        <select value={pickReportType} onChange={(e) => setPickReportType(e.target.value as ReportType)}>
          {(Object.keys(REPORT_TYPE_LABEL) as ReportType[]).map((rt) => (
            <option key={rt} value={rt}>
              {REPORT_TYPE_LABEL[rt]}
            </option>
          ))}
        </select>
      </div>

      <div className="cta-row">
        <button className="btn primary" disabled={!pickInstrumentModel} onClick={onConfirm}>
          Confirm &amp; continue to extraction →
        </button>
      </div>
    </div>
  );
}

function ReviewScreen({
  template,
  fields,
  fieldConfidences,
  fieldConfidenceThreshold,
  onChange,
  onSave,
  onFinalize,
  title,
  originalScanUrl,
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

function ReportsListScreen({
  instruments,
  fieldConfidenceThreshold,
}: {
  instruments: Instrument[];
  fieldConfidenceThreshold: number;
}) {
  const [filters, setFilters] = useState<ReportFilters>({});
  const [items, setItems] = useState<ReportListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<ReportListItem | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listReports(filters)
      .then((list) => {
        if (!cancelled) setItems(list);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : 'Could not load reports.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters]);

  if (selectedItem) {
    return (
      <ReportDetailScreen
        item={selectedItem}
        onBack={() => setSelectedItem(null)}
        fieldConfidenceThreshold={fieldConfidenceThreshold}
      />
    );
  }

  const hasFilters = Boolean(filters.instrument_id || filters.report_type || filters.status || filters.date_from || filters.date_to);

  return (
    <div className="section">
      <div className="section-title">Reports</div>

      <div className="filter-row">
        <select
          value={filters.instrument_id ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, instrument_id: e.target.value || undefined }))}
        >
          <option value="">All instruments</option>
          {instruments.map((inst) => (
            <option key={inst.id} value={inst.id}>
              {inst.model} ({inst.serial_number})
            </option>
          ))}
        </select>

        <select
          value={filters.report_type ?? ''}
          onChange={(e) =>
            setFilters((f) => ({ ...f, report_type: (e.target.value || undefined) as ReportType | undefined }))
          }
        >
          <option value="">All report types</option>
          {(Object.keys(REPORT_TYPE_LABEL) as ReportType[]).map((rt) => (
            <option key={rt} value={rt}>
              {REPORT_TYPE_LABEL[rt]}
            </option>
          ))}
        </select>

        <select
          value={filters.status ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, status: (e.target.value || undefined) as ReportStatus | undefined }))}
        >
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>

        <input
          type="date"
          aria-label="From date"
          value={filters.date_from ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, date_from: e.target.value || undefined }))}
        />
        <span className="filter-sep">to</span>
        <input
          type="date"
          aria-label="To date"
          value={filters.date_to ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, date_to: e.target.value || undefined }))}
        />

        {hasFilters && (
          <button className="btn small" onClick={() => setFilters({})}>
            Clear filters
          </button>
        )}
      </div>

      {error && <div className="banner banner-warn">{error}</div>}

      {loading ? (
        <div className="working-panel">
          <div className="spinner" />
          <div>Loading reports…</div>
        </div>
      ) : items.length === 0 ? (
        <div className="empty-hint">No reports match these filters.</div>
      ) : (
        <>
          <div className="table-toolbar">
            <span className="table-toolbar-count">
              {items.length} report{items.length === 1 ? '' : 's'}
            </span>
            <a className="btn small" href={reportsExportUrl(filters)}>
              ⬇ Export CSV
            </a>
          </div>
          <div className="report-table">
            <div className="report-row report-row-head">
              <span>Instrument</span>
              <span>Type</span>
              <span>Technician</span>
              <span>Report date</span>
              <span>Status</span>
            </div>
            {items.map((r) => (
              <button className="report-row report-row-body" key={r.id} onClick={() => setSelectedItem(r)}>
                <span>
                  {r.instrument_model ?? '—'}
                  {r.instrument_serial_number ? ` (${r.instrument_serial_number})` : ''}
                </span>
                <span>{r.report_type ? REPORT_TYPE_LABEL[r.report_type] : '—'}</span>
                <span>{r.technician_name ?? '—'}</span>
                <span>{r.report_date ?? '—'}</span>
                <span className={`status-pill status-${r.status}`}>{STATUS_LABEL[r.status]}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ReportDetailScreen({
  item,
  onBack,
  fieldConfidenceThreshold,
}: {
  item: ReportListItem;
  onBack: () => void;
  fieldConfidenceThreshold: number;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [template, setTemplate] = useState<ReportTemplate | null>(null);
  const [fields, setFields] = useState<Record<string, unknown>>({});
  const [busyLabel, setBusyLabel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const r = await getReport(item.id);
        if (cancelled) return;
        setReport(r);
        setFields(r.extracted_fields ?? {});
        // GET /reports/{id} only carries instrument_id/template_id (raw
        // ReportOut, §9) — the list item already resolved those to display
        // names (§7), which is exactly what findTemplate needs, so reuse it
        // instead of adding a get-template-by-id endpoint for this one screen.
        if (item.instrument_model && item.report_type) {
          const tpl = await findTemplate(item.instrument_model, item.report_type);
          if (!cancelled) setTemplate(tpl);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiError ? e.message : 'Could not load report.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [item]);

  async function handleSave(finalize: boolean) {
    if (!report) return;
    setBusyLabel(finalize ? 'Saving and finalizing…' : 'Saving corrections…');
    try {
      const updated = await updateReportFields(report.id, { extracted_fields: fields });
      const final = finalize ? await finalizeReport(report.id) : updated;
      setReport(final);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Saving failed unexpectedly.');
    } finally {
      setBusyLabel(null);
    }
  }

  return (
    <div className="section">
      <button className="btn small back-link" onClick={onBack}>
        ← Back to reports
      </button>

      {error && <div className="banner banner-warn">{error}</div>}

      {loading || busyLabel ? (
        <div className="working-panel">
          <div className="spinner" />
          <div>{busyLabel ?? 'Loading report…'}</div>
        </div>
      ) : report && template ? (
        <ReviewScreen
          template={template}
          fields={fields}
          fieldConfidences={{}}
          fieldConfidenceThreshold={fieldConfidenceThreshold}
          onChange={(name, value) => setFields((prev) => ({ ...prev, [name]: value }))}
          onSave={() => void handleSave(false)}
          onFinalize={
            report.status === 'extracted' || report.status === 'in_review' ? () => void handleSave(true) : undefined
          }
          title={`${REPORT_TYPE_LABEL[template.report_type]} — ${STATUS_LABEL[report.status]}`}
          // §4: "one file per report" for MVP, so the first (only) attachment
          // is the original this report's fields came from.
          originalScanUrl={report.attachments[0] ? attachmentFileUrl(report.attachments[0].id) : undefined}
        />
      ) : report ? (
        <div className="empty-hint">
          No template could be resolved for this report (its instrument or report type isn't set), so its fields
          can't be shown here.
        </div>
      ) : null}
    </div>
  );
}

function DoneScreen({ report, onReset }: { report: Report; onReset: () => void }) {
  return (
    <div className="section success-panel">
      <div className="tick">✓</div>
      <h3>Report finalized</h3>
      <p>
        Report <code>{report.id.slice(0, 8)}</code> is now <b>{report.status}</b>
        {report.finalized_at ? ` as of ${new Date(report.finalized_at).toLocaleString()}` : ''}.
      </p>
      <button className="btn primary" onClick={onReset}>
        Start another report
      </button>
    </div>
  );
}
