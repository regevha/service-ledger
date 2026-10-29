/**
 * Shown when the person is about to leave a screen that has edits that were not saved.
 * Stay is the safe default (it has the focus, and Escape means Stay).
 */
export function UnsavedChangesDialog({
  message,
  busy,
  onSave,
  onDiscard,
  onStay,
}: {
  message: string;
  busy: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onStay: () => void;
}) {
  return (
    <div className="leave-dialog-backdrop" role="presentation">
      <div
        className="leave-dialog"
        id="leave-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="leave-dialog-title"
        aria-describedby="leave-dialog-message"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) onStay();
        }}
      >
        <h2 id="leave-dialog-title">Unsaved changes</h2>
        <p id="leave-dialog-message">{message}</p>
        <div className="leave-dialog-actions">
          <button type="button" className="btn" onClick={onStay} disabled={busy} autoFocus>
            Stay
          </button>
          <button type="button" className="btn" onClick={onDiscard} disabled={busy}>
            Discard changes
          </button>
          <button type="button" className="btn primary" onClick={onSave} disabled={busy}>
            {busy ? 'Saving…' : 'Save and leave'}
          </button>
        </div>
      </div>
    </div>
  );
}
