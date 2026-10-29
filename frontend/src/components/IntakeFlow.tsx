import { useEffect, useRef, useState } from 'react';
import { PromptReview } from './PromptReview';
import {
  deleteReport,
  ApiError,
  acceptTranslation,
  attachmentFileUrl,
  classifyAttachment,
  confirmTemplate,
  createReport,
  discardTranslation,
  extractAttachment,
  findTemplate,
  listInstrumentTypes,
  finalizeReport,
  getReport,
  getReportTemplate,
  getTranslation,
  pollExtractionJob,
  setPromptApprovalHandler,
  type PromptPreview,
  reportPdfUrl,
  translateAttachment,
  updateReportFields,
  uploadAttachment,
  type ClassificationResult,
  type Instrument,
  type Report,
  type ReportTemplate,
  type ReportType,
  type SerialMatch,
  type Translation,
} from '../api';
import { REPORT_TYPE_LABEL } from '../labels';
import { showToast } from '../toast';
import { ACCEPTED_TYPES, dropProblem } from '../uploadFiles';
import type { TemplateRequest } from '../templateRequest';
import { ConfidenceBadge, classificationLabel } from './ConfidenceBadge';
import { AddInstrumentPanel } from './AddInstrumentPanel';
import { Notice } from './Notice';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { ReviewScreen } from './ReviewScreen';
import { PhoneScanSwitch, ScanSplit, ScanToggleButton, useScanPreview } from './ScanPreview';
import { TranslationReview } from './TranslationReview';

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
  | { name: 'review-translation' }
  | { name: 'confirm-classification' }
  | { name: 'review' }
  | { name: 'done' }
  | { name: 'already-on-file'; existingReportId: string }
  | { name: 'error'; message: string; retry: () => void; action?: { label: string; run: () => void } };

/** A report that is waiting for a template to be created (see TemplateRequest). */
interface WaitingForTemplate {
  reportId: string;
  attachmentId: string;
  instrument: Instrument;
  reportType: ReportType;
}

/** Whether a newly saved template is the one this waiting report would resolve to. */
function templateApplies(template: ReportTemplate, waiting: WaitingForTemplate): boolean {
  return (
    template.instrument_type === waiting.instrument.instrument_type &&
    template.report_type === waiting.reportType &&
    (template.model === null || template.model === waiting.instrument.model)
  );
}

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
    phase.name === 'done'
      ? 3 // all three steps finished
      : phase.name === 'intake'
      ? 0
      : phase.name === 'review-translation' || phase.name === 'confirm-classification' || (phase.name === 'working' && phase.label.includes('lassif'))
        ? 1
        : phase.name === 'review' || (phase.name === 'working' && phase.label.includes('aving'))
          ? 2
          : phase.name === 'working'
            ? 1
            : 0;
  const steps = ['Upload', 'Classify', 'Review & finalize'];
  return (
    <div className="steps" data-testid="intake-steps">
      {steps.map((label, i) => (
        <div key={label} data-testid="intake-step" className={`step ${i === stepIndex ? 'active' : ''} ${i < stepIndex ? 'done' : ''}`}>
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
  const [dragging, setDragging] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);

  const phone = useMediaQuery('(max-width: 620px)');
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  return (
    <div className="section">
      <div className="section-title">Lab manager</div>
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
      <label
        data-testid="intake-dropzone"
        className={`dropzone${dragging ? ' dragging' : ''}`}
        onDragEnter={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragOver={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault(); // without this the browser refuses the drop
          e.dataTransfer.dropEffect = 'copy';
          setDragging(true);
        }}
        onDragLeave={(e) => {
          // Moving over the icon or text inside the box also fires this; only a real exit counts.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          setDragging(false);
          const files = Array.from(e.dataTransfer.files);
          const problem = dropProblem(files);
          // A refused drop leaves the file already chosen in place; say so, so it is not a surprise.
          setDropError(problem && file ? `${problem} Keeping ${file.name}.` : problem);
          if (!problem) setFile(files[0]);
        }}
      >
        <div className="icon">📄</div>
        <div className="primary">
          {dragging ? 'Drop the file here' : file ? file.name : phone ? 'Take a photo or choose a file' : 'Click to choose a scan or PDF, or drop it here'}
        </div>
        <div className="secondary">Scanned or printed service forms, as a PDF or a PNG, JPEG, GIF or WebP image — one file per report, any instrument, any report type</div>
        <input
          type="file"
          data-testid="intake-file-input"
          accept={ACCEPTED_TYPES.join(',')}
          hidden
          onChange={(e) => {
            setDropError(null);
            setFile(e.target.files?.[0] ?? null);
          }}
        />
      </label>
      {dropError && (
        <div className="drop-error" role="alert" data-testid="intake-drop-error">
          {dropError}
        </div>
      )}

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
    return `${/^[aeiou]/i.test(r.status) ? 'an' : 'a'} ${r.status} report${who} from ${r.report_date ?? r.created_at.slice(0, 10)}`;
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

// What the serial read means for the instrument choice, in a line under it.
const SERIAL_MATCH_NOTE: Record<SerialMatch, string> = {
  matched: 'Matches one unit in your fleet.',
  not_found: 'Not in your fleet. Choose the unit yourself, or add this serial under Instruments.',
  model_conflict: 'Belongs to a different model than the one read from the document. One of the two is wrong.',
  not_read: 'No serial number found on the document.',
};

function ConfirmClassificationScreen({
  classification,
  instruments,
  pickInstrumentId,
  setPickInstrumentId,
  pickReportType,
  setPickReportType,
  classificationConfidenceThreshold,
  onConfirm,
  onInstrumentAdded,
  busy,
  originalScanUrl,
  scanInlineUrl,
  scanAttachmentId,
}: {
  classification: ClassificationResult;
  instruments: Instrument[];
  pickInstrumentId: string;
  setPickInstrumentId: (v: string) => void;
  pickReportType: ReportType;
  setPickReportType: (v: ReportType) => void;
  classificationConfidenceThreshold: number;
  onConfirm: () => void;
  onInstrumentAdded: (instrument: Instrument) => void;
  busy: boolean;
  // The uploaded document, shown the same way as on the review screen.
  originalScanUrl?: string;
  scanInlineUrl?: string;
  scanAttachmentId?: string;
}) {
  const preview = useScanPreview(scanInlineUrl, scanAttachmentId);
  const serial = classification.instrument_serial ?? null;
  const match: SerialMatch = classification.serial_match ?? 'not_read';
  const noteType = classification.report_type_note as ReportType | null | undefined;
  return (
    <>
    {classification.maker_in_fleet === false && (
      <AddInstrumentPanel classification={classification} busy={busy} onAdded={onInstrumentAdded} />
    )}
    <div className="section">
      <div className="section-title-row">
        <div>
          <div className="section-title">Detected from the document</div>
          <p className="hint-text">
            Check the instrument and the report type, then continue.
          </p>
        </div>
        <div className="section-title-actions">
          <ScanToggleButton preview={preview} />
          {originalScanUrl && !(preview.phone && preview.phoneScan) && (
            <a className="btn small" href={originalScanUrl} target="_blank" rel="noreferrer">
              View original scan
            </a>
          )}
        </div>
      </div>

      <PhoneScanSwitch preview={preview} />

      <ScanSplit preview={preview}>

      <div className="read-row" id="read-model">
        <div className="crow-top">
          <span className="clabel">Instrument model</span>
          <ConfidenceBadge
            confidence={classification.instrument.confidence}
            threshold={classificationConfidenceThreshold}
            label={classificationLabel(classification.reader, classification.instrument.confidence)}
          />
        </div>
        <div className="read-value">
          {classification.maker_in_fleet === false
            ? `${[classification.detected_manufacturer, classification.detected_model].filter(Boolean).join(' ') || 'Unknown'} (not in your fleet)`
            : classification.instrument.value || '—'}
        </div>
      </div>

      {classification.issuer && (
        <div className="read-row" id="read-issuer">
          <div className="crow-top">
            <span className="clabel">Form issued by</span>
          </div>
          <div className="read-value">{classification.issuer}</div>
        </div>
      )}

      <div className="read-row" id="read-serial">
        <div className="crow-top">
          <span className="clabel">Serial number</span>
          <ConfidenceBadge
            confidence={serial ? serial.confidence : 0}
            threshold={classificationConfidenceThreshold}
            label={serial ? classificationLabel(classification.reader, serial.confidence) : 'not found'}
          />
        </div>
        <div className="read-value">{serial ? serial.value : '—'}</div>
        <div className="field-note">{SERIAL_MATCH_NOTE[match]}</div>
      </div>

      <div className="class-row" data-testid="class-row">
        <div className="crow-top">
          <span className="clabel">Instrument</span>
          <ConfidenceBadge
            confidence={pickInstrumentId && match !== 'model_conflict' ? 1 : 0}
            threshold={classificationConfidenceThreshold}
            label={
              !pickInstrumentId
                ? 'choose one'
                : match === 'model_conflict'
                  ? 'check this'
                  : match === 'matched'
                    ? 'matched by serial'
                    : 'suggested'
            }
          />
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

      <div className="class-row" data-testid="class-row">
        <div className="crow-top">
          <span className="clabel">Report type</span>
          <ConfidenceBadge
            confidence={classification.report_type.confidence}
            threshold={classificationConfidenceThreshold}
            label={classificationLabel(
              classification.reader,
              classification.report_type.confidence,
              classification.report_type_source === 'task_code',
            )}
          />
        </div>
        <select value={pickReportType} onChange={(e) => setPickReportType(e.target.value as ReportType)}>
          {(Object.keys(REPORT_TYPE_LABEL) as ReportType[]).map((rt) => (
            <option key={rt} value={rt}>
              {REPORT_TYPE_LABEL[rt]}
            </option>
          ))}
        </select>
        {classification.report_type_note && (
          <div className="field-note" id="report-type-note">
            This visit also looks like: {noteType && REPORT_TYPE_LABEL[noteType] ? REPORT_TYPE_LABEL[noteType] : classification.report_type_note}.
          </div>
        )}
      </div>

      <div className="cta-row">
        <button className="btn primary" disabled={!pickInstrumentId} onClick={onConfirm}>
          Confirm &amp; continue to extraction →
        </button>
      </div>
      </ScanSplit>
    </div>
    </>
  );
}

/** The day, as YYYY-MM-DD in the viewer's own time zone (the form the tables use). */
function isoDay(value: string): string {
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function WorkingPanel({
  label,
  fileName,
  slow,
  onCancel,
}: {
  label: string;
  fileName?: string;
  /** True when a live model is reading the scan, which takes a while. */
  slow: boolean;
  onCancel?: () => void;
}) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="section working-panel" data-testid="intake-working">
      <div className="spinner" />
      <div className="working-text">
        <div>{label}</div>
        <div className="working-detail">
          {fileName && <span className="working-file" data-testid="intake-working-file">{fileName}</span>}
          <span>{seconds}s</span>
        </div>
        {slow && seconds < 90 && <div className="working-detail">Reading a scan usually takes 10–60 seconds; a translated one takes longer.</div>}
        {slow && seconds >= 90 && <div className="working-detail">Still working — this one is taking longer than usual.</div>}
      </div>
      {onCancel && (
        <button type="button" className="btn small" data-testid="intake-cancel" onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  );
}

function DoneScreen({
  report,
  onReset,
  onOpenReport,
  onViewInstrument,
}: {
  report: Report;
  onReset: () => void;
  onOpenReport?: (reportId: string) => void;
  onViewInstrument?: (instrumentId: string) => void;
}) {
  return (
    <div className="section success-panel" data-testid="intake-success">
      <div className="tick">✓</div>
      <h3>Report finalized</h3>
      <p>{report.finalized_at ? `Saved on ${isoDay(report.finalized_at)}.` : 'Saved.'} It is now part of the instrument's history.</p>
      <div className="cta-row success-actions">
        {onOpenReport && (
          <button className="btn primary" data-testid="intake-open-report" onClick={() => onOpenReport(report.id)}>
            Open report
          </button>
        )}
        {onViewInstrument && report.instrument_id && (
          <button className="btn" data-testid="intake-view-instrument" onClick={() => onViewInstrument(report.instrument_id!)}>
            View instrument
          </button>
        )}
        <button className={onOpenReport ? 'btn' : 'btn primary'} onClick={onReset}>
          Start another report
        </button>
      </div>
    </div>
  );
}

export function IntakeFlow({
  instruments,
  instrumentsError,
  fieldConfidenceThreshold,
  classificationConfidenceThreshold,
  liveClaude = true,
  onOpenReport,
  onViewInstrument,
  onCancel,
  onInstrumentAdded,
  onCreateTemplate,
  templateCreated,
}: {
  instruments: Instrument[];
  instrumentsError: string | null;
  fieldConfidenceThreshold: number;
  classificationConfidenceThreshold: number;
  liveClaude?: boolean;
  /** Open an existing report on the Reports tab (used when an upload is refused as already on file). */
  onOpenReport?: (reportId: string) => void;
  /** Open an instrument's page (the success screen's "View instrument"). */
  onViewInstrument?: (instrumentId: string) => void;
  /** Abandon the work in progress and return to a clean upload screen. */
  onCancel?: () => void;
  /** Called after an instrument is added here, so the app's fleet list reloads. */
  onInstrumentAdded?: () => Promise<void> | void;
  /** Ask the Templates tab for a template for this model and report type (prefilled, with the closest one as the start). */
  onCreateTemplate?: (request: TemplateRequest) => void;
  /** Set when a template was just saved for a request made here; `nonce` changes on every save. */
  templateCreated?: { template: ReportTemplate; nonce: number } | null;
}) {
  const [phase, setPhase] = useState<Phase>({ name: 'intake' });
  // The fleet as the in-flight steps below should see it: the prop, plus any
  // instrument added during this intake (the prop only catches up after the
  // app reloads its list, and these async steps hold an older render's copy).
  const instrumentsRef = useRef(instruments);
  instrumentsRef.current = instruments;
  const [translation, setTranslation] = useState<Translation | null>(null);
  const [translationBusy, setTranslationBusy] = useState(false);
  // VIEW_PROMPTS (debug): the prompt waiting for Send/Cancel, and how to answer it.
  const [promptReview, setPromptReview] = useState<{ preview: PromptPreview; answer: (send: boolean) => void } | null>(null);
  useEffect(() => {
    setPromptApprovalHandler(
      (preview) => new Promise<boolean>((resolve) => {
        setPromptReview({
          preview,
          answer: (send) => {
            setPromptReview(null);
            resolve(send);
          },
        });
      })
    );
    return () => setPromptApprovalHandler(null);
  }, []);

  const [technicianName, setTechnicianName] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const [report, setReport] = useState<Report | null>(null);
  const [classification, setClassification] = useState<ClassificationResult | null>(null);
  const [attachmentId, setAttachmentId] = useState<string | null>(null);
  const [template, setTemplate] = useState<ReportTemplate | null>(null);
  const [fieldConfidences, setFieldConfidences] = useState<Record<string, number>>({});
  // Measured in the browser, from submitting the extraction to the job finishing; shown on Review & finalize only.
  const [extractionSeconds, setExtractionSeconds] = useState<number | null>(null);
  const [fields, setFields] = useState<Record<string, unknown>>({});
  const [reportDate, setReportDate] = useState<string | null>(null);

  // The report that asked for a template of its own, until one is saved.
  const waitingRef = useRef<WaitingForTemplate | null>(null);
  const [genericNoticeDismissed, setGenericNoticeDismissed] = useState(false);
  // Said in the review screen when a saved template did not apply to this report.
  const [templateNote, setTemplateNote] = useState<string | null>(null);

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
    setTranslation(null);
    setAttachmentId(null);
    setTemplate(null);
    setFieldConfidences({});
    setExtractionSeconds(null);
    setFields({});
    setReportDate(null);
    setDuplicates({});
    waitingRef.current = null;
    setGenericNoticeDismissed(false);
    setTemplateNote(null);
  }

  function requestTemplate(waiting: WaitingForTemplate) {
    waitingRef.current = waiting;
    setTemplateNote(null);
    onCreateTemplate?.({
      instrumentType: waiting.instrument.instrument_type,
      reportType: waiting.reportType,
      model: waiting.instrument.model,
    });
  }

  // A template was saved for the request made above: read the waiting report
  // again with it, as long as it is the template this report resolves to.
  useEffect(() => {
    const waiting = waitingRef.current;
    if (!templateCreated || !waiting) return;
    waitingRef.current = null;
    if (!templateApplies(templateCreated.template, waiting)) {
      setTemplateNote(
        `The template you saved is for ${templateCreated.template.model ?? 'any model'} / ${REPORT_TYPE_LABEL[templateCreated.template.report_type]}, ` +
          `so this ${waiting.instrument.model} report still uses the template it already had.`
      );
      return;
    }
    void resolveAndExtract(
      waiting.reportId,
      waiting.attachmentId,
      waiting.instrument.model,
      waiting.reportType,
      waiting.instrument.id,
      waiting.instrument.instrument_type
    );
  }, [templateCreated?.nonce]);

  // Every step below (upload, classify, resolve-template, extract, save)
  // follows the same shape: show a "working" phase, run some API calls, and
  // on any failure land on the *same* error phase — a banner with the
  // ApiError's own message (or a step-specific fallback for a network/
  // unexpected failure) and a "Try again" button that just re-runs that same
  // step with its original arguments. `failPhase` is that landing (also used
  // directly for a job that finished with status 'failed', which isn't a
  // thrown exception); `attempt` wraps a step's body so each step below only
  // states its fallback message, its retry, and what it actually does.
  function failPhase(message: string, retry: () => void, action?: { label: string; run: () => void }) {
    setPhase({ name: 'error', message, retry, action });
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
      const startedAt = performance.now();
      const submitted = await extractAttachment(attId);
      const job = await pollExtractionJob(submitted.id);
      const elapsedSeconds = (performance.now() - startedAt) / 1000;
      if (job.status === 'failed') {
        failPhase(job.error_message || 'Extraction failed for an unknown reason.', () => void runExtraction(attId, reportId, tpl));
        return;
      }
      const refreshed = await getReport(reportId);
      setReport(refreshed);
      setFieldConfidences(job.field_confidences ?? {});
      setExtractionSeconds(elapsedSeconds);
      setFields(refreshed.extracted_fields ?? {});
      setReportDate(refreshed.report_date);
      setPhase({ name: 'review' });
    });
  }

  async function resolveAndExtract(
    reportId: string,
    attId: string,
    model: string,
    reportType: ReportType,
    instrumentId: string,
    instrumentType: string
  ) {
    setPhase({ name: 'working', label: 'Resolving the matching template…' });
    await attempt(
      'Could not resolve a template.',
      () => void resolveAndExtract(reportId, attId, model, reportType, instrumentId, instrumentType),
      async () => {
        const tpl = await findTemplate(model, reportType, instrumentType);
        if (!tpl) {
          // Common for a new kind of instrument: it has no generic template yet.
          const kind = await listInstrumentTypes()
            .then((types) => types.find((t) => t.key === instrumentType)?.display_name ?? instrumentType)
            .catch(() => instrumentType);
          const instrument = instrumentsRef.current.find((inst) => inst.id === instrumentId);
          failPhase(
            `There is no ${REPORT_TYPE_LABEL[reportType]} template for ${kind} / ${model} yet. ` +
              (onCreateTemplate
                ? 'Create one now and this report is read again with it.'
                : 'Create one on the Templates tab (choose this instrument type), then upload the report again.'),
            () => void resolveAndExtract(reportId, attId, model, reportType, instrumentId, instrumentType),
            instrument && onCreateTemplate
              ? {
                  label: `Create a ${REPORT_TYPE_LABEL[reportType]} template for ${model}`,
                  run: () => requestTemplate({ reportId, attachmentId: attId, instrument, reportType }),
                }
              : undefined
          );
          return;
        }
        const updated = await confirmTemplate(reportId, instrumentId, tpl.id);
        setReport(updated);
        setTemplate(tpl);
        await runExtraction(attId, reportId, tpl);
      }
    );
  }

  // Every upload is checked for language first (a cheap local check for a PDF
  // with text, one model call for a scan). A Hebrew document stops at the
  // review screen; anything else, or a discarded translation, goes straight on
  // to classification.
  async function runTranslation(attId: string, reportId: string, includePages: number[] = []) {
    setPhase({
      name: 'working',
      label: includePages.length ? 'Translating again…' : 'Checking the language of the document…',
    });
    await attempt('Translation failed unexpectedly.', () => void runTranslation(attId, reportId, includePages), async () => {
      const submitted = await translateAttachment(attId, includePages);
      const job = await pollExtractionJob(submitted.id, { timeoutMs: 300_000 });
      if (job.status === 'failed') {
        failPhase(job.error_message || 'Translation failed for an unknown reason.', () => void runTranslation(attId, reportId, includePages));
        return;
      }
      const current = await getTranslation(attId);
      if (current.status === 'pending_review') {
        setTranslation(current);
        setPhase({ name: 'review-translation' });
        return;
      }
      await runClassification(attId, reportId);
    });
  }

  async function handleAcceptTranslation(editedText: string | undefined) {
    if (!translation || !attachmentId || !report) return;
    setTranslationBusy(true);
    try {
      await acceptTranslation(translation.id, editedText);
    } catch (e) {
      setTranslationBusy(false);
      failPhase(e instanceof ApiError ? e.message : 'Could not accept the translation.', () => void handleAcceptTranslation(editedText));
      return;
    }
    setTranslationBusy(false);
    await runClassification(attachmentId, report.id);
  }

  async function handleDiscardTranslation() {
    if (!translation || !attachmentId || !report) return;
    setTranslationBusy(true);
    try {
      await discardTranslation(translation.id);
    } catch (e) {
      setTranslationBusy(false);
      failPhase(e instanceof ApiError ? e.message : 'Could not discard the translation.', () => void handleDiscardTranslation());
      return;
    }
    setTranslationBusy(false);
    setTranslation(null);
    await runClassification(attachmentId, report.id);
  }

  async function handleInstrumentAdded() {
    if (!attachmentId || !report) return;
    // Wait for the app to reload the fleet, then classify the same document
    // again against it.
    await onInstrumentAdded?.();
    await runClassification(attachmentId, report.id);
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
          instrumentsRef.current,
          result.resolved_instrument_id
            ? instrumentsRef.current.find((inst) => inst.id === result.resolved_instrument_id)
            : undefined,
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
        const guessed = instrumentsRef.current.filter((inst) => inst.model === result.instrument.value);
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
      let attachment;
      try {
        attachment = await uploadAttachment(reportId, scan);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && e.existingReportId) {
          // This exact file was already read under another report. The draft
          // created for this attempt is empty and would only clutter the list,
          // so remove it (best effort), then point at the existing report.
          await deleteReport(reportId).catch(() => undefined);
          setReport(null);
          setPhase({ name: 'already-on-file', existingReportId: e.existingReportId });
          return;
        }
        throw e;
      }
      setAttachmentId(attachment.id);
      noteDuplicates(attachment.duplicate_report_ids);
      await runTranslation(attachment.id, reportId);
    });
  }

  async function handleConfirmClassification() {
    if (!report || !attachmentId) return;
    const instrument = instruments.find((inst) => inst.id === pickInstrumentId);
    if (!instrument) return;
    await resolveAndExtract(report.id, attachmentId, instrument.model, pickReportType, instrument.id, instrument.instrument_type);
  }

  // Back from Review & finalize to Classify. Picking the instrument and type
  // again re-reads the document, which replaces any edits made on the review
  // screen, so the button says so.
  function backToClassification() {
    if (!classification) return;
    if (!pickInstrumentId && report?.instrument_id) setPickInstrumentId(report.instrument_id);
    if (template?.report_type) setPickReportType(template.report_type);
    setPhase({ name: 'confirm-classification' });
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
      if (!finalize) showToast('Saved');
    });
  }

  const reviewInstrument = report?.instrument_id ? instruments.find((inst) => inst.id === report.instrument_id) : undefined;

  return (
    <>
      <StepBar phase={phase} />

      {promptReview && (
        <PromptReview
          preview={promptReview.preview}
          onSend={() => promptReview.answer(true)}
          onCancel={() => promptReview.answer(false)}
        />
      )}

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
        <WorkingPanel
          label={phase.label}
          fileName={file?.name}
          // Saving happens from the review screen: no "reading" hint, and nothing to cancel back out of.
          slow={liveClaude && !phase.label.includes('aving')}
          onCancel={phase.label.includes('aving') ? undefined : onCancel}
        />
      )}

      {serialNotice && (phase.name === 'confirm-classification' || phase.name === 'review') && (
        <Notice tone={serialNotice.tone === 'warn' ? 'warn' : 'info'} id="serial-notice">
          {serialNotice.text}
        </Notice>
      )}

      {Object.keys(duplicates).length > 0 && (phase.name === 'confirm-classification' || phase.name === 'review') && (
        <Notice tone="warn" id="duplicate-notice">
          {describeDuplicates(duplicates)}
        </Notice>
      )}

      {phase.name === 'review-translation' && translation && attachmentId && report && (
        <TranslationReview
          key={translation.id}
          translation={translation}
          originalUrl={attachmentFileUrl(attachmentId, { inline: true })}
          busy={translationBusy}
          onAccept={(text) => void handleAcceptTranslation(text)}
          onDiscard={() => void handleDiscardTranslation()}
          onTranslateAgain={(pages) => void runTranslation(attachmentId, report.id, pages)}
        />
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
          onInstrumentAdded={() => void handleInstrumentAdded()}
          busy={false}
          originalScanUrl={attachmentId ? attachmentFileUrl(attachmentId) : undefined}
          scanInlineUrl={attachmentId ? attachmentFileUrl(attachmentId, { inline: true }) : undefined}
          scanAttachmentId={attachmentId ?? undefined}
        />
      )}

      {phase.name === 'review' && templateNote && (
        <Notice tone="info" id="template-note">
          {templateNote}
        </Notice>
      )}

      {phase.name === 'review' && template && template.model === null && reviewInstrument && attachmentId && report && onCreateTemplate && !genericNoticeDismissed && (
        <Notice
          tone="info"
          id="generic-template-notice"
          actions={
            <div className="banner-actions">
              <button
                type="button"
                className="btn small"
                onClick={() =>
                  requestTemplate({ reportId: report.id, attachmentId, instrument: reviewInstrument, reportType: template.report_type })
                }
              >
                Create a {reviewInstrument.model} template
              </button>{' '}
              <button type="button" className="link-button" onClick={() => setGenericNoticeDismissed(true)}>
                Not now
              </button>
            </div>
          }
        >
          This report used the generic {REPORT_TYPE_LABEL[template.report_type]} template for {reviewInstrument.model}. A template made for{' '}
          {reviewInstrument.model} can ask for the fields its forms carry; saving one reads this report again and replaces what is on
          screen, so make corrections after, not before.
        </Notice>
      )}

      {phase.name === 'review' && classification && (
        <button
          type="button"
          className="btn small back-link"
          data-testid="back-to-classify"
          title="Change the instrument or report type. Reading the document again replaces edits made here."
          onClick={backToClassification}
        >
          ← Back to Classify
        </button>
      )}

      {phase.name === 'review' && template && (
        <ReviewScreen
          template={template}
          fields={fields}
          reportDate={reportDate}
          onReportDateChange={setReportDate}
          fieldConfidences={fieldConfidences}
          fieldConfidenceThreshold={fieldConfidenceThreshold}
          placeholderValues={!liveClaude}
          onChange={(name, value) => setFields((prev) => ({ ...prev, [name]: value }))}
          onSave={() => void handleSaveFields(false)}
          onFinalize={() => void handleSaveFields(true)}
          originalScanUrl={attachmentId ? attachmentFileUrl(attachmentId) : undefined}
          scanInlineUrl={attachmentId ? attachmentFileUrl(attachmentId, { inline: true }) : undefined}
          scanAttachmentId={attachmentId ?? undefined}
          pdfUrl={report ? reportPdfUrl(report.id) : undefined}
          extractionSeconds={extractionSeconds}
        />
      )}

      {phase.name === 'already-on-file' && (
        <div className="section">
          <div className="banner banner-info" id="already-on-file-notice">
            This exact file is already on file and has been read. Open the existing report instead of loading it again.
          </div>
          <div className="cta-row">
            <button className="btn" onClick={resetToIntake}>
              Load a different file
            </button>
            {onOpenReport && (
              <button
                className="btn primary"
                onClick={() => {
                  const id = phase.existingReportId;
                  resetToIntake();
                  onOpenReport(id);
                }}
              >
                Open existing report
              </button>
            )}
          </div>
        </div>
      )}

      {phase.name === 'done' && report && <DoneScreen report={report} onReset={resetToIntake} onOpenReport={onOpenReport} onViewInstrument={onViewInstrument} />}

      {phase.name === 'error' && (
        <div className="section">
          <div className="banner banner-crit" data-testid="intake-error">{phase.message}</div>
          <div className="cta-row">
            <button className="btn" onClick={resetToIntake}>
              Start over
            </button>
            {phase.action && (
              <button className="btn primary" id="create-template-action" onClick={phase.action.run}>
                {phase.action.label}
              </button>
            )}
            <button className={phase.action ? 'btn' : 'btn primary'} onClick={phase.retry}>
              Try again
            </button>
          </div>
        </div>
      )}
    </>
  );
}
