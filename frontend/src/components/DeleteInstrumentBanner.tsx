import type { Instrument } from '../api';

export type PendingInstrumentDelete = { instrument: Instrument; total: number; finalized: number };

/** The confirmation shown before an instrument (and every report on it) is deleted. */
export function DeleteInstrumentBanner({
  pending,
  deleting,
  onConfirm,
  onCancel,
}: {
  pending: PendingInstrumentDelete;
  deleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="banner banner-crit" role="alertdialog" aria-label="Confirm delete instrument">
      <div>
        Delete {pending.instrument.name} ({pending.instrument.serial_number})?{' '}
        {pending.total === 0
          ? 'It has no reports.'
          : `This also permanently deletes its ${pending.total} report${pending.total === 1 ? '' : 's'}${
              pending.finalized > 0 ? ` (${pending.finalized} finalized)` : ''
            } and their scans.`}{' '}
        This cannot be undone.
      </div>
      <button type="button" className="btn small danger solid" onClick={onConfirm} disabled={deleting}>
        Confirm delete
      </button>{' '}
      <button type="button" className="btn small" onClick={onCancel} disabled={deleting}>
        Cancel
      </button>
    </div>
  );
}
