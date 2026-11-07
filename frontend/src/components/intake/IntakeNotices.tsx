import type { Instrument, Report, ReportTemplate } from '../../api';
import { REPORT_TYPE_LABEL } from '../../labels';
import { Notice } from '../Notice';
import { describeDuplicates, type SerialNotice } from './serialNotices';
import type { Phase, WaitingForTemplate } from './phases';

/** The serial-number and duplicate notices that sit above the classification and review screens. */
export function SerialAndDuplicateNotices({
  phase,
  serialNotice,
  duplicates,
}: {
  phase: Phase;
  serialNotice: SerialNotice | null;
  duplicates: Record<string, Report | null>;
}) {
  return (
    <>
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
    </>
  );
}

/** The notices above the review screen: what the template did, and the offer to make a model-specific one. */
export function TemplateNotices({
  phase,
  templateNote,
  template,
  reviewInstrument,
  attachmentId,
  report,
  canCreateTemplate,
  genericNoticeDismissed,
  onDismissGeneric,
  onCreateTemplate,
}: {
  phase: Phase;
  templateNote: string | null;
  template: ReportTemplate | null;
  reviewInstrument: Instrument | undefined;
  attachmentId: string | null;
  report: Report | null;
  canCreateTemplate: boolean;
  genericNoticeDismissed: boolean;
  onDismissGeneric: () => void;
  onCreateTemplate: (waiting: WaitingForTemplate) => void;
}) {
  return (
    <>
      {phase.name === 'review' && templateNote && (
        <Notice tone="info" id="template-note">
          {templateNote}
        </Notice>
      )}

      {phase.name === 'review' && template && template.model === null && reviewInstrument && attachmentId && report && canCreateTemplate && !genericNoticeDismissed && (
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
                  onCreateTemplate({ reportId: report.id, attachmentId, instrument: reviewInstrument, reportType: template.report_type })
                }
              >
                Create a {reviewInstrument.model} template
              </button>{' '}
              <button type="button" className="link-button" onClick={onDismissGeneric}>
                Not now
              </button>
            </div>
          }
        >
          Generic {REPORT_TYPE_LABEL[template.report_type]} template in use. A {reviewInstrument.model} template can ask for this model's own
          fields.
        </Notice>
      )}
    </>
  );
}
