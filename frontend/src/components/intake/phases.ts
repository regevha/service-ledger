import { type Instrument, type ReportTemplate, type ReportType } from '../../api';

export type Phase =
  | { name: 'intake' }
  | { name: 'working'; label: string }
  | { name: 'review-translation' }
  | { name: 'confirm-classification' }
  | { name: 'review' }
  | { name: 'done' }
  | { name: 'already-on-file'; existingReportId: string }
  | {
      name: 'error';
      message: string;
      retry: () => void;
      /** The server's own words when they were replaced by a plain sentence; shown under "Details for support". */
      detail?: string;
      /** What the retry button says; "Try again" unless trying again would only repeat the refusal. */
      retryLabel?: string;
      action?: { label: string; run: () => void };
      /** The step that failed (0 upload, 1 classify, 2 review), so the step bar keeps showing it. */
      step: number;
    };

/** A report that is waiting for a template to be created (see TemplateRequest). */
export interface WaitingForTemplate {
  reportId: string;
  attachmentId: string;
  instrument: Instrument;
  reportType: ReportType;
}

/** Whether a newly saved template is the one this waiting report would resolve to. */
export function templateApplies(template: ReportTemplate, waiting: WaitingForTemplate): boolean {
  return (
    template.instrument_type === waiting.instrument.instrument_type &&
    template.report_type === waiting.reportType &&
    (template.model === null || template.model === waiting.instrument.model)
  );
}

/** Which of the three steps a phase belongs to: 0 Upload, 1 Classify, 2 Review & finalize, 3 all done. */
export function stepOf(phase: Phase): number {
  switch (phase.name) {
    case 'done':
      return 3;
    case 'intake':
    case 'already-on-file':
      return 0;
    case 'review':
      return 2;
    case 'error':
      return phase.step;
    case 'working':
      // Creating the report and sending the scan are the upload; everything after (the language
      // check, classifying, resolving the template, reading the fields) is step 2.
      return /^(Creating report|Uploading)/.test(phase.label) ? 0 : 1;
    default:
      return 1; // review-translation, confirm-classification
  }
}

export const STEP_FAILED = ['The upload failed', 'Reading the document failed', 'Saving the report failed'];
