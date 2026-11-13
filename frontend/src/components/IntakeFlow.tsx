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
import { STEP_FAILED, phaseReducer, stepOf, templateApplies, type Phase } from './intake/phases';

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
  onOpenBatch,
  onBatchFiles,
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
  /** Opens the several-files screen; without it the intake screen shows no link to it. */
  onOpenBatch?: () => void;
  /** Two or more PDFs were chosen or dropped on the intake screen: open the several-files screen with them. */
  onBatchFiles?: (files: File[]) => void;
  /** Set when a template was just saved for a request made here; `nonce` changes on every save. */
  templateCreated?: { template: ReportTemplate; nonce: number } | null;
}) {
  const [phase, dispatchPhase] = useReducer(phaseReducer, { name: 'intake' } as Phase);
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
    onCancel, onCreateTemplate, onInstrumentAdded,
    cancelledRef, abortRef, jobIdRef, draftIdRef, discardDraftRef, submittedJobs, discardDraft, submitOrResume, pollJob,
    report, setReport, classification, setClassification, attachmentId, setAttachmentId, template, setTemplate,
    fieldConfidences, extractionSeconds, fields, setFields, reportDate, setReportDate, savedSnapshot, setSavedSnapshot,
    saving, setSaving, saveError, setSaveError, resetReview, loadExtraction, setTranslation,
  });
  const {
    handleCancel, resolveAndExtract, runTranslation, handleInstrumentAdded,
    handleStart, handleConfirmClassification, backToClassification, handleSaveFields,
  } = steps;

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
          onOpenBatch={onOpenBatch}
          onBatchFiles={onBatchFiles}
        />
      )}

      {phase.name === 'working' && (
        <WorkingPanel
          label={phase.label}
          fileName={file?.name}
          slow={liveClaude}
          uploading={stepOf(phase) === 0}
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
