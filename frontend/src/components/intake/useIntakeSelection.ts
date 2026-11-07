import { useState } from 'react';
import { getReport, type Report, type ReportType } from '../../api';
import type { SerialNotice } from './serialNotices';

/**
 * What the person picked on the Classify screen and what the document turned up: the chosen
 * instrument and report type, whether they chose the unit themselves, the serial-number notice and
 * any reports that already hold this document. Moved out of IntakeFlow unchanged.
 */
export function useIntakeSelection() {
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

  function clearDuplicates() {
    setDuplicates({});
  }

  return {
    pickInstrumentId, setPickInstrumentId,
    pickReportType, setPickReportType,
    unitChosen, setUnitChosen,
    serialNotice, setSerialNotice,
    duplicates,
    noteDuplicates,
    clearDuplicates,
  };
}
