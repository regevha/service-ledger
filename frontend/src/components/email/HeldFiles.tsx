import { useRef, useState } from 'react';
import { useAsyncEffect } from '../../hooks/useAsyncEffect';
import { ApiError } from '../../api/http';
import { deleteHeldFile, heldFileUrl, listHeldFiles, releaseHeldFile, type HeldFile } from '../../api/emailIntake';
import { showToast } from '../../toast';
import { ReceivedTime } from './SourceLine';

export function HeldFiles({ onCount }: { onCount: (count: number) => void }) {
  const [rows, setRows] = useState<HeldFile[]>([]);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);
  const [confirming, setConfirming] = useState<HeldFile | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const { loading } = useAsyncEffect(async (isCancelled) => {
    try {
      const items = await listHeldFiles();
      if (!isCancelled()) { setRows(items); onCount(items.length); }
    } catch {
      if (!isCancelled()) setError('Could not load the held files. Check your connection and try again.');
    }
  }, [nonce, onCount], 'Could not load the held files.');
  async function act(row: HeldFile, remove: boolean) {
    if (busy) return;
    setBusy(row.id); setError(''); setLoadedId(null);
    try {
      if (remove) { await deleteHeldFile(row.id); showToast('PDF deleted'); }
      else { const result = await releaseHeldFile(row.id); setLoadedId(result.report_id); }
      const remaining = rows.filter((item) => item.id !== row.id);
      setRows(remaining); onCount(remaining.length); heading.current?.focus();
    } catch (e) {
      if (e instanceof ApiError && [404, 409].includes(e.status)) {
        setError(e.status === 409 && e.message.includes('already in ServiceLedger') ? e.message : 'Someone else already loaded or deleted this file. The list is now up to date.');
        setNonce((n) => n + 1);
      } else setError(`Could not ${remove ? 'delete this file' : 'load this file as a draft'}. Check your connection and try again.`);
    } finally { setBusy(null); setConfirming(null); }
  }
  return <>
    <h2 ref={heading} tabIndex={-1}>Check: maybe not a service report</h2>
    <p className="admin-lead">These PDFs came from allowed senders, but the app could not tell whether they are service reports. They are not read and do not count toward the daily limit. Open each one, then load it as a draft or delete it.</p>
    {loadedId && <div className="banner banner-info" role="status">This file is now a draft. A person still checks it before it is finalized. <a href={`#/reports/${loadedId}`}>Open the draft</a> <button className="btn small" onClick={() => setLoadedId(null)}>Close</button></div>}
    {error && <div className="banner banner-crit" role="alert">{error} <button className="btn small" onClick={() => { setError(''); setNonce((n) => n + 1); }}>Try again</button></div>}
    {confirming && <div className="banner banner-crit" role="alertdialog" aria-label="Confirm delete held file" onKeyDown={(e) => { if (e.key === 'Escape' && !busy) setConfirming(null); }}>
      Delete the file received <ReceivedTime value={confirming.received_at} /> from {confirming.sender_label ?? 'an allowed sender'}? Deletes this PDF from ServiceLedger. Nothing else is changed: no report is made, the sender is not told, and the email log keeps a line saying it was deleted. This cannot be undone.
      <div className="ei-actions"><button className="btn small danger solid" disabled={!!busy} onClick={() => void act(confirming, true)}>{busy ? 'Deleting…' : 'Confirm delete'}</button><button autoFocus className="btn small" disabled={!!busy} onClick={() => setConfirming(null)}>Cancel</button></div>
    </div>}
    {loading ? <p role="status">Loading held files…</p> : !rows.length ? <p className="hint-text">Nothing to check. When an allowed sender emails a PDF that might not be a service report, it waits here for you.</p> :
      <div className="trend-table-wrap" tabIndex={0} role="region" aria-label="Held files"><table className="trend-table ei-table ei-wide-table"><caption className="sr-only">Files held for a check</caption>
        <thead><tr>{['Received', 'Team or role', 'Why it was held', 'PDF', 'Actions'].map((name) => <th key={name} scope="col">{name}</th>)}</tr></thead>
        <tbody>{rows.map((row) => <tr key={row.id}>
          <td data-label="Received"><ReceivedTime value={row.received_at} /></td><td data-label="Team or role">{row.sender_label ?? 'Allowed sender'}</td><td data-label="Why it was held">{row.reason}</td>
          <td data-label="PDF">{row.page_count === null ? '' : `${row.page_count} page${row.page_count === 1 ? '' : 's'} · `}{row.size_bytes < 1024 * 1024 ? `${Math.round(row.size_bytes / 1024)} KB` : `${(row.size_bytes / (1024 * 1024)).toFixed(1)} MB`}</td>
          <td data-label="Actions"><div className="ei-actions"><a className="btn small" href={heldFileUrl(row.id)} target="_blank" rel="noopener noreferrer" aria-label={`Open PDF from ${row.sender_label ?? 'allowed sender'}`}>Open PDF</a><button className="btn small primary" disabled={!!busy} onClick={() => void act(row, false)}>{busy === row.id ? 'Loading…' : 'Load as draft'}</button><button className="btn small danger" disabled={!!busy} onClick={() => { setLoadedId(null); setConfirming(row); }}>Delete</button></div></td>
        </tr>)}</tbody></table></div>}
  </>;
}
