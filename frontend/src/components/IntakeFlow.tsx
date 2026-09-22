import { useState } from 'react';
import {
  ApiError,
  attachmentFileUrl,
  classifyAttachment,
  confirmTemplate,
  createReport,
  extractAttachment,
  findTemplate,
  finalizeReport,
  getReport,
  pollExtractionJob,
  reportPdfUrl,
  updateReportFields,
  uploadAttachment,
  type ClassificationResult,
  type Instrument,
  type Report,
  type ReportTemplate,
  type ReportType,
} from '../api';
import { REPORT_TYPE_LABEL } from '../labels';
import { ConfidenceBadge } from './ConfidenceBadge';
import { ReviewScreen } from './ReviewScreen';

/**
 * The "New report" tab's full upload → classify → review → finalize wizard
 * (§4/§5) — split out of App.tsx (which used to own this entire state
 * machine directly) into its own file, the same way the app's other major
 * screens (AnalyticsScreen, TemplateManager, InstrumentManager,
 * ReportsListScreen) already live under components/. App.tsx now just
 * mounts this component on the "New report" tab and hands it the fleet
 * list + the two confidence thresholds from GET /config; every other piece
 * of intake state (the current step, the in-progress report, its
 * classification/extraction results, the technician's in-progress
 * corrections) lives here, local to the flow that produces it.
 */

type Phase =
  | { name: 'intake' }
  | { name: 'working'; label: string }
  | { name: 'confirm-classification' }
  | { name: 'review' }
  | { name: 'done' }
  | { name: 'error'; message: string; retry: () => void };

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

export function IntakeFlow({
  instruments,
  instrumentByModel,
  instrumentsError,
  fieldConfidenceThreshold,
  classificationConfidenceThreshold,
}: {
  instruments: Instrument[];
  instrumentByModel: Map<string, Instrument>;
  instrumentsError: string | null;
  fieldConfidenceThreshold: number;
  classificationConfidenceThreshold: number;
}) {
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

  // Every step below (upload, classify, resolve-template, extract, save)
  // follows the same shape: show a "working" phase, run some API calls, and
  // on any failure land on the *same* error phase — a banner with the
  // ApiError's own message (or a step-specific fallback for a network/
  // unexpected failure) and a "Try again" button that just re-runs that same
  // step with its original arguments. `failPhase` is that landing (also used
  // directly for a job that finished with status 'failed', which isn't a
  // thrown exception); `attempt` wraps a step's body so each step below only
  // states its fallback message, its retry, and what it actually does.
  function failPhase(message: string, retry: () => void) {
    setPhase({ name: 'error', message, retry });
  }

  async function attempt(fallbackMessage: string, retry: () => void, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (e) {
      failPhase(e instanceof ApiError ? e.message : fallbackMessage, retry);
    }
  }

  async function runExtraction(attId: string, reportId: string, tpl: ReportTemplate) {
    setPhase({ name: 'working', label: 'Reading the resolved template with Claude vision…' });
    await attempt('Extraction failed unexpectedly.', () => void runExtraction(attId, reportId, tpl), async () => {
      // §3/§9: this only enqueues the job — app/worker.py is what actually
      // runs it — so wait for it to leave pending/extracting before reading
      // the result back.
      const submitted = await extractAttachment(attId);
      const job = await pollExtractionJob(submitted.id);
      if (job.status === 'failed') {
        failPhase(job.error_message || 'Extraction failed for an unknown reason.', () => void runExtraction(attId, reportId, tpl));
        return;
      }
      const refreshed = await getReport(reportId);
      setReport(refreshed);
      setFieldConfidences(job.field_confidences ?? {});
      setFields(refreshed.extracted_fields ?? {});
      setPhase({ name: 'review' });
    });
  }

  async function resolveAndExtract(reportId: string, attId: string, model: string, reportType: ReportType, instrumentId: string) {
    setPhase({ name: 'working', label: 'Resolving the matching template…' });
    await attempt(
      'Could not resolve a template.',
      () => void resolveAndExtract(reportId, attId, model, reportType, instrumentId),
      async () => {
        const tpl = await findTemplate(model, reportType);
        if (!tpl) throw new ApiError(404, `No template resolves for ${model} / ${reportType}.`);
        const updated = await confirmTemplate(reportId, instrumentId, tpl.id);
        setReport(updated);
        setTemplate(tpl);
        await runExtraction(attId, reportId, tpl);
      }
    );
  }

  async function runClassification(attId: string, reportId: string) {
    setPhase({ name: 'working', label: 'Classifying instrument & report type…' });
    await attempt('Classification failed unexpectedly.', () => void runClassification(attId, reportId), async () => {
      // §3/§9: submit returns a pending job immediately; app/worker.py picks
      // it up in the background and this polls until it's done.
      const submitted = await classifyAttachment(attId);
      const job = await pollExtractionJob(submitted.id);
      if (job.status === 'failed') {
        failPhase(
          job.error_message || 'Classification failed for an unknown reason.',
          () => void runClassification(attId, reportId)
        );
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
    });
  }

  async function handleStart() {
    if (!file) return;
    setPhase({ name: 'working', label: 'Uploading scan…' });
    await attempt('Upload failed unexpectedly.', () => void handleStart(), async () => {
      const newReport = await createReport({ technician_name: technicianName || null });
      setReport(newReport);
      const attachment = await uploadAttachment(newReport.id, file);
      setAttachmentId(attachment.id);
      await runClassification(attachment.id, newReport.id);
    });
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
    await attempt('Saving failed unexpectedly.', () => void handleSaveFields(finalize), async () => {
      const updated = await updateReportFields(report.id, { extracted_fields: fields });
      let final = updated;
      if (finalize) final = await finalizeReport(report.id);
      setReport(final);
      setPhase(finalize ? { name: 'done' } : { name: 'review' });
    });
  }

  return (
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
          classificationConfidenceThreshold={classificationConfidenceThreshold}
          onConfirm={() => void handleConfirmClassification()}
        />
      )}

      {phase.name === 'review' && template && (
        <ReviewScreen
          template={template}
          fields={fields}
          fieldConfidences={fieldConfidences}
          fieldConfidenceThreshold={fieldConfidenceThreshold}
          onChange={(name, value) => setFields((prev) => ({ ...prev, [name]: value }))}
          onSave={() => void handleSaveFields(false)}
          onFinalize={() => void handleSaveFields(true)}
          originalScanUrl={attachmentId ? attachmentFileUrl(attachmentId) : undefined}
          pdfUrl={report ? reportPdfUrl(report.id) : undefined}
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
  );
}
