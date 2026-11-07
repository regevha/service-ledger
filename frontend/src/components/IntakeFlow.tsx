import { useEffect, useReducer, useRef, useState } from 'react';
import { PromptReview } from './PromptReview';
import { plainMessage } from '../plainMessages';
import { deleteReport, ApiError, acceptTranslation, attachmentFileUrl, classifyAttachment, confirmTemplate, createReport, discardTranslation, extractAttachment, findTemplate, listInstrumentTypes, finalizeReport, getReport, getReportTemplate, getTranslation, PollAborted, cancelExtractionJob, reportPdfUrl, translateAttachment, updateReportFields, uploadAttachment, type ClassificationResult, type Instrument, type Report, type ReportTemplate, type ReportType, type Translation } from '../api';
import { REPORT_TYPE_LABEL } from '../labels';
import { showToast } from '../toast';
import { prepareUpload } from '../imageUpload';
import type { TemplateRequest } from '../templateRequest';
import { Notice } from './Notice';
import { useUnsavedChangesGuard } from '../hooks/useUnsavedChangesGuard';
import { useConfirmLeave, useNavigationGuard } from '../navigationGuard';
import { reviewSnapshot } from '../reviewSnapshot';
import { ReviewScreen } from './ReviewScreen';
import { TranslationReview } from './TranslationReview';
import { ConfirmClassificationScreen } from './intake/ConfirmClassificationScreen';
import { DoneScreen } from './intake/DoneScreen';
import { IntakeScreen } from './intake/IntakeScreen';
import { StepBar } from './intake/StepBar';
import { useReviewState } from './intake/useReviewState';
import { useIntakeJobs } from './intake/useIntakeJobs';
import { usePromptReview } from './intake/usePromptReview';
import { WorkingPanel } from './intake/WorkingPanel';
import { STEP_FAILED, phaseReducer, templateApplies, type Phase, type WaitingForTemplate } from './intake/phases';
import { describeDuplicates, describeSerialMatch, type SerialNotice } from './intake/serialNotices';

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
  const [phase, dispatchPhase] = useReducer(phaseReducer, { name: 'intake' } as Phase);
  // The fleet as the in-flight steps below should see it: the prop, plus any
  // instrument added during this intake (the prop only catches up after the
  // app reloads its list, and these async steps hold an older render's copy).
  const instrumentsRef = useRef(instruments);
  instrumentsRef.current = instruments;
  const [translation, setTranslation] = useState<Translation | null>(null);
  const [translationBusy, setTranslationBusy] = useState(false);
  const {
    cancelledRef,
    abortRef,
    jobIdRef,
    draftIdRef,
    discardDraftRef,
    submittedJobs,
    discardDraft,
    submitOrResume,
    pollJob,
  } = useIntakeJobs();
  const promptReview = usePromptReview();

  const [technicianName, setTechnicianName] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const file = files[0] ?? null;

  const {
    report, setReport, classification, setClassification, attachmentId, setAttachmentId, template, setTemplate,
    fieldConfidences, extractionSeconds, fields, setFields, reportDate, setReportDate, savedSnapshot, setSavedSnapshot,
    saving, setSaving, saveError, setSaveError, resetReview, loadExtraction,
  } = useReviewState();
  const dirty = phase.name === 'review' && savedSnapshot !== null && reviewSnapshot(fields, reportDate) !== savedSnapshot;
  useUnsavedChangesGuard(dirty);
  const confirmLeave = useConfirmLeave();

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
  const [pickReportType, setPickReportType] = useState<ReportType | ''>('');
  // True when the person chose the unit on the Classify screen (rather than it being matched by the serial).
  const [unitChosen, setUnitChosen] = useState(false);
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

  // Back to the upload screen with the name kept and no file chosen.
  function chooseAnotherFile() {
    draftIdRef.current = null;
    dispatchPhase({ type: 'reset' });
    setFiles([]);
    setReport(null);
  }

  function resetToIntake() {
    dispatchPhase({ type: 'reset' });
    submittedJobs.current.clear();
    setTechnicianName('');
    setFiles([]);
    resetReview();
    setTranslation(null);
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
  function failPhase(message: string, retry: () => void, action?: { label: string; run: () => void }, retryLabel?: string) {
    if (cancelledRef.current) return;
    // The step that was running stays the one the step bar shows, and names what failed.
    const plain = plainMessage(message);
    dispatchPhase({
      type: 'fail',
      message: plain,
      detail: plain === message ? undefined : message,
      retry,
      retryLabel,
      action,
    });
  }

  async function attempt(fallbackMessage: string, retry: () => void, fn: () => Promise<void>) {
    if (cancelledRef.current) return;
    try {
      await fn();
    } catch (e) {
      // Cancelled: the person is not waiting for this step any more, so there is nothing to report.
      if (cancelledRef.current || e instanceof PollAborted) {
        // A step that was cut off by Cancel may have left the draft behind (its delete raced the step).
        if (discardDraftRef.current && draftIdRef.current) void discardDraft(draftIdRef.current);
        return;
      }
      failPhase(e instanceof ApiError ? e.message : fallbackMessage, retry);
    }
  }

  // Cancel on the working screen: stop the job, remove the draft this attempt created (nothing in
  // it is the person's work yet), then return to a clean upload screen.
  async function handleCancel() {
    if (cancelledRef.current) return; // already cancelling
    cancelledRef.current = true;
    abortRef.current.abort();
    submittedJobs.current.clear();
    const jobId = jobIdRef.current;
    discardDraftRef.current = true;
    const draftId = phase.name !== 'review' && phase.name !== 'done' ? draftIdRef.current : null;
    // Stop the job first: deleting a report whose scan is still being read is refused.
    if (jobId) await cancelExtractionJob(jobId).catch(() => undefined);
    if (draftId) await discardDraft(draftId);
    if (onCancel) {
      onCancel();
    } else {
      resetToIntake();
      cancelledRef.current = false;
      discardDraftRef.current = false;
      abortRef.current = new AbortController();
    }
  }

  async function runExtraction(attId: string, reportId: string, tpl: ReportTemplate) {
    dispatchPhase({ type: 'working', label: 'Reading the fields from the document…' });
    await attempt('Extraction failed unexpectedly.', () => void runExtraction(attId, reportId, tpl), async () => {
      // §3/§9: this only enqueues the job — app/worker.py is what actually
      // runs it — so wait for it to leave pending/extracting before reading
      // the result back.
      const startedAt = performance.now();
      const submitted = await submitOrResume(`extract:${attId}`, () => extractAttachment(attId));
      const job = await pollJob(submitted.id);
      const elapsedSeconds = (performance.now() - startedAt) / 1000;
      if (job.status === 'failed') {
        failPhase(job.error_message || 'Extraction failed for an unknown reason.', () => void runExtraction(attId, reportId, tpl));
        return;
      }
      const refreshed = await getReport(reportId);
      loadExtraction(refreshed, job.field_confidences ?? {}, elapsedSeconds);
      dispatchPhase({ type: 'show', name: 'review' });
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
    dispatchPhase({ type: 'working', label: 'Finding the right form…' });
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
    dispatchPhase({
      type: 'working',
      label: includePages.length ? 'Translating again…' : 'Checking the language of the document…',
    });
    await attempt('Translation failed unexpectedly.', () => void runTranslation(attId, reportId, includePages), async () => {
      const submitted = await submitOrResume(`translate:${attId}:${includePages.join(',')}`, () =>
        translateAttachment(attId, includePages)
      );
      const job = await pollJob(submitted.id, { timeoutMs: 300_000 });
      if (job.status === 'failed') {
        failPhase(job.error_message || 'Translation failed for an unknown reason.', () => void runTranslation(attId, reportId, includePages));
        return;
      }
      const current = await getTranslation(attId);
      if (current.status === 'pending_review') {
        setTranslation(current);
        dispatchPhase({ type: 'show', name: 'review-translation' });
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
    setUnitChosen(false);
    dispatchPhase({ type: 'working', label: 'Reading the instrument and visit type…' });
    await attempt('Classification failed unexpectedly.', () => void runClassification(attId, reportId), async () => {
      // §3/§9: submit returns a pending job immediately; app/worker.py picks
      // it up in the background and this polls until it's done.
      const submitted = await submitOrResume(`classify:${attId}`, () => classifyAttachment(attId));
      const job = await pollJob(submitted.id);
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
        // Only a clear reading is pre-selected; an uncertain one has to be chosen.
        setPickReportType(
          result.report_type.confidence >= classificationConfidenceThreshold ? ((result.report_type.value as ReportType) ?? '') : ''
        );
        dispatchPhase({ type: 'show', name: 'confirm-classification' });
      }
    });
  }

  // Creating the report and uploading its scan are two steps with separate
  // retries. They used to share one, so a "Try again" after a failed upload
  // re-ran createReport too — leaving the first report behind as an empty
  // draft in the reports list and instrument history, with no way to delete
  // it (§10). Now a retry after the report exists re-runs only the upload.
  async function handleStart() {
    if (files.length === 0) return;
    dispatchPhase({ type: 'working', label: 'Creating report…' });
    await attempt('Could not create the report.', () => void handleStart(), async () => {
      const newReport = await createReport({ technician_name: technicianName || null });
      draftIdRef.current = newReport.id;
      if (cancelledRef.current) {
        if (discardDraftRef.current) await discardDraft(newReport.id);
        return;
      }
      setReport(newReport);
      await uploadScan(newReport.id, await prepareUpload(files));
    });
  }

  async function uploadScan(reportId: string, scan: File) {
    dispatchPhase({ type: 'working', label: 'Uploading scan…' });
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
          draftIdRef.current = null;
          setReport(null);
          dispatchPhase({ type: 'already-on-file', existingReportId: e.existingReportId });
          return;
        }
        if (e instanceof ApiError && [413, 415, 422].includes(e.status)) {
          // The file itself was refused, so trying the same one again would fail the same way.
          // The draft made for it holds nothing: remove it and offer another file.
          await deleteReport(reportId).catch(() => undefined);
          draftIdRef.current = null;
          setReport(null);
          failPhase(e.message, chooseAnotherFile, undefined, 'Choose another file');
          return;
        }
        throw e;
      }
      if (cancelledRef.current) {
        if (discardDraftRef.current) await discardDraft(reportId);
        return;
      }
      setAttachmentId(attachment.id);
      noteDuplicates(attachment.duplicate_report_ids);
      await runTranslation(attachment.id, reportId);
    });
  }

  async function handleConfirmClassification() {
    if (!report || !attachmentId) return;
    const instrument = instruments.find((inst) => inst.id === pickInstrumentId);
    if (!instrument || !pickReportType) return;
    setUnitChosen(true);
    await resolveAndExtract(report.id, attachmentId, instrument.model, pickReportType, instrument.id, instrument.instrument_type);
  }

  // Back from Review & finalize to Classify. Picking the instrument and type
  // again re-reads the document, which replaces any edits made on the review
  // screen, so the button says so.
  function backToClassification() {
    if (!classification) return;
    confirmLeave(() => {
      if (!pickInstrumentId && report?.instrument_id) setPickInstrumentId(report.instrument_id);
      if (template?.report_type) setPickReportType(template.report_type);
      dispatchPhase({ type: 'show', name: 'confirm-classification' });
    }, 'Going back to Classify and reading the document again replaces edits that are not saved.');
  }

  async function handleSaveFields(finalize: boolean): Promise<boolean> {
    if (!report || saving) return false;
    setSaving(finalize ? 'finalize' : 'save');
    setSaveError(null);
    // What is being saved is what the form holds now. Edits made while the request runs stay unsaved.
    const sent = reviewSnapshot(fields, reportDate);
    try {
      const updated = await updateReportFields(report.id, { extracted_fields: fields, report_date: reportDate });
      setSavedSnapshot(sent);
      let final = updated;
      if (finalize) final = await finalizeReport(report.id);
      setReport(final);
      if (finalize) dispatchPhase({ type: 'show', name: 'done' });
      else showToast('Saved');
      return true;
    } catch (e) {
      setSaveError({ message: plainMessage(e instanceof ApiError ? e.message : 'Saving failed unexpectedly.'), finalize });
      return false;
    } finally {
      setSaving(null);
    }
  }

  // The app asks before a tab, the Back button or "Back to Classify" would throw unsaved edits away.
  useNavigationGuard('new', dirty, () => handleSaveFields(false));

  // Which unit the report is on and how it was found, shown under the Review heading during intake.
  const matchedBySerial = classification?.serial_match === 'matched';
  const reviewInstrumentLine = (() => {
    const unit = report?.instrument_id ? instruments.find((inst) => inst.id === report.instrument_id) : undefined;
    if (!unit) return undefined;
    const how = unitChosen ? 'you chose it' : matchedBySerial ? 'matched by serial' : 'the only unit of that model';
    return `${unit.model} · ${unit.serial_number} · ${how}`;
  })();
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
          files={files}
          setFiles={setFiles}
          onStart={() => void handleStart()}
        />
      )}

      {phase.name === 'working' && (
        <WorkingPanel
          label={phase.label}
          fileName={file?.name}
          slow={liveClaude}
          onCancel={() => void handleCancel()}
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
                title="Saving a template reads this report again and replaces what is on screen, so correct after, not before."
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
          Generic {REPORT_TYPE_LABEL[template.report_type]} template in use. A {reviewInstrument.model} template can ask for this model's own
          fields.
        </Notice>
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
          busy={saving}
          saveError={saveError?.message ?? null}
          instrumentLine={reviewInstrumentLine}
          onChangeInstrument={classification ? backToClassification : undefined}
          onBack={classification ? backToClassification : undefined}
          onRetrySave={saveError ? () => void handleSaveFields(saveError.finalize) : undefined}
        />
      )}

      {phase.name === 'already-on-file' && (
        <div className="section">
          <div className="state-card state-info" id="already-on-file-notice">
            <span className="state-icon" aria-hidden="true">i</span>
            <div>
              <div className="state-title">Already on file</div>
              This exact file is already on file and has been read. Open the existing report instead of loading it again.
            </div>
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

      {phase.name === 'done' && report && <DoneScreen report={report} instrumentLabel={reviewInstrument ? `${reviewInstrument.model} · ${reviewInstrument.serial_number}` : undefined} typeLabel={template ? REPORT_TYPE_LABEL[template.report_type] : undefined} onReset={resetToIntake} onOpenReport={onOpenReport} onViewInstrument={onViewInstrument} />}

      {phase.name === 'error' && (
        <div className="section">
          <div className="state-card state-crit" role="alert" data-testid="intake-error">
            <span className="state-icon" aria-hidden="true">!</span>
            <div>
              <div className="state-title">{STEP_FAILED[phase.step] ?? 'Something went wrong'}{file ? ` (${file.name})` : ''}.</div>
              {phase.message}
            </div>
          </div>
          {phase.detail && (
            <details className="error-details" data-testid="intake-error-details">
              <summary>Details for support</summary>
              <code>{phase.detail}</code>
            </details>
          )}
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
              {phase.retryLabel ?? 'Try again'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
