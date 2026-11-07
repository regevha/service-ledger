import { useRef, useState } from 'react';
import type { TemplateRequest } from '../../templateRequest';
import type { WaitingForTemplate } from './phases';

/**
 * Asking the Templates tab for a template of the report's own: the report waiting for it, the
 * dismissed "generic template" notice and the note shown when a saved template did not apply.
 * Moved out of IntakeFlow unchanged.
 */
export function useTemplateRequest(onCreateTemplate?: (request: TemplateRequest) => void) {
  // The report that asked for a template of its own, until one is saved.
  const waitingRef = useRef<WaitingForTemplate | null>(null);
  const [genericNoticeDismissed, setGenericNoticeDismissed] = useState(false);
  // Said in the review screen when a saved template did not apply to this report.
  const [templateNote, setTemplateNote] = useState<string | null>(null);

  function requestTemplate(waiting: WaitingForTemplate) {
    waitingRef.current = waiting;
    setTemplateNote(null);
    onCreateTemplate?.({
      instrumentType: waiting.instrument.instrument_type,
      reportType: waiting.reportType,
      model: waiting.instrument.model,
    });
  }

  function resetTemplateRequest() {
    waitingRef.current = null;
    setGenericNoticeDismissed(false);
    setTemplateNote(null);
  }

  return { waitingRef, genericNoticeDismissed, setGenericNoticeDismissed, templateNote, setTemplateNote, requestTemplate, resetTemplateRequest };
}
