import { useEffect, useState } from 'react';
import { useOnline } from '../../hooks/useOnline';
import { leaveNote } from './leaveNote';

export function WorkingPanel({
  label,
  fileName,
  slow,
  uploading,
  onCancel,
}: {
  label: string;
  fileName?: string;
  /** True when a live model is reading the scan, which takes a while. */
  slow: boolean;
  /** True while the report is being created and the scan sent: leaving the page now would lose the upload. */
  uploading: boolean;
  onCancel?: () => void;
}) {
  const [seconds, setSeconds] = useState(0);
  const online = useOnline();
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="section working-panel" data-testid="intake-working">
      <div className="spinner" />
      <div className="working-text">
        <div>{label}</div>
        <div className="working-detail">
          {fileName && <span className="working-file" data-testid="intake-working-file">{fileName}</span>}
          <span>{seconds}s</span>
        </div>
        {slow && seconds < 90 && <div className="working-detail">Reading a scan usually takes 10–60 seconds; a translated one takes longer.</div>}
        {slow && seconds >= 90 && <div className="working-detail">Still working — this one is taking longer than usual.</div>}
        <ul className="working-steps" aria-label="Progress">
          <li className={uploading ? 'now' : 'done'}>{uploading ? 'Sending the scan' : 'Scan uploaded'}</li>
          <li className={uploading ? undefined : 'now'}>{uploading ? 'Reading the document' : label.replace(/[….]+$/, '')}</li>
          <li>You check the result</li>
        </ul>
        {uploading && seconds >= 20 && online && <div className="working-detail">The connection looks slow; the scan is still being sent.</div>}
        <div className="working-detail" data-testid="intake-leave-note" role="status">
          {leaveNote(uploading, online)}
        </div>
      </div>
      {onCancel && (
        <button type="button" className="btn small" data-testid="intake-cancel" onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  );
}
