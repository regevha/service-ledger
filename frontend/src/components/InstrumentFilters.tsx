import type { MaintenanceState, Place } from '../api';
import { MAINTENANCE_STATE_LABEL } from '../labels';
import { placeLabel } from '../placeUtils';

/** The Place, Model and Maintenance pickers above the instrument list (state lives in useInstrumentFilters). */
export function InstrumentFilters({
  showPlace,
  placeOptions,
  activePlace,
  onPlaceChange,
  modelOptions,
  activeModel,
  onModelChange,
  stateFilter,
  onStateChange,
}: {
  showPlace: boolean;
  placeOptions: Place[];
  activePlace: string;
  onPlaceChange: (id: string) => void;
  modelOptions: [string, string][];
  activeModel: string;
  onModelChange: (id: string) => void;
  stateFilter: 'all' | MaintenanceState;
  onStateChange: (state: 'all' | MaintenanceState) => void;
}) {
  return (
    <>
      {showPlace && (
        <label className="maintenance-filter">
          <span>Place</span>
          <select className="text-input" aria-label="Filter by place" value={activePlace} onChange={(e) => onPlaceChange(e.target.value)}>
            <option value="">All places</option>
            {placeOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {placeLabel(p)}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="instrument-filters">
        <label className="maintenance-filter">
          <span>Model</span>
          <select className="text-input" aria-label="Filter by model" value={activeModel} onChange={(e) => onModelChange(e.target.value)}>
            <option value="all">All models</option>
            {modelOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="maintenance-filter">
          <span>Maintenance</span>
          <select className="text-input" aria-label="Filter by maintenance" value={stateFilter} onChange={(e) => onStateChange(e.target.value as 'all' | MaintenanceState)}>
            <option value="all">All</option>
            {(['overdue', 'due_soon', 'ok', 'no_record', 'not_tracked'] as MaintenanceState[]).map((k) => (
              <option key={k} value={k}>
                {MAINTENANCE_STATE_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
      </div>
    </>
  );
}
