import type { RefObject } from 'react';

/** Asks before a finalized report is opened for changes. */
export function EditConfirm({ onEdit, onClose }: { onEdit: () => void; onClose: () => void }) {
  return (
    <div
      className="banner banner-warn"
      id="edit-confirm"
      role="alertdialog"
      aria-label="Edit a finalized report"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <span>This report is finalized. Changes you save replace the finalized values.</span>{' '}
      <button
        type="button"
        className="btn small"
        autoFocus
        onClick={() => {
          onEdit();
        }}
      >
        Edit anyway
      </button>
      <button type="button" className="btn small" onClick={() => onClose()}>
        Cancel
      </button>
    </div>
  );
}

/** Asks before finalizing a report that still has fields needing attention. */
export function FinalizeConfirm({
  flaggedCount, busy, confirmRef, onReview, onFinalizeAnyway, onClose,
}: {
  flaggedCount: number;
  busy: 'save' | 'finalize' | null;
  confirmRef: RefObject<HTMLDivElement | null>;
  onReview: () => void;
  onFinalizeAnyway: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="banner banner-warn finalize-confirm"
      id="finalize-confirm"
      role="alertdialog"
      aria-label="Confirm finalize"
      ref={confirmRef}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div>
        {flaggedCount} field{flaggedCount === 1 ? '' : 's'} still need{flaggedCount === 1 ? 's' : ''} attention.
        Finalize anyway? A finalized report goes into search, analytics and exports.
      </div>
      <button type="button" className="btn small" onClick={onReview}>
        Review them
      </button>{' '}
      <button type="button" className="btn small" onClick={onFinalizeAnyway} disabled={busy !== null}>
        Finalize anyway
      </button>
    </div>
  );
}
