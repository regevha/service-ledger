import { useEffect, useState } from 'react';
import { listReports, reportsExportUrl, type Instrument, type ReportFilters, type ReportStatus, type ReportType } from '../api';
import { REPORT_TYPE_LABEL, STATUS_LABEL } from '../labels';
import { DateInput } from './DateInput';
import { FieldAliasManagerScreen } from './FieldAliasManager';

type Section = 'export' | 'aliases';

/**
 * Admin: housekeeping that is not part of the daily flow. Data export (the CSV that used to sit on the
 * Reports list) and the field aliases manager. Visible to everyone. `section` is the part of the address
 * after #/admin/, so a section can be bookmarked.
 */
export function AdminScreen({ section, onSection, instruments }: { section: string; onSection: (s: string) => void; instruments: Instrument[] }) {
  const current: Section = section === 'aliases' ? 'aliases' : 'export';
  return (
    <div className="admin-screen" data-testid="admin-screen">
      <nav className="admin-nav" aria-label="Admin sections">
        <button type="button" className={`admin-nav-item ${current === 'export' ? 'active' : ''}`} aria-current={current === 'export' ? 'page' : undefined} onClick={() => onSection('')}>
          Data export
        </button>
        <button type="button" className={`admin-nav-item ${current === 'aliases' ? 'active' : ''}`} aria-current={current === 'aliases' ? 'page' : undefined} onClick={() => onSection('aliases')}>
          Field aliases
        </button>
      </nav>
      <div className="admin-body">{current === 'aliases' ? <FieldAliasManagerScreen onBack={() => onSection('')} /> : <DataExport instruments={instruments} />}</div>
    </div>
  );
}

function DataExport({ instruments }: { instruments: Instrument[] }) {
  const models = [...new Map(instruments.filter((i) => i.model_id).map((i) => [i.model_id as string, i.model])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const [status, setStatus] = useState<ReportStatus | ''>('finalized');
  const [modelId, setModelId] = useState('');
  const [reportType, setReportType] = useState<ReportType | ''>('');
  const [technician, setTechnician] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [count, setCount] = useState<number | null>(null);

  const filters: ReportFilters = {};
  if (status) filters.status = status;
  if (modelId) filters.model_id = modelId;
  if (reportType) filters.report_type = reportType;
  if (technician.trim()) filters.technician = technician.trim();
  if (from) filters.date_from = from;
  if (to) filters.date_to = to;
  const key = JSON.stringify(filters);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      listReports(JSON.parse(key) as ReportFilters)
        .then((items) => {
          if (!cancelled) setCount(items.length);
        })
        .catch(() => {
          if (!cancelled) setCount(null);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [key]);

  return (
    <section className="admin-card">
      <h1 className="admin-title">Export reports to CSV</h1>
      <p className="admin-lead">Download service reports as a spreadsheet file. Choose what to include.</p>
      <div className="admin-form">
        <label>
          <span>Status</span>
          <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as ReportStatus | '')}>
            <option value="">All statuses</option>
            {(Object.keys(STATUS_LABEL) as ReportStatus[]).map((s) => (
              <option key={s} value={s}>{STATUS_LABEL[s]}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Instrument model</span>
          <select aria-label="Instrument model" value={modelId} onChange={(e) => setModelId(e.target.value)}>
            <option value="">All models</option>
            {models.map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Report type</span>
          <select aria-label="Report type" value={reportType} onChange={(e) => setReportType(e.target.value as ReportType | '')}>
            <option value="">All types</option>
            {(Object.keys(REPORT_TYPE_LABEL) as ReportType[]).map((t) => (
              <option key={t} value={t}>{REPORT_TYPE_LABEL[t]}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Lab manager</span>
          <input aria-label="Lab manager" type="text" value={technician} onChange={(e) => setTechnician(e.target.value)} placeholder="Any" />
        </label>
        <div className="admin-dates">
          <label>
            <span>From</span>
            <DateInput value={from} onChange={setFrom} ariaLabel="From date" />
          </label>
          <label>
            <span>To</span>
            <DateInput value={to} onChange={setTo} ariaLabel="To date" />
          </label>
        </div>
      </div>
      <div className="admin-summary" data-testid="admin-match-count">
        <strong>{count === null ? '…' : `${count} report${count === 1 ? '' : 's'}`}</strong> match these choices
      </div>
      <a className="btn primary" href={reportsExportUrl(filters)} data-testid="admin-export-link">
        ⬇ Download CSV
      </a>
    </section>
  );
}
