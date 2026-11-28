import type { IntakeState } from '../../api/emailIntake';
import type { ClassificationResult } from '../../api/types';

export type ResumeStep = 'already-read' | 'missing-attachment' | 'waiting' | 'translation' | 'translation-review' | 'classification' | 'manual-classification' | 'extraction' | 'extraction-failed' | 'review';
const running = (status?: string) => !!status && !['succeeded', 'failed'].includes(status);
export function intakeResumeStep(state: IntakeState): ResumeStep {
  if (['extracted', 'in_review', 'finalized'].includes(state.status)) return 'already-read';
  if (!state.attachment_id) return 'missing-attachment';
  if (state.source?.read_state === 'waiting_for_limit') return 'waiting';
  if (running(state.latest_jobs.translate?.status)) return 'translation';
  if (state.translation_status === 'pending_review') return 'translation-review';
  if (state.translation_required) return 'translation';
  if (running(state.latest_jobs.classify?.status)) return 'classification';
  if (state.source?.needs_report_type) return 'manual-classification';
  const extract = state.latest_jobs.extract;
  if (extract?.status === 'failed') return 'extraction-failed';
  if (extract?.status === 'succeeded') return 'review';
  if (running(extract?.status)) return 'extraction';
  const classify = state.latest_jobs.classify;
  if (classify?.status === 'failed' || state.source?.read_state === 'needs_person') return 'manual-classification';
  if (classify?.status === 'succeeded') return 'classification';
  return state.translation_status ? 'classification' : 'translation';
}
export function manualClassification(value?: Record<string, unknown> | null): ClassificationResult {
  return {
    ...value,
    instrument: (value?.instrument as ClassificationResult['instrument']) ?? { value: '', confidence: 0 },
    report_type: (value?.report_type as ClassificationResult['report_type']) ?? { value: '', confidence: 0 },
    maker_in_fleet: typeof value?.maker_in_fleet === 'boolean' ? value.maker_in_fleet : false,
    resolved_instrument_id: null,
    resolved_template_id: null,
    recognized: true,
  };
}
