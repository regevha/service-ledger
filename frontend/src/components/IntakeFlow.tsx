import { useAsyncEffect } from '../hooks/useAsyncEffect';
import { getIntakeState } from '../api/emailIntake';
import { ApiError, getReport, getReportTemplate, getTranslation, PollAborted } from '../api';
import { SourceLine } from './email/SourceLine';
import { intakeResumeStep, manualClassification } from './intake/intakeResume';
import { useEffect, useReducer, useState } from 'react';
import { PromptReview } from './PromptReview';
import { attachmentFileUrl, reportPdfUrl, type Instrument, type ReportTemplate } from '../api';
import { REPORT_TYPE_LABEL } from '../labels';
import type { TemplateRequest } from '../templateRequest';
import { useUnsavedChangesGuard } from '../hooks/useUnsavedChangesGuard';
import { useConfirmLeave, useNavigationGuard } from '../navigationGuard';
import { reviewSnapshot } from '../reviewSnapshot';
import { ReviewScreen } from './ReviewScreen';
import { TranslationReview } from './TranslationReview';
import { ConfirmClassificationScreen } from './intake/ConfirmClassificationScreen';
import { DoneScreen } from './intake/DoneScreen';
import { IntakeScreen } from './intake/IntakeScreen';
import { SerialAndDuplicateNotices, TemplateNotices } from './intake/IntakeNotices';
import { StepBar } from './intake/StepBar';
import { useReviewState } from './intake/useReviewState';
import { useIntakeSteps } from './intake/useIntakeSteps';
import { useTranslationReview } from './intake/useTranslationReview';
import { useIntakeSelection } from './intake/useIntakeSelection';
import { useTemplateRequest } from './intake/useTemplateRequest';
import { useIntakeJobs } from './intake/useIntakeJobs';
import { usePromptReview } from './intake/usePromptReview';
import { WorkingPanel } from './intake/WorkingPanel';
import { STEP_FAILED, phaseReducer, templateApplies, type Phase } from './intake/phases';

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
  resumeReportId,
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
  onOpenBatch,
  onBatchFiles,
  templateCreated,
}: {
  resumeReportId?: string;
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
  /** Opens the several-files screen; without it the intake screen shows no link to it. */
  onOpenBatch?: () => void;
  /** Two or more PDFs were chosen or dropped on the intake screen: open the several-files screen with them. */
  onBatchFiles?: (files: File[]) => void;
  /** Set when a template was just saved for a request made here; `nonce` changes on every save. */
  templateCreated?: { template: ReportTemplate; nonce: number } | null;
}) {
  const [phase, dispatchPhase] = useReducer(phaseReducer, resumeReportId ? { name: 'working', label: 'Opening the report…' } as Phase : { name: 'intake' } as Phase);
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
  } = useIntakeJobs(resumeReportId);
  const [resumeWaiting, setResumeWaiting] = useState(false);
  const promptReview = usePromptReview();

  const [technicianName, setTechnicianName] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const file = files[0] ?? null;

  const {
    report, setReport, classification, setClassification, attachmentId, setAttachmentId, template, setTemplate,
    fieldConfidences, extractionSeconds, fields, setFields, reportDate, setReportDate, savedSnapshot, setSavedSnapshot,
    saving, setSaving, saveError, setSaveError, resetReview, loadExtraction,
  } = useReviewState();
  const { translation, setTranslation, translationBusy, handleAcceptTranslation, handleDiscardTranslation } = useTranslationReview({
    attachmentId,
    report,
    // The steps are built after this hook (they need its setter); these only run on events, after render.
    failPhase: (...args) => steps.failPhase(...args),
    runClassification: (...args) => steps.runClassification(...args),
  });
  const dirty = phase.name === 'review' && savedSnapshot !== null && reviewSnapshot(fields, reportDate) !== savedSnapshot;
  useUnsavedChangesGuard(dirty);
  const confirmLeave = useConfirmLeave();

  const {
    waitingRef, genericNoticeDismissed, setGenericNoticeDismissed, templateNote, setTemplateNote, requestTemplate, resetTemplateRequest,
  } = useTemplateRequest(onCreateTemplate);
  const {
    pickInstrumentId, setPickInstrumentId, pickReportType, setPickReportType, unitChosen, setUnitChosen, serialNotice, setSerialNotice,
    duplicates, noteDuplicates, clearDuplicates,
  } = useIntakeSelection();

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
    clearDuplicates();
    resetTemplateRequest();
  }

  const steps = useIntakeSteps({
    phase, dispatchPhase, confirmLeave, files, technicianName, instruments,
    classificationConfidenceThreshold, pickInstrumentId, pickReportType, setPickInstrumentId, setPickReportType,
    setSerialNotice, setUnitChosen, noteDuplicates, chooseAnotherFile, requestTemplate, resetToIntake,
    onCancel, onCreateTemplate, onInstrumentAdded, preserveExisting: !!resumeReportId,
    cancelledRef, abortRef, jobIdRef, draftIdRef, discardDraftRef, submittedJobs, discardDraft, submitOrResume, pollJob,
    report, setReport, classification, setClassification, attachmentId, setAttachmentId, template, setTemplate,
    fieldConfidences, extractionSeconds, fields, setFields, reportDate, setReportDate, savedSnapshot, setSavedSnapshot,
    saving, setSaving, saveError, setSaveError, resetReview, loadExtraction, setTranslation,
  });
  const {
    handleCancel, resolveAndExtract, runTranslation, handleInstrumentAdded,
    handleStart, handleConfirmClassification, backToClassification, handleSaveFields,
  } = steps;

  // Continuing owns no new draft: reuse the stored attachment and jobs and retain it on Cancel.
  useAsyncEffect(async (isCancelled) => {
    if (!resumeReportId) return;
    const alive = () => !isCancelled() && !cancelledRef.current;
    async function resume() {
      setResumeWaiting(false);
      dispatchPhase({ type: 'working', label: 'Opening the report…' });
      try {
        let [state, current] = await Promise.all([getIntakeState(resumeReportId!), getReport(resumeReportId!)]);
        if (!alive()) return;
        setReport(current);
        // The mailbox worker owns its chaining: observe it rather than enqueue another chain.
        const deadline = Date.now() + 300_000;
        while (state.source?.read_state === 'queued' && intakeResumeStep(state) !== 'already-read') {
          if (!alive()) return;
          const job = Object.values(state.latest_jobs).find((value) => value && !['succeeded', 'failed'].includes(value.status));
          dispatchPhase({ type: 'working', label: job?.kind === 'translate' ? 'Translating the report…' : job?.kind === 'extract' ? 'Reading the fields from the document…' : 'Reading the instrument and visit type…' });
          if (job) await pollJob(job.id, { timeoutMs: 300_000 });
          else await new Promise((resolve) => setTimeout(resolve, 500));
          if (!alive()) return;
          state = await getIntakeState(resumeReportId!);
          if (Date.now() > deadline) throw new Error('The report is still being read. Check again in a moment.');
        }
        if (!alive()) return;
        current = await getReport(resumeReportId!);
        if (!alive()) return;
        setReport(current);
        const step = intakeResumeStep(state);
        if (step === 'already-read') { onOpenReport?.(current.id); return; }
        if (step === 'waiting') { setResumeWaiting(true); return; }
        if (!state.attachment_id) throw new Error('This report has no scan to continue. Open New report to upload a scan.');
        const attId = state.attachment_id;
        setAttachmentId(attId);
        if (step === 'translation-review') {
          const existing = await getTranslation(attId);
          if (!alive()) return;
          setTranslation(existing);
          dispatchPhase({ type: 'show', name: 'review-translation' });
          return;
        }
        if (step === 'manual-classification') {
          const result = manualClassification(state.latest_jobs.classify?.classification);
          setClassification(result);
          setPickInstrumentId(current.instrument_id ?? result.suggested_instrument_id ?? '');
          setPickReportType(result.report_type.confidence >= classificationConfidenceThreshold ? result.report_type.value as import('../api').ReportType : '');
          dispatchPhase({ type: 'show', name: 'confirm-classification' });
          return;
        }
        if (['extraction', 'extraction-failed', 'review'].includes(step)) {
          if (!current.template_id) throw new Error('Choose an instrument and report type before reading this report.');
          const tpl = await getReportTemplate(current.template_id);
          if (!alive()) return;
          setTemplate(tpl);
          if (step === 'review') {
            loadExtraction(current, state.latest_jobs.extract?.field_confidences ?? {}, 0);
            dispatchPhase({ type: 'show', name: 'review' });
          } else if (step === 'extraction-failed') {
            steps.failPhase(state.latest_jobs.extract?.error_message ?? 'Reading the fields failed.', () => void steps.runExtraction(attId, current.id, tpl));
          } else {
            const job = state.latest_jobs.extract;
            if (job) submittedJobs.current.set(`extract:${attId}`, job.id);
            await steps.runExtraction(attId, current.id, tpl);
          }
          return;
        }
        if (step === 'translation') {
          const job = state.latest_jobs.translate;
          if (job && job.status !== 'failed') submittedJobs.current.set(`translate:${attId}:`, job.id);
          await runTranslation(attId, current.id);
        } else {
          const job = state.latest_jobs.classify;
          if (job && job.status !== 'failed') submittedJobs.current.set(`classify:${attId}`, job.id);
          await steps.runClassification(attId, current.id);
        }
      } catch (e) {
        if (!alive() || e instanceof PollAborted) return;
        steps.failPhase(e instanceof ApiError && e.status === 404 ? 'This report no longer exists. Someone may have deleted it.' : e instanceof Error ? e.message : 'Could not open this report. Check your connection and try again.', () => void resume());
      }
    }
    await resume();
  }, [resumeReportId], 'Could not open this report.');

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
      {resumeReportId && <div className="banner banner-info">
        Continuing a report{report?.source?.channel === 'email' ? ' received by email' : ' uploaded in the app'}.
        {report && <SourceLine report={report} />}
        <button className="btn small" onClick={() => onOpenReport?.(resumeReportId)}>Back to the report</button>
      </div>}
      {!resumeWaiting && <StepBar phase={phase} />}
      {resumeWaiting && <div className="banner banner-info"><strong>Waiting for the daily limit.</strong> The app has read as many reports today as it may. This report will be read after the limit resets. Nothing for you to do.</div>}

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
          onOpenBatch={onOpenBatch}
          onBatchFiles={onBatchFiles}
        />
      )}

      {phase.name === 'working' && !resumeWaiting && (
        <WorkingPanel
          label={phase.label}
          fileName={file?.name}
          slow={liveClaude}
          onCancel={() => void handleCancel()}
        />
      )}

      <SerialAndDuplicateNotices phase={phase} serialNotice={serialNotice} duplicates={duplicates} />

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

      {phase.name === 'confirm-classification' && report?.source?.needs_report_type && <div className="banner banner-warn">The app did not recognise this kind of report. Choose the instrument and the report type. If there is no form for it yet, you can create one from this report.</div>}
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

      <TemplateNotices
        phase={phase}
        templateNote={templateNote}
        template={template}
        reviewInstrument={reviewInstrument}
        attachmentId={attachmentId}
        report={report}
        canCreateTemplate={!!onCreateTemplate}
        genericNoticeDismissed={genericNoticeDismissed}
        onDismissGeneric={() => setGenericNoticeDismissed(true)}
        onCreateTemplate={requestTemplate}
      />

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

      {phase.name === 'done' && report && <DoneScreen report={report} instrumentLabel={reviewInstrument ? `${reviewInstrument.model} · ${reviewInstrument.serial_number}` : undefined} typeLabel={template ? REPORT_TYPE_LABEL[template.report_type] : undefined} onReset={resumeReportId ? () => onCancel?.() : resetToIntake} onOpenReport={onOpenReport} onViewInstrument={onViewInstrument} />}

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
            <button className="btn" onClick={resumeReportId ? () => onCancel?.() : resetToIntake}>
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
