import { useEffect, useState } from 'react';
import { ApiError, getInstrumentModel, type InstrumentModelDetail, type MaintenanceState } from '../api';
import { MaintenanceBadge } from './MaintenanceBadge';
import { ModelReliabilitySection } from './ModelReliabilitySection';
import { INSTRUMENT_STATUS_LABEL, REPORT_TYPE_LABEL, STATUS_LABEL } from '../labels';
import { formatDate } from './InstrumentTrendChart';

/**
 * One model's page: what the record says, its instruments side by side (so the
 * odd one out is easy to see) and its newest reports.
 */
export function ModelPage({
  modelId,
  typeName,
  onBack,
  onEdit,
}: {
  modelId: string;
  typeName: (key: string) => string;
  onBack: () => void;
  onEdit: () => void;
}) {
  const [detail, setDetail] = useState<InstrumentModelDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getInstrumentModel(modelId)
      .then((d) => live && setDetail(d))
      .catch((e: unknown) => live && setError(e instanceof ApiError ? e.message : 'Could not load this model.'));
    return () => {
      live = false;
    };
  }, [modelId]);

  if (error) {
    return (
      <div className="section">
        <button type="button" className="btn small back-link" onClick={onBack}>
          ← Back to models
        </button>
        <div className="banner banner-warn">{error}</div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="section">
        <div className="working-panel">
          <div className="spinner" />
          <div>Loading model…</div>
        </div>
      </div>
    );
  }

  // The unit with the most repairs, when it clearly stands out.
  const mostRepairs = Math.max(0, ...detail.units.map((u) => u.repair_count));
  const standout = detail.units.length > 1 && mostRepairs >= 2 && detail.units.filter((u) => u.repair_count === mostRepairs).length === 1 ? mostRepairs : null;

  return (
    <div className="section" id="model-page">
      <button type="button" className="btn small back-link" onClick={onBack}>
        ← Back to models
      </button>
      <div className="section-title-row">
        <h2 className="section-title report-heading">{detail.name}</h2>
        <button type="button" className="btn small" onClick={onEdit}>
          Edit
        </button>
      </div>
      <p className="hint-text model-facts" id="model-facts">
        {[
          detail.manufacturer ?? 'No manufacturer recorded',
          typeName(detail.instrument_type),
          `${detail.unit_count} instrument${detail.unit_count === 1 ? '' : 's'}`,
          detail.service_interval_months ? `service every ${detail.service_interval_months} months` : 'no service interval set',
        ].join(' · ')}
      </p>
      {detail.notes && <p className="model-notes-text">{detail.notes}</p>}

      <div className="section-title">Instruments</div>
      {detail.units.length === 0 ? (
        <div className="empty-hint">No instruments of this model.</div>
      ) : (
        <div className="template-table">
          <div className="instrument-row model-unit-row template-row-head">
            <span>Instrument</span>
            <span>Place</span>
            <span>Status</span>
            <span>Last service</span>
            <span>Maintenance</span>
            <span>Reports</span>
            <span>Repairs</span>
          </div>
          {detail.units.map((u) => (
            <div className="instrument-row model-unit-row template-row-body" key={u.id}>
              <span data-label="Instrument">
                <a className="model-unit-link" href={`#/reports/instrument/${u.id}`}>
                  {u.name}
                </a>
                <small className="muted"> {u.serial_number}</small>
              </span>
              <span data-label="Place">{[u.location, u.institution].filter(Boolean).join(' · ') || '—'}</span>
              <span data-label="Status">
                <span className={`status-pill instrument-status-${u.status}`}>{INSTRUMENT_STATUS_LABEL[u.status]}</span>
              </span>
              <span data-label="Last service">{u.last_service_date ? formatDate(u.last_service_date) : 'None yet'}</span>
              <span data-label="Maintenance">
                <MaintenanceBadge state={u.maintenance_state as MaintenanceState | null | undefined} dueDate={u.maintenance_due_date} />
              </span>
              <span data-label="Reports">
                {u.report_count}
                {u.draft_count > 0 && <small className="muted"> +{u.draft_count} in progress</small>}
              </span>
              <span data-label="Repairs">
                {u.repair_count}
                {standout !== null && u.repair_count === standout && <small className="model-standout"> most repairs</small>}
              </span>
            </div>
          ))}
        </div>
      )}

      <ModelReliabilitySection modelId={modelId} />

      <div className="section-title">Reports</div>
      {detail.reports.length === 0 ? (
        <div className="empty-hint">No reports for this model yet.</div>
      ) : (
        <>
          <div className="template-table">
            <div className="instrument-row model-report-row template-row-head">
              <span>Date</span>
              <span>Instrument</span>
              <span>Type</span>
              <span>Technician</span>
              <span>Status</span>
            </div>
            {detail.reports.map((r) => (
              <div className="instrument-row model-report-row template-row-body" key={r.id}>
                <span data-label="Date">
                  <a className="model-report-link" href={`#/reports/${r.id}`}>
                    {formatDate(r.report_date ?? r.created_at.slice(0, 10))}
                  </a>
                </span>
                <span data-label="Instrument">{r.instrument_serial_number ?? '—'}</span>
                <span data-label="Type">{r.report_type ? REPORT_TYPE_LABEL[r.report_type] : '—'}</span>
                <span data-label="Technician">{r.technician_name ?? '—'}</span>
                <span data-label="Status">{STATUS_LABEL[r.status]}</span>
              </div>
            ))}
          </div>
          {detail.report_total > detail.reports.length && (
            <p className="hint-text">
              Showing the newest {detail.reports.length} of {detail.report_total} reports. Search the Reports tab for the rest.
            </p>
          )}
        </>
      )}
    </div>
  );
}
