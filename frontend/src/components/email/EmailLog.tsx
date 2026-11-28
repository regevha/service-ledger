import { useState } from 'react';
import { useAsyncEffect } from '../../hooks/useAsyncEffect';
import { getEmailLog, type EmailLogRow } from '../../api/emailIntake';
import { ReceivedTime } from './SourceLine';
import { emailFiles, emailOutcome, replyStatus } from './emailLog';

export function EmailLog({ refresh }: { refresh: number }) {
  const [page, setPage] = useState<{ items: EmailLogRow[]; total: number } | null>(null);
  const [offset, setOffset] = useState(0);
  const [nonce, setNonce] = useState(0);
  const [error, setError] = useState(false);
  const { loading } = useAsyncEffect(async (isCancelled) => {
    setError(false);
    try {
      const data = await getEmailLog(offset);
      if (isCancelled()) return;
      if (!data.items.length && offset) setOffset(0);
      else setPage(data);
    } catch { if (!isCancelled()) setError(true); }
  }, [offset, nonce, refresh], 'Could not load the email log.');
  return <>
    <h2>Email log</h2>
    <p className="admin-lead">Every email the app received in the last 90 days, newest first. Subjects, email text and file names are omitted from this log. Addresses are kept only for allowed senders.</p>
    <div className="ei-actions"><span role="status">{loading ? 'Loading…' : page?.total ? `Showing ${offset + 1}–${Math.min(offset + 50, page.total)} of ${page.total}` : '0 emails'}</span>
      <button className="btn small" disabled={loading || !offset} onClick={() => setOffset((value) => Math.max(0, value - 50))}>Newer</button><button className="btn small" disabled={loading || !page || offset + 50 >= page.total} onClick={() => setOffset((value) => value + 50)}>Older</button><button className="btn small" disabled={loading} onClick={() => { setOffset(0); setNonce((n) => n + 1); }}>Refresh</button>
    </div>
    {error && <div className="banner banner-crit" role="alert">Could not load the email log. Check your connection and try again. <button className="btn small" onClick={() => setNonce((n) => n + 1)}>Try again</button></div>}
    {!page && loading ? <p role="status">Loading the email log…</p> : !page?.items.length ? <p className="hint-text">No email received yet.</p> :
      <div className="trend-table-wrap" tabIndex={0} role="region" aria-label="Email log"><table className="trend-table ei-table ei-wide-table"><caption className="sr-only">Email log, newest first</caption>
        <thead><tr>{['Received', 'From', 'What happened', 'Files', 'Reply'].map((name) => <th key={name} scope="col">{name}</th>)}</tr></thead>
        <tbody>{page.items.map((row) => <tr key={row.id}>
          <td data-label="Received"><ReceivedTime value={row.received_at} /></td><td data-label="From">{row.sender_label ?? (row.outcome === 'sender_not_verified' ? 'Sender could not be confirmed' : 'Not on the list')}{row.sender_address && <span className="ei-sub ei-addr">{row.sender_address}</span>}</td>
          <td data-label="What happened">{emailOutcome(row.outcome)}{row.reason && <span className="ei-sub">{row.reason}</span>}</td><td data-label="Files">{emailFiles(row)}</td><td data-label="Reply">{replyStatus(row.reply_status)}{row.reply_status === 'failed' && <span className="ei-sub">Tried 3 times</span>}</td>
        </tr>)}</tbody></table></div>}
  </>;
}
