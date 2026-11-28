import type { Report } from '../../api/types';
import './emailIntake.css';

export function ReceivedTime({ value }: { value: string }) {
  return <time dateTime={value}>{new Date(value).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>;
}
export function SourceLine({ report }: { report: Report }) {
  const source = report.source;
  return <p className="source-line" data-testid="source-line">
    {source?.channel === 'email' ? <>Received by email{source.sender_label ? ` · ${source.sender_label}` : ''} · <ReceivedTime value={source.received_at} />
      {source.sender_address && <span className="ei-sub ei-addr">Sent from {source.sender_address}</span>}</>
      : <>Uploaded in the app · <ReceivedTime value={report.created_at} /></>}
  </p>;
}
