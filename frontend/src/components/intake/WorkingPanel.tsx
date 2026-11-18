import { useEffect, useState } from 'react';
import { attachmentFileUrl, type ExtractionJobStatus } from '../../api';
import { ScanPages } from '../ScanPages';

const JOB_STATUS_TEXT: Record<ExtractionJobStatus, string> = {
  pending: 'Waiting for a worker.',
  translating: 'Worker is checking the language and translating if needed.',
  classifying: 'Worker is identifying the instrument and report type.',
  extracting: 'Worker is reading the report fields.',
  awaiting_approval: 'Waiting for prompt approval.',
  succeeded: 'Loading the result.',
  failed: 'Reading stopped.',
};

export function WorkingPanel({
  label,
  jobStatus,
  fileName,
  attachmentId,
  onCancel,
}: {
  label: string;
  jobStatus?: ExtractionJobStatus;
  fileName?: string;
  attachmentId?: string;
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
          <div role="status">
            <div>{label}</div>
            {jobStatus && <div className="working-detail">{JOB_STATUS_TEXT[jobStatus]}</div>}
          </div>
          <div className="working-detail">
            {fileName && <span className="working-file" data-testid="intake-working-file">{fileName}</span>}
            <span>Elapsed {seconds}s</span>
          </div>
          <ol className="working-steps" aria-label="Progress">
            <li className={attachmentId ? 'done' : 'now'} aria-current={attachmentId ? undefined : 'step'}>
              {attachmentId ? 'Scan uploaded' : 'Upload scan'}
            </li>
            <li className={attachmentId ? 'now' : undefined} aria-current={attachmentId ? 'step' : undefined}>Read the report</li>
            <li>You check the result</li>
          </ol>
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
