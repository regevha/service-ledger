import { useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  classifyAttachment,
  confirmTemplate,
  createReport,
  extractAttachment,
  findTemplate,
  finalizeReport,
  getReport,
  listInstruments,
  updateReportFields,
  uploadAttachment,
  type ClassificationResult,
  type Instrument,
  type Report,
  type ReportTemplate,
  type ReportType,
} from './api';
import { FieldControl } from './components/FieldEditor';
import './App.css';

// Mirrors backend/app/config.py defaults. Cosmetic only here — badge color
// on the review screen and on the classify-confirm step — the actual
// classify/extract gating decision is already made server-side (a resolved
// report/template vs. a 502) before the frontend ever sees these numbers.
const FIELD_CONFIDENCE_THRESHOLD = 0.7;
const CLASSIFICATION_CONFIDENCE_THRESHOLD = 0.85;

const REPORT_TYPE_LABEL: Record<ReportType, string> = {
  calibration: 'Calibration',
  repair: 'Malfunction / repair',
  preventive_maintenance: 'Preventive maintenance',
};

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
      const job = await extractAttachment(attId);
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
      const result = await classifyAttachment(attId);
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
        <span className="mark" /> Calibration Ledger
        <span className="masthead-sub">core review loop</span>
      </div>

      <div className="app-shell">
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
            onConfirm={() => void handleConfirmClassification()}
          />
        )}

        {phase.name === 'review' && template && (
          <ReviewScreen
            template={template}
            fields={fields}
            fieldConfidences={fieldConfidences}
            onChange={(name, value) => setFields((prev) => ({ ...prev, [name]: value }))}
            onSave={() => void handleSaveFields(false)}
            onFinalize={() => void handleSaveFields(true)}
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
  onConfirm,
}: {
  classification: ClassificationResult;
  instruments: Instrument[];
  pickInstrumentModel: string;
  setPickInstrumentModel: (v: string) => void;
  pickReportType: ReportType;
  setPickReportType: (v: ReportType) => void;
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
          <ConfidenceBadge confidence={classification.instrument.confidence} threshold={CLASSIFICATION_CONFIDENCE_THRESHOLD} />
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
          <ConfidenceBadge confidence={classification.report_type.confidence} threshold={CLASSIFICATION_CONFIDENCE_THRESHOLD} />
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
  onChange,
  onSave,
  onFinalize,
}: {
  template: ReportTemplate;
  fields: Record<string, unknown>;
  fieldConfidences: Record<string, number>;
  onChange: (name: string, value: unknown) => void;
  onSave: () => void;
  onFinalize: () => void;
}) {
  const flaggedCount = template.field_schema.fields.filter(
    (f) => (fieldConfidences[f.name] ?? 1) < FIELD_CONFIDENCE_THRESHOLD
  ).length;

  return (
    <div className="section">
      <div className="section-title">
        {REPORT_TYPE_LABEL[template.report_type]} — {flaggedCount} field{flaggedCount === 1 ? '' : 's'} need your attention
      </div>

      <div className="field-list">
        {template.field_schema.fields.map((field, i) => {
          const confidence = fieldConfidences[field.name];
          const flagged = confidence !== undefined && confidence < FIELD_CONFIDENCE_THRESHOLD;
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
                {confidence !== undefined && <ConfidenceBadge confidence={confidence} threshold={FIELD_CONFIDENCE_THRESHOLD} />}
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
        <button className="btn primary" onClick={onFinalize}>
          Save &amp; finalize report
        </button>
      </div>
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
