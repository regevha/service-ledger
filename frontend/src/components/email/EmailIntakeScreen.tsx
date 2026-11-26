import { useCallback, useEffect, useState } from 'react';
import { getEmailIntakeStatus, listHeldFiles, type EmailIntakeStatus } from '../../api/emailIntake';
import { showToast } from '../../toast';
import { AllowedSenders } from './AllowedSenders';
import { HeldFiles } from './HeldFiles';
import { EmailLog } from './EmailLog';
import './emailIntake.css';

export function EmailIntakeScreen({ section, onHeldCount }: { section: string; onHeldCount: (count: number | null) => void }) {
  const [status, setStatus] = useState<EmailIntakeStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [heldCount, setHeldCount] = useState<number | null>(null);
  const updateHeldCount = useCallback((count: number) => { setHeldCount(count); onHeldCount(count); }, [onHeldCount]);
  const part = section === 'email/held' ? 'held' : section === 'email/log' ? 'log' : 'allowed';
  useEffect(() => {
    let active = true;
    getEmailIntakeStatus().then((value) => { if (active) setStatus(value); }).catch(() => { if (active) setStatusFailed(true); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!status?.enabled) return;
    let active = true;
    listHeldFiles().then((rows) => { if (active) { setHeldCount(rows.length); onHeldCount(rows.length); } }).catch(() => { if (active) onHeldCount(null); });
    return () => { active = false; };
  }, [status?.enabled, onHeldCount]);
  return <section className="ei-section">
    <h1 className="admin-title">Email intake</h1>
    <nav className="ei-subnav" aria-label="Email intake">
      {[['allowed', 'email', 'Allowed senders'], ['held', 'email/held', `Held for a check${heldCount ? ` (${heldCount})` : ''}`], ['log', 'email/log', 'Email log']].map(([id, route, label]) =>
        <a key={id} href={`#/admin/${route}`} className={`btn small${part === id ? ' active' : ''}`} aria-current={part === id ? 'page' : undefined}>{label}</a>)}
    </nav>
    {status && <div className="ei-status">
      <span className={`status-pill ei-state-${status.enabled ? 'on' : 'off'}`}>{status.enabled ? 'On' : 'Off'}</span>{' '}
      {status.enabled ? <>
        Reports sent to {status.intake_address ? <strong className="ei-addr">{status.intake_address}</strong> : 'the intake address'} are loaded as drafts. Up to {status.max_pdfs_per_message} PDFs per email, each up to {status.max_pdf_megabytes} MB. The mailbox is checked every {status.poll_interval_seconds === 60 ? 'minute' : `${status.poll_interval_seconds} seconds`}.
        {status.mailbox === 'folder' && <p>This is the test mailbox: emails are read from a folder on the server, and replies are saved there instead of being sent.</p>}
        {status.intake_address && <button className="btn small" onClick={() => void navigator.clipboard.writeText(status.intake_address!).then(() => showToast('Address copied')).catch(() => showToast('Could not copy the address. Select and copy it above.'))}>Copy address</button>}
      </> : 'Email intake is off. Nothing is read from the mailbox. Ask whoever runs the server to switch it on.'}
    </div>}
    {status?.enabled || statusFailed ? <>
      {part === 'allowed' ? <AllowedSenders /> : part === 'held' ? <HeldFiles onCount={updateHeldCount} /> : <EmailLog />}
    </> : status ? <p className="hint-text">Allowed senders, held files and the email log are available when email intake is switched on.</p> : <p role="status">Loading email intake…</p>}
  </section>;
}
