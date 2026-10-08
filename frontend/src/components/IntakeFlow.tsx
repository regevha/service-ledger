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
  getReportTemplate,
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
  // Every "working" phase before the review screen (upload, classify,
  // resolve-template, extract) counts as step 1 ("Classify") below — there's
  // no separate step for those sub-stages. But handleSaveFields's two
  // "working" labels ("Saving corrections…"/"Saving and finalizing…") fire
  // *from* the review screen, not before it, so without checking for them
  // here they'd fall through to the same step-1 default and the bar would
  // visibly jump backward from "Review & finalize" to "Classify" while a
  // save/finalize is in flight.
  const stepIndex =
    phase.name === 'intake'
      ? 0
      : phase.name === 'confirm-classification' || (phase.name === 'working' && phase.label.includes('lassif'))
        ? 1
        : phase.name === 'review' || phase.name === 'done' || (phase.name === 'working' && phase.label.includes('aving'))
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
        <div className="secondary">Printed BD service forms as a PDF or a PNG, JPEG, GIF or WebP image — one file per report, any instrument, any report type</div>
        <input type="file" accept="application/pdf,image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>

      <div className="cta-row">
        <button className="btn primary" disabled={!file} onClick={onStart}>
          Upload &amp; classify
        </button>
      </div>
    </div>
  );
}

type SerialNotice = { tone: 'info' | 'warn'; text: string };

/**
 * The warning shown when the document is already on file: the upload found a
 * report holding the same bytes, or classification found one with the same
 * work-order number. `duplicates` maps each such report id to the report once
 * it has loaded (null while loading or if it could not be loaded — the warning
 * still shows, just less specifically). A warning only: the technician may
 * legitimately attach the same document to a second report.
 */
function describeDuplicates(duplicates: Record<string, Report | null>): string | null {
  const reports = Object.values(duplicates);
  if (reports.length === 0) return null;
  const describe = (r: Report | null) => {
    if (!r) return 'another report';
    const who = r.technician_name ? ` by ${r.technician_name}` : '';
    return `a ${r.status} report${who} from ${r.report_date ?? r.created_at.slice(0, 10)}`;
  };
  return `This document looks like one already on file: ${reports.map(describe).join('; ')}. If it is a re-scan of the same visit, finalizing this report will record the visit twice.`;
}

/**
 * What to tell the technician about the serial number read off the document
 * (ClassificationResult.serial_match). `assigned` is the instrument the report
 * ended up with automatically, if any. Returns null when there is nothing worth
 * saying — no serial on the document.
 */
function describeSerialMatch(
  result: ClassificationResult,
  instruments: Instrument[],
  assigned: Instrument | undefined,
  threshold: number
): SerialNotice | null {
  const serial = result.instrument_serial?.value;
  const match = result.serial_match ?? 'not_read';
  if (!serial || match === 'not_read') return null;
  const label = (inst: Instrument) => `${inst.model} (${inst.serial_number})`;
  const suggested = instruments.find((inst) => inst.id === result.suggested_instrument_id);

  if (match === 'matched') {
    if (assigned) return { tone: 'info', text: `Matched to ${label(assigned)} by the serial number on the document (${serial}).` };
    // Not assigned automatically, but not necessarily because of the serial:
    // a low report-type read also sends the report to this screen. Say so
    // only when the serial itself was a confident read.
    if (suggested && (result.instrument_serial?.confidence ?? 0) >= threshold) {
      return { tone: 'info', text: `Matched to ${label(suggested)} by the serial number on the document (${serial}). Confirm the details below.` };
    }
    return {
      tone: 'info',
      text: `The document shows serial ${serial}${suggested ? `, which is ${label(suggested)}` : ''}. It is pre-selected below, but the read was not confident enough to assign it automatically — check it.`,
    };
  }
  if (match === 'model_conflict') {
    return {
      tone: 'warn',
      text: `The document's serial number ${serial} belongs to ${suggested ? label(suggested) : 'another instrument'}, but the model read from the document is ${result.instrument.value}. One of the two reads is wrong — choose the instrument yourself.`,
    };
  }
  // not_found
  return {
    tone: 'warn',
    text: assigned
      ? `The document shows serial ${serial}, which is not in your fleet. The report was assigned to ${label(assigned)} because it is the only ${assigned.model}; check that it is the right unit, or add serial ${serial} under Instruments.`
      : `The document shows serial ${serial}, which is not in your fleet. Choose the unit below, or add serial ${serial} under Instruments.`,
  };
}

function ConfirmClassificationScreen({
  classification,
  instruments,
  pickInstrumentId,
  setPickInstrumentId,
  pickReportType,
  setPickReportType,
  classificationConfidenceThreshold,
  onConfirm,
}: {
  classification: ClassificationResult;
  instruments: Instrument[];
  pickInstrumentId: string;
  setPickInstrumentId: (v: string) => void;
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
        <select value={pickInstrumentId} onChange={(e) => setPickInstrumentId(e.target.value)}>
          {/* Keyed and valued by instrument id, not model: model isn't unique
              across the fleet (InstrumentManager.tsx doesn't enforce it, and
              only serial_number has a backend uniqueness check), so a
              model-valued <option> would give two different instruments the
              same <select> value — picking either one would then resolve to
              whichever instrument the id lookup happened to return, silently
              attributing the report to the wrong physical unit.
              The disabled placeholder is what shows when nothing is
              pre-selected (no guessed-model match, or several): without it,
              a value of '' matched no option, the browser displayed the
              first instrument as if selected, and choosing that same option
              fired no onChange — so Confirm stayed disabled. */}
          <option value="" disabled>
            Select instrument…
          </option>
          {instruments.map((inst) => (
            <option key={inst.id} value={inst.id}>
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
        <button className="btn primary" disabled={!pickInstrumentId} onClick={onConfirm}>
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
  instrumentsError,
  fieldConfidenceThreshold,
  classificationConfidenceThreshold,
}: {
  instruments: Instrument[];
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
  const [reportDate, setReportDate] = useState<string | null>(null);

  // Identifies the manual-confirm pick by instrument id, not model — model
  // isn't unique across the fleet (see the <select>'s own comment in
  // ConfirmClassificationScreen), so keying this on model risked resolving
  // to a different instrument than the one actually selected whenever two
  // shared a model.
  const [pickInstrumentId, setPickInstrumentId] = useState('');
  const [serialNotice, setSerialNotice] = useState<SerialNotice | null>(null);
  const [pickReportType, setPickReportType] = useState<ReportType>('repair');
  // Reports that already hold this document, keyed by id (see describeDuplicates).
  const [duplicates, setDuplicates] = useState<Record<string, Report | null>>({});

  // Merge newly flagged report ids into the warning and load each one's
  // details in the background. Never awaited and never fails the flow: the
  // warning is advisory, so a report that cannot be loaded just stays generic.
  function noteDuplicates(ids: string[] | undefined) {
    const incoming = ids ?? [];
    if (incoming.length === 0) return;
    setDuplicates((prev) => {
      const next = { ...prev };
      for (const id of incoming) if (!(id in next)) next[id] = null;
      return next;
    });
    for (const id of incoming) {
      getReport(id)
        .then((loaded) => setDuplicates((prev) => (id in prev ? { ...prev, [id]: loaded } : prev)))
        .catch(() => {});
    }
  }

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
    setReportDate(null);
    setDuplicates({});
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
      setReportDate(refreshed.report_date);
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
      noteDuplicates(result.duplicate_report_ids);
      setSerialNotice(
        describeSerialMatch(
          result,
          instruments,
          result.resolved_instrument_id ? instruments.find((inst) => inst.id === result.resolved_instrument_id) : undefined,
          classificationConfidenceThreshold
        )
      );
      if (result.resolved_template_id && result.resolved_instrument_id) {
        // Fetch the exact template the worker attached to the report, by id
        // — not re-resolve "a" template for this model + report type, which
        // could pick a different row if templates changed in between (the
        // same drift ReportDetailScreen.tsx's load had). The review screen
        // must render the schema extraction actually runs against.
        const tpl = await getReportTemplate(result.resolved_template_id);
        setTemplate(tpl);
        const refreshed = await getReport(reportId);
        setReport(refreshed);
        await runExtraction(attId, reportId, tpl);
      } else {
        // Pre-select the guessed model's instrument by id — pickInstrumentId
        // (not model) is what the confirm screen's <select> and
        // handleConfirmClassification below actually use, since model alone
        // can't tell two same-model instruments apart. Only pre-select when
        // exactly one instrument has that model: with none, or with several
        // (which is also why the backend didn't auto-resolve it), leave it
        // on the "Select instrument…" placeholder so the technician has to
        // choose the unit themselves rather than confirm an arbitrary one.
        // The backend's suggested_instrument_id already folds in the serial
        // number read off the document (and falls back to "the only unit of
        // that model"); older results without it get the model-only rule.
        const guessed = instruments.filter((inst) => inst.model === result.instrument.value);
        setPickInstrumentId(result.suggested_instrument_id ?? (guessed.length === 1 ? guessed[0].id : ''));
        setPickReportType((result.report_type.value as ReportType) ?? 'repair');
        setPhase({ name: 'confirm-classification' });
      }
    });
  }

  // Creating the report and uploading its scan are two steps with separate
  // retries. They used to share one, so a "Try again" after a failed upload
  // re-ran createReport too — leaving the first report behind as an empty
  // draft in the reports list and instrument history, with no way to delete
  // it (§10). Now a retry after the report exists re-runs only the upload.
  async function handleStart() {
    if (!file) return;
    setPhase({ name: 'working', label: 'Creating report…' });
    await attempt('Could not create the report.', () => void handleStart(), async () => {
      const newReport = await createReport({ technician_name: technicianName || null });
      setReport(newReport);
      await uploadScan(newReport.id, file);
    });
  }

  async function uploadScan(reportId: string, scan: File) {
    setPhase({ name: 'working', label: 'Uploading scan…' });
    await attempt('Upload failed unexpectedly.', () => void uploadScan(reportId, scan), async () => {
      const attachment = await uploadAttachment(reportId, scan);
      setAttachmentId(attachment.id);
      noteDuplicates(attachment.duplicate_report_ids);
      await runClassification(attachment.id, reportId);
    });
  }

  async function handleConfirmClassification() {
    if (!report || !attachmentId) return;
    const instrument = instruments.find((inst) => inst.id === pickInstrumentId);
    if (!instrument) return;
    await resolveAndExtract(report.id, attachmentId, instrument.model, pickReportType, instrument.id);
  }

  async function handleSaveFields(finalize: boolean) {
    if (!report) return;
    setPhase({ name: 'working', label: finalize ? 'Saving and finalizing…' : 'Saving corrections…' });
    await attempt('Saving failed unexpectedly.', () => void handleSaveFields(finalize), async () => {
      const updated = await updateReportFields(report.id, { extracted_fields: fields, report_date: reportDate });
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

      {serialNotice && (phase.name === 'confirm-classification' || phase.name === 'review') && (
        <div className={`banner ${serialNotice.tone === 'warn' ? 'banner-warn' : 'banner-info'}`} id="serial-notice">
          {serialNotice.text}
        </div>
      )}

      {Object.keys(duplicates).length > 0 && (phase.name === 'confirm-classification' || phase.name === 'review') && (
        <div className="banner banner-warn" id="duplicate-notice">
          {describeDuplicates(duplicates)}
        </div>
      )}

      {phase.name === 'confirm-classification' && classification && (
        <ConfirmClassificationScreen
          classification={classification}
          instruments={instruments}
          pickInstrumentId={pickInstrumentId}
          setPickInstrumentId={setPickInstrumentId}
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
          reportDate={reportDate}
          onReportDateChange={setReportDate}
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
