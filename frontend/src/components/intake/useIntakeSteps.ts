import { plainMessage } from '../../plainMessages';
import { deleteReport, ApiError, classifyAttachment, confirmTemplate, createReport, extractAttachment, findTemplate, listInstrumentTypes, finalizeReport, getReport, getReportTemplate, getTranslation, PollAborted, cancelExtractionJob, translateAttachment, updateReportFields, uploadAttachment, type ClassificationResult, type Instrument, type ReportTemplate, type ReportType } from '../../api';
import { REPORT_TYPE_LABEL } from '../../labels';
import { showToast } from '../../toast';
import { prepareUpload } from '../../imageUpload';
import type { TemplateRequest } from '../../templateRequest';
import type { useConfirmLeave } from '../../navigationGuard';
import { reviewSnapshot } from '../../reviewSnapshot';
import { useRef, type Dispatch, type SetStateAction } from 'react';
import { describeSerialMatch, type SerialNotice } from './serialNotices';
import type { Phase, PhaseAction, WaitingForTemplate } from './phases';
import type { useIntakeJobs } from './useIntakeJobs';
import type { useReviewState } from './useReviewState';
import type { useTranslationReview } from './useTranslationReview';

/** Everything the intake steps read from or write to in the container; see IntakeFlow. */
export type IntakeStepsContext = Omit<ReturnType<typeof useIntakeJobs>, 'forgetJob'> &
  ReturnType<typeof useReviewState> &
  Pick<ReturnType<typeof useTranslationReview>, 'setTranslation'> & {
    phase: Phase;
    dispatchPhase: Dispatch<PhaseAction>;
    confirmLeave: ReturnType<typeof useConfirmLeave>;
    files: File[];
    technicianName: string;
    instruments: Instrument[];
    classificationConfidenceThreshold: number;
    pickInstrumentId: string;
    pickReportType: ReportType | '';
    setPickInstrumentId: Dispatch<SetStateAction<string>>;
    setPickReportType: Dispatch<SetStateAction<ReportType | ''>>;
    setSerialNotice: Dispatch<SetStateAction<SerialNotice | null>>;
    setUnitChosen: Dispatch<SetStateAction<boolean>>;
    noteDuplicates: (ids: string[] | undefined) => void;
    chooseAnotherFile: () => void;
    requestTemplate: (waiting: WaitingForTemplate) => void;
    resetToIntake: () => void;
    onCancel?: () => void;
    onCreateTemplate?: (request: TemplateRequest) => void;
    onInstrumentAdded?: () => Promise<void> | void;
  };

/**
 * The intake wizard's steps (upload, classify, resolve a template, translate, extract, save) and the
 * handlers that start them. Each step shows a "working" phase, calls the API, and lands on the same
 * error phase on failure. Called on every render, so the steps close over that render's values exactly
 * as the functions inside IntakeFlow used to.
 */
export function useIntakeSteps(ctx: IntakeStepsContext) {
  const {
    abortRef,
    attachmentId,
    cancelledRef,
    chooseAnotherFile,
    classification,
    classificationConfidenceThreshold,
    confirmLeave,
    discardDraft,
    discardDraftRef,
    dispatchPhase,
    draftIdRef,
    fields,
    files,
    instruments,
    jobIdRef,
    loadExtraction,
    noteDuplicates,
    onCancel,
    onCreateTemplate,
    onInstrumentAdded,
    phase,
    pickInstrumentId,
    pickReportType,
    pollJob,
    report,
    reportDate,
    requestTemplate,
    resetToIntake,
    saving,
    setAttachmentId,
    setClassification,
    setPickInstrumentId,
    setPickReportType,
    setReport,
    setSaveError,
    setSavedSnapshot,
    setSaving,
    setSerialNotice,
    setTemplate,
    setTranslation,
    setUnitChosen,
    submitOrResume,
    submittedJobs,
    technicianName,
    template,
  } = ctx;
  // The fleet as the in-flight steps below should see it: the prop, plus any
  // instrument added during this intake (the prop only catches up after the
  // app reloads its list, and these async steps hold an older render's copy).
  const instrumentsRef = useRef(instruments);
  instrumentsRef.current = instruments;

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

  return { failPhase, handleCancel, runExtraction, resolveAndExtract, runTranslation, handleInstrumentAdded, runClassification, handleStart, handleConfirmClassification, backToClassification, handleSaveFields };
}
