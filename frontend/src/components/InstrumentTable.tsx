import type { Instrument } from '../api';
import { INSTRUMENT_STATUS_LABEL } from '../labels';
import { MaintenanceBadge } from './MaintenanceBadge';
import { RowMenu } from './RowMenu';

/** The instrument rows (a card per instrument on a phone). Edit and Delete are handed in by the Instruments tab. */
export function InstrumentTable({
  instruments,
  typeNames,
  phone,
  onEdit,
  onOpenTrend,
  onDelete,
  repairCounts,
}: {
  instruments: Instrument[];
  typeNames: Record<string, string>;
  phone: boolean;
  onEdit: (instrument: Instrument) => void;
  onOpenTrend: (instrument: Instrument) => void;
  onDelete: (instrument: Instrument) => void;
  /** Finalized repairs per instrument id, shown under the name when a question about repairs is being answered. */
  repairCounts?: ReadonlyMap<string, number>;
}) {
  return (
    <div className="template-table">
      <div className="instrument-row template-row-head">
        <span>Name</span>
        <span>Manufacturer</span>
        <span>Distributor</span>
        <span>Model</span>
        <span>Serial number</span>
        <span>Room name</span>
        <span>Status</span>
        <span>Actions</span>
      </div>
      {instruments.map((inst) => (
        <div className="instrument-row instrument-card template-row-body" data-testid="instrument-row" key={inst.id}>
          <span data-label="Name">
            {inst.name}
            {inst.institution && <small className="muted instrument-institution">{inst.institution}</small>}
            {repairCounts && (
              <small className="muted instrument-repairs" data-testid="instrument-repairs">
                {repairCounts.get(inst.id) ?? 0} {(repairCounts.get(inst.id) ?? 0) === 1 ? 'repair' : 'repairs'}
              </small>
            )}
          </span>
          <span data-label="Manufacturer">{inst.manufacturer ?? '—'}</span>
          <span data-label="Distributor">{inst.distributor ?? '—'}</span>
          <span data-label="Model" data-same={inst.model === inst.name ? '' : undefined}>
            {inst.model}
            <small className="muted instrument-type"> · {typeNames[inst.instrument_type] ?? inst.instrument_type}</small>
          </span>
          <span data-label="Serial number">{inst.serial_number}</span>
          <span data-label="Room name" data-empty={inst.location ? undefined : ''}>{inst.location ?? '—'}</span>
          <span data-label="Status">
            <span className={`status-pill instrument-status-${inst.status}${inst.status === 'active' ? ' status-default' : ''}`}>
              {INSTRUMENT_STATUS_LABEL[inst.status]}
            </span>{' '}
            <MaintenanceBadge state={inst.maintenance_state} dueDate={inst.maintenance_due_date} />
          </span>
          <span className="template-row-actions">
            <button type="button" className="btn small" data-testid="instrument-trend-link" aria-label={`Trend of ${inst.name}`} onClick={() => onOpenTrend(inst)}>
              Trend
            </button>
            <button type="button" className="btn small" onClick={() => onEdit(inst)}>
              Edit
            </button>
            {phone ? (
              <RowMenu
                label={`More actions for ${inst.name}`}
                items={[{ label: 'Delete', danger: true, onSelect: () => onDelete(inst) }]}
              />
            ) : (
              <button type="button" className="btn small danger" onClick={() => onDelete(inst)}>
                Delete
              </button>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
