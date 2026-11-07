/** The buttons under the field list: Next, Save corrections, Save & finalize, Edit, Cancel. */
export function ReviewActions({
  readOnly,
  flaggedCount,
  busy,
  confirmingEdit,
  onNext: goToNextFlagged,
  onAskEdit,
  onCancelEdit,
  onSave,
  onRequestFinalize,
}: {
  readOnly: boolean;
  flaggedCount: number;
  busy: 'save' | 'finalize' | null;
  confirmingEdit: boolean;
  onNext: () => void;
  onAskEdit?: () => void;
  onCancelEdit?: () => void;
  onSave: () => void;
  onRequestFinalize?: () => void;
}) {
  return (
    <div className="review-actions" aria-busy={busy !== null}>
      <div className="review-actions-status">
        {readOnly ? (
          <span>Finalized. Press Edit to change it.</span>
        ) : flaggedCount > 0 ? (
          <>
            <span className="review-actions-count">
              {flaggedCount} field{flaggedCount === 1 ? '' : 's'} need{flaggedCount === 1 ? 's' : ''} attention
            </span>
            <button
              type="button"
              className="btn small"
              onClick={goToNextFlagged}
              title={`${flaggedCount} field${flaggedCount === 1 ? '' : 's'} need${flaggedCount === 1 ? 's' : ''} attention`}
            >
              <span className="next-long">Next ↓</span>
              <span className="next-short" aria-hidden="true">
                {flaggedCount} ↓
              </span>
            </button>
          </>
        ) : null}
      </div>
      <div className="review-actions-buttons">
        {readOnly ? (
          onAskEdit && (
            <button className="btn" onClick={onAskEdit} aria-expanded={confirmingEdit}>
              Edit
            </button>
          )
        ) : (
          <>
            {onCancelEdit && (
              <button className="btn review-cancel-edit" onClick={onCancelEdit} disabled={busy !== null}>
                Cancel
              </button>
            )}
            <button className="btn" onClick={onSave} disabled={busy !== null}>
              {busy === 'save' ? 'Saving…' : 'Save corrections'}
            </button>
            {onRequestFinalize && (
              <button className="btn primary" onClick={onRequestFinalize} disabled={busy !== null}>
                {busy === 'finalize' ? 'Finalizing…' : <>Save &amp; finalize report</>}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
