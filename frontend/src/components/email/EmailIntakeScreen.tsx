import { useCallback, useEffect, useState } from 'react';
import { getEmailIntakeStatus, listHeldFiles, pollEmailIntake, type EmailIntakeStatus } from '../../api/emailIntake';
import { ApiError } from '../../api/http';
import { showToast } from '../../toast';
import { AllowedSenders } from './AllowedSenders';
import { HeldFiles } from './HeldFiles';
import { EmailLog } from './EmailLog';
import './emailIntake.css';

export function EmailIntakeScreen({ section, onHeldCount }: { section: string; onHeldCount: (count: number | null) => void }) {
  const [status, setStatus] = useState<EmailIntakeStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [heldCount, setHeldCount] = useState<number | null>(null);
  const [polling, setPolling] = useState(false);
  const [pollMessage, setPollMessage] = useState('');
  const [pollError, setPollError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const updateHeldCount = useCallback((count: number) => { setHeldCount(count); onHeldCount(count); }, [onHeldCount]);
  const part = section === 'email/held' ? 'held' : section === 'email/log' ? 'log' : 'allowed';
  const address = status?.intake_address;
  async function checkMailbox() {
    if (polling) return;
    setPolling(true);
    setPollMessage('');
    setPollError(false);
    try {
      const { handled } = await pollEmailIntake();
      setPollMessage(handled === 0 ? 'No new emails to process.' : `${handled} ${handled === 1 ? 'email' : 'emails'} processed. See Email log for details.`);
    } catch (error) {
      setPollError(true);
      setPollMessage(error instanceof ApiError && [409, 502, 503].includes(error.status)
        ? error.message : 'Could not check the mailbox. Try again.');
    } finally {
      setPolling(false);
      setRefresh((value) => value + 1);
    }
  }
  async function copyAddress() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      showToast('Address copied');
    } catch {
      showToast('Could not copy the address. Select and copy it above.');
    }
  }
  useEffect(() => {
    let active = true;
    getEmailIntakeStatus().then((value) => { if (active) setStatus(value); }).catch(() => { if (active) setStatusFailed(true); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!status?.enabled || part === 'held') return;
    let active = true;
    listHeldFiles().then((rows) => { if (active) { setHeldCount(rows.length); onHeldCount(rows.length); } }).catch(() => { if (active) onHeldCount(null); });
    return () => { active = false; };
  }, [status?.enabled, onHeldCount, part, refresh]);
  return <section className="ei-section">
    <h1 className="admin-title">Email intake</h1>
    <nav className="ei-subnav" aria-label="Email intake">
      {[['allowed', 'email', 'Allowed senders'], ['held', 'email/held', `Held for a check${heldCount ? ` (${heldCount})` : ''}`], ['log', 'email/log', 'Email log']].map(([id, route, label]) =>
        <a key={id} href={`#/admin/${route}`} className="btn small" aria-current={part === id ? 'page' : undefined}>{label}</a>)}
    </nav>
    {status && <div className="ei-status">
      <div className="ei-status-header">
        <span className={`status-pill ei-state-${status.enabled ? 'on' : 'off'}`}>{status.enabled ? 'On' : 'Off'}</span>
        {status.enabled && address && <>
          <strong className="ei-addr">{address}</strong>
          <button type="button" className="btn small" onClick={() => void copyAddress()}>Copy address</button>
        </>}
      </div>
      {status.enabled ? <>
        <p>Up to {status.max_pdfs_per_message} PDFs per email, {status.max_pdf_megabytes} MB each. Configured polling interval: {status.poll_interval_seconds === 60 ? '1 minute' : `${status.poll_interval_seconds} seconds`}.</p>
        {status.mailbox === 'folder' && <p>This is the test mailbox: emails are read from a folder on the server, and replies are saved there instead of being sent.</p>}
        <div className="ei-actions ei-poll">
          <button type="button" className="btn small primary" disabled={polling} onClick={() => void checkMailbox()}>
            {polling ? 'Checking for new mail…' : 'Check for new mail'}
          </button>
          <p role={pollError ? 'alert' : 'status'}>{pollMessage}</p>
        </div>
      </> : <p>Email intake is off. Ask whoever runs the server to switch it on.</p>}
    </div>}
    {status?.enabled || statusFailed ? <>
      {part === 'allowed' ? <AllowedSenders /> : part === 'held' ? <HeldFiles onCount={updateHeldCount} refresh={refresh} /> : <EmailLog refresh={refresh} />}
    </> : status ? <p className="hint-text">Allowed senders, held files and the email log are available when email intake is switched on.</p> : <p role="status">Loading email intake…</p>}
  </section>;
}
