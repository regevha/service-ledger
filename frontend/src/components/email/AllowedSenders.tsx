import { useRef, useState } from 'react';
import { useAsyncEffect } from '../../hooks/useAsyncEffect';
import { ApiError } from '../../api/http';
import { addAllowedSender, changeAllowedSender, listAllowedSenders, removeAllowedSender, type AllowedSender } from '../../api/emailIntake';
import { showToast } from '../../toast';
import { PUBLIC_DOMAINS, senderLabelError, senderValueError } from './allowedSenderRules';

export function AllowedSenders() {
  const [rows, setRows] = useState<AllowedSender[]>([]);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);
  const [form, setForm] = useState<'add' | AllowedSender | null>(null);
  const [removing, setRemoving] = useState<AllowedSender | null>(null);
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const { loading } = useAsyncEffect(async (isCancelled) => {
    try {
      const items = await listAllowedSenders();
      if (!isCancelled()) { setRows(items); setError(''); }
    } catch {
      if (!isCancelled()) setError('Could not load the allowed senders. Check your connection and try again.');
    }
  }, [nonce], 'Could not load the allowed senders.');
  async function remove() {
    if (!removing || busy) return;
    setBusy(true);
    try {
      await removeAllowedSender(removing.id).catch((e: unknown) => { if (!(e instanceof ApiError && e.status === 404)) throw e; });
      setRows((items) => items.filter((row) => row.id !== removing.id));
      showToast('Sender removed');
      heading.current?.focus();
    } catch { setError('Could not remove the sender. Check your connection and try again.'); }
    finally { setBusy(false); setRemoving(null); }
  }
  return <>
    <h2 ref={heading} tabIndex={-1}>Allowed senders</h2>
    <p className="admin-lead">Email from these addresses and domains is loaded as draft reports. Email from anyone else is dropped without a reply. A person still checks every report before it is finalized.</p>
    {error && <div className="banner banner-crit" role="alert">{error} <button className="btn small" onClick={() => setNonce((n) => n + 1)}>Try again</button></div>}
    {!form && !(error && !rows.length) && <div><button ref={addButton} className="btn primary" disabled={loading || busy} onClick={() => { setRemoving(null); setForm('add'); }}>Add a sender</button></div>}
    {form && <SenderForm key={form === 'add' ? 'add' : form.id} entry={form === 'add' ? undefined : form} onCancel={() => { setForm(null); requestAnimationFrame(() => addButton.current?.focus()); }} onBusy={setBusy} onSaved={(row) => { setRows((items) => [...items.filter((item) => item.id !== row.id), row].sort((a, b) => a.kind.localeCompare(b.kind) || a.value.localeCompare(b.value))); setForm(null); heading.current?.focus(); }} />}
    {removing && <div className="banner banner-crit" role="alertdialog" aria-label="Confirm remove sender" onKeyDown={(e) => { if (e.key === 'Escape' && !busy) setRemoving(null); }}>
      Remove {removing.kind === 'domain' ? 'the whole domain @' : ''}<strong>{removing.value}</strong> ({removing.label}) from the allowed senders? New mail from this {removing.kind} will be dropped{removing.kind === 'domain' ? ', except from addresses listed on their own' : ''}. Reports already loaded stay. No reply is sent to dropped mail.
      <div className="ei-actions"><button className="btn small danger solid" disabled={busy} onClick={() => void remove()}>{busy ? 'Removing…' : 'Confirm remove'}</button><button autoFocus className="btn small" disabled={busy} onClick={() => setRemoving(null)}>Cancel</button></div>
    </div>}
    {loading ? <p role="status">Loading allowed senders…</p> : !rows.length ? <p className="hint-text">No allowed senders yet. Until you add one, every email is dropped without a reply.</p> :
      <div className="trend-table-wrap" tabIndex={0} role="region" aria-label="Allowed senders"><table className="trend-table ei-table"><caption className="sr-only">Allowed senders: addresses first, then domains</caption>
        <thead><tr>{['Address or domain', 'Team or role', 'Added', 'Actions'].map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead>
        <tbody>{rows.map((row) => <tr key={row.id}>
          <td data-label="Address or domain"><span className="ei-addr">{row.kind === 'domain' ? '@' : ''}{row.value}</span><span className="ei-sub">{row.kind === 'domain' ? 'Whole domain' : 'One address'}</span></td>
          <td data-label="Team or role">{row.label}</td><td data-label="Added"><time dateTime={row.created_at}>{new Date(row.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</time></td>
          <td data-label="Actions"><div className="ei-actions"><button className="btn small" disabled={busy} aria-label={`Change team or role for ${row.value}`} onClick={() => { setRemoving(null); setForm(row); }}>Change team or role</button><button className="btn small danger" disabled={busy} aria-label={`Remove ${row.value}`} onClick={() => { setForm(null); setRemoving(row); }}>Remove</button></div></td>
        </tr>)}</tbody></table></div>}
  </>;
}

function SenderForm({ entry, onCancel, onSaved, onBusy }: { entry?: AllowedSender; onCancel: () => void; onSaved: (row: AllowedSender) => void; onBusy: (value: boolean) => void }) {
  const [kind, setKind] = useState<'address' | 'domain'>(entry?.kind ?? 'address');
  const [value, setValue] = useState(entry?.value ?? '');
  const [label, setLabel] = useState(entry?.label ?? '');
  const [valueError, setValueError] = useState<string | null>(null);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState(false);
  const [busy, setBusy] = useState(false);
  const valueInput = useRef<HTMLInputElement>(null);
  const labelInput = useRef<HTMLInputElement>(null);
  async function save(confirmed = false) {
    if (busy) return;
    const badValue = entry ? null : senderValueError(kind, value);
    const badLabel = senderLabelError(label);
    setValueError(badValue); setLabelError(badLabel); setError('');
    if (badValue || badLabel) { (badValue ? valueInput : labelInput).current?.focus(); return; }
    const normalized = value.trim().toLowerCase().replace(kind === 'domain' ? /^@/ : /$^/, '');
    if (!entry && kind === 'domain' && PUBLIC_DOMAINS.has(normalized) && !confirmed) { setWarning(true); return; }
    setBusy(true); onBusy(true);
    try {
      const row = entry ? await changeAllowedSender(entry.id, label.trim()) : await addAllowedSender({ kind, value: normalized, label: label.trim() });
      showToast(entry ? 'Team or role changed' : 'Sender added'); onSaved(row);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setValueError(e.message);
      else setError(e instanceof ApiError && e.status === 422 ? e.message : entry ? 'Could not change the team or role. Check your connection and try again.' : 'Could not add the sender. Check your connection and try again.');
    } finally { setBusy(false); onBusy(false); }
  }
  return <form className="admin-form" noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
    {!entry && <>
      <fieldset disabled={busy}><legend>What to add</legend><label><input type="radio" name="sender-kind" autoFocus checked={kind === 'address'} onChange={() => { setKind('address'); setValueError(null); setWarning(false); }} />One address</label><label><input type="radio" name="sender-kind" checked={kind === 'domain'} onChange={() => { setKind('domain'); setValueError(null); setWarning(false); }} />A whole domain</label></fieldset>
      <label>{kind === 'address' ? 'Email address' : 'Domain'}<input ref={valueInput} type={kind === 'address' ? 'email' : 'text'} inputMode={kind === 'address' ? 'email' : 'url'} autoCapitalize="none" autoComplete="off" spellCheck={false} disabled={busy} value={value} placeholder={kind === 'address' ? 'lab-team@example.org' : 'example.org'} aria-invalid={!!valueError} aria-describedby={valueError ? 'sender-value-error' : undefined} onChange={(e) => { setValue(e.target.value); setValueError(null); setWarning(false); }} /></label>
      {valueError && <p id="sender-value-error" className="ei-field-error">{valueError}</p>}
      {kind === 'domain' && <p className="hint-text">Everyone whose address ends in @{value.trim().replace(/^@/, '') || 'example.org'} may send. Addresses at sub-domains are not included. If one address of this domain is also listed on its own, its own team or role is used.</p>}
    </>}
    <label>Team or role<input ref={labelInput} autoFocus={!!entry} onFocus={(event) => { if (entry) event.currentTarget.select(); }} type="text" maxLength={60} disabled={busy} value={label} placeholder="Flow core team" aria-invalid={!!labelError} aria-describedby={labelError ? 'sender-label-error' : undefined} onChange={(e) => { setLabel(e.target.value); setLabelError(null); }} /></label>
    {labelError && <p id="sender-label-error" className="ei-field-error">{labelError}</p>}
    <p className="hint-text">{entry ? 'Reports already loaded keep the team or role they had.' : "A team or role, such as Flow core team or Imaging core. Not a person's name. It is shown on every report this sender sends."}</p>
    {error && <div className="banner banner-crit" role="alert">{error}</div>}
    {warning && <div className="banner banner-warn" role="alert">Anyone with an @{value.trim().replace(/^@/, '').toLowerCase()} address could then send reports to ServiceLedger. Add single addresses instead, unless that is what you want.<div className="ei-actions"><button type="button" className="btn small" disabled={busy} onClick={() => void save(true)}>Add the whole domain anyway</button><button type="button" className="btn small" disabled={busy} onClick={() => { setWarning(false); valueInput.current?.focus(); }}>Change it</button></div></div>}
    <div className="ei-actions"><button className="btn primary" disabled={busy}>{busy ? entry ? 'Saving…' : 'Adding…' : entry ? 'Save' : 'Add sender'}</button><button className="btn" type="button" disabled={busy} onClick={onCancel}>Cancel</button></div>
  </form>;
}
