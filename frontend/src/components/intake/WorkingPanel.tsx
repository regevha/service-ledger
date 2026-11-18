import { useEffect, useState } from 'react';
import { attachmentFileUrl } from '../../api';
import { ScanPages } from '../ScanPages';

export function WorkingPanel({
  label,
  fileName,
  attachmentId,
  slow,
  onCancel,
}: {
  label: string;
  fileName?: string;
  attachmentId?: string;
  /** True when a live model is reading the scan, which takes a while. */
  slow: boolean;
  onCancel?: () => void;
}) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className={`section intake-working-layout${attachmentId ? ' with-scan' : ''}`} data-testid="intake-working">
      <div className="working-panel intake-working-status">
        <div className="spinner" aria-hidden="true" />
        <div className="working-text">
          <div role="status">{label}</div>
          <div className="working-detail">
            {fileName && <span className="working-file" data-testid="intake-working-file">{fileName}</span>}
            <span>{seconds}s</span>
          </div>
          {slow && seconds >= 90 && <div className="working-detail">Still working. This is taking longer than usual.</div>}
          <ul className="working-steps" aria-label="Progress">
            <li className={attachmentId ? 'done' : 'now'} aria-current={attachmentId ? undefined : 'step'}>
              {attachmentId ? 'Scan uploaded' : 'Upload scan'}
            </li>
            <li className={attachmentId ? 'now' : undefined} aria-current={attachmentId ? 'step' : undefined}>Read the report</li>
            <li>You check the result</li>
          </ul>
          {onCancel && (
            <button type="button" className="btn small" data-testid="intake-cancel" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
      </div>
      {attachmentId && (
        <aside className="intake-working-scan" aria-label="Original scan" data-testid="intake-working-scan">
          <a className="link-button" href={attachmentFileUrl(attachmentId, { inline: true })} target="_blank" rel="noreferrer">
            View original scan
          </a>
          <ScanPages key={attachmentId} attachmentId={attachmentId} />
        </aside>
      )}
    </div>
  );
}
