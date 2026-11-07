import { type ClassificationResult, type Instrument, type Report, type SerialMatch } from '../../api';

export type SerialNotice = { tone: 'info' | 'warn'; text: string };

/**
 * The warning shown when the document is already on file: the upload found a
 * report holding the same bytes, or classification found one with the same
 * work-order number. `duplicates` maps each such report id to the report once
 * it has loaded (null while loading or if it could not be loaded — the warning
 * still shows, just less specifically). A warning only: the technician may
 * legitimately attach the same document to a second report.
 */
export function describeDuplicates(duplicates: Record<string, Report | null>): string | null {
  const reports = Object.values(duplicates);
  if (reports.length === 0) return null;
  const describe = (r: Report | null) => {
    if (!r) return 'another report';
    const who = r.technician_name ? ` by ${r.technician_name}` : '';
    return `${/^[aeiou]/i.test(r.status) ? 'an' : 'a'} ${r.status} report${who} from ${r.report_date ?? r.created_at.slice(0, 10)}`;
  };
  return `This document looks already on file: ${reports.map(describe).join('; ')}. If it is a re-scan of the same visit, finalizing records the visit twice.`;
}

/**
 * What to tell the technician about the serial number read off the document
 * (ClassificationResult.serial_match). `assigned` is the instrument the report
 * ended up with automatically, if any. Returns null when there is nothing worth
 * saying — no serial on the document.
 */
export function describeSerialMatch(
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
    if (assigned) return { tone: 'info', text: `Matched to ${label(assigned)} by serial number.` };
    // Not assigned automatically, but not necessarily because of the serial:
    // a low report-type read also sends the report to this screen. Say so
    // only when the serial itself was a confident read.
    if (suggested && (result.instrument_serial?.confidence ?? 0) >= threshold) {
      return { tone: 'info', text: `Matched to ${label(suggested)} by serial number. Confirm the details below.` };
    }
    return {
      tone: 'info',
      text: `Serial ${serial}${suggested ? ` looks like ${label(suggested)}` : ''}. Not read confidently enough to assign it automatically — check it.`,
    };
  }
  if (match === 'model_conflict') {
    return {
      tone: 'warn',
      text: `Serial ${serial} belongs to ${suggested ? label(suggested) : 'another instrument'}, but the model read is ${result.instrument.value}. One is wrong — choose the instrument.`,
    };
  }
  // not_found
  return {
    tone: 'warn',
    text: assigned
      ? `Serial ${serial} is not in your fleet. Assigned to ${label(assigned)}, the only ${assigned.model} — check it, or add the serial under Instruments.`
      : `Serial ${serial} is not in your fleet. Choose the unit below, or add it under Instruments.`,
  };
}

// What the serial read means for the instrument choice, in a line under it.
export const SERIAL_MATCH_NOTE: Record<SerialMatch, string> = {
  matched: 'Matches one unit in your fleet.',
  not_found: 'Not in your fleet. Choose the unit yourself, or add this serial under Instruments.',
  model_conflict: 'Belongs to a different model than the one read from the document. One of the two is wrong.',
  not_read: 'No serial number found on the document.',
};
