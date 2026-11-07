import type { Dispatch, SetStateAction } from 'react';
import type { Instrument, Place, ReportStatus, ReportType } from '../../api';
import { REPORT_TYPE_LABEL, STATUS_LABEL } from '../../labels';
import { idsInside, placeLabel } from '../../placeUtils';
import { DateInput } from '../DateInput';
import type { BarFilters, ModelOption } from './filterSummary';

/** The filter bar's own controls, one per filter. Moved out of ReportFilterBar unchanged. */

export function SearchBox({ value: searchInput, onChange: setSearchInput }: { value: string; onChange: (value: string) => void }) {
  return (
    <span className="search-box">
      <input
        type="search"
        aria-label="Search reports"
        placeholder="Search report text…"
        value={searchInput}
        onChange={(e) => setSearchInput(e.target.value)}
        title='Finds finalized reports containing all the words. Use "quotes" for an exact phrase and a minus sign to leave a word out. Numbers are not searched.'
      />
      {searchInput && (
        <button type="button" className="btn small" aria-label="Clear search" onClick={() => setSearchInput('')}>
          ×
        </button>
      )}
    </span>
  );
}

export function PlaceSelect<F extends BarFilters>({
  filters, setFilters, instruments, places,
}: { filters: F; setFilters: Dispatch<SetStateAction<F>>; instruments: Instrument[]; places: Place[] }) {
  return (
    <select
      aria-label="Place"
      value={filters.place_id ?? ''}
      onChange={(e) =>
        setFilters((f) => {
          const kept = instruments.find((i) => i.id === f.instrument_id);
          const next = e.target.value || undefined;
          const inside = idsInside(places, next);
          // An instrument outside the newly chosen place cannot stay chosen.
          const clash = next && kept && !(kept.place_id != null && inside?.has(kept.place_id));
          return { ...f, place_id: next, instrument_id: clash ? undefined : f.instrument_id };
        })
      }
    >
      <option value="">All places</option>
      {places.map((p) => (
        <option key={p.id} value={p.id}>
          {placeLabel(p)}
        </option>
      ))}
    </select>
  );
}

export function ModelSelect<F extends BarFilters>({
  filters, setFilters, instruments, models, chosenModel: model,
}: {
  filters: F;
  setFilters: Dispatch<SetStateAction<F>>;
  instruments: Instrument[];
  models: ModelOption[];
  chosenModel: ModelOption | undefined;
}) {
  return (
    <select
      aria-label="Model"
      value={filters.model_id ?? ''}
      onChange={(e) => {
        const model_id = e.target.value || undefined;
        // Drop a chosen instrument that is not of this model, so the two never contradict.
        setFilters((f) => {
          const kept = instruments.find((i) => i.id === f.instrument_id);
          const clash = model_id && kept && kept.model_id !== model_id;
          return { ...f, model_id, instrument_id: clash ? undefined : f.instrument_id };
        });
      }}
    >
      <option value="">All models</option>
      {filters.model_id && !model && <option value={filters.model_id}>(model no longer in use)</option>}
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
        </option>
      ))}
    </select>
  );
}

export function InstrumentSelect<F extends BarFilters>({
  filters, setFilters, instruments,
}: { filters: F; setFilters: Dispatch<SetStateAction<F>>; instruments: Instrument[] }) {
  return (
    <select
      aria-label="Instrument"
      value={filters.instrument_id ?? ''}
      onChange={(e) => setFilters((f) => ({ ...f, instrument_id: e.target.value || undefined }))}
    >
      <option value="">All instruments</option>
      {instruments.map((inst) => (
        <option key={inst.id} value={inst.id}>
          {inst.model} ({inst.serial_number})
        </option>
      ))}
    </select>
  );
}

export function ReportTypeSelect<F extends BarFilters>({ filters, setFilters }: { filters: F; setFilters: Dispatch<SetStateAction<F>> }) {
  return (
    <select
      aria-label="Report type"
      value={filters.report_type ?? ''}
      onChange={(e) =>
        setFilters((f) => ({ ...f, report_type: (e.target.value || undefined) as ReportType | undefined }))
      }
    >
      <option value="">All report types</option>
      {(Object.keys(REPORT_TYPE_LABEL) as ReportType[]).map((rt) => (
        <option key={rt} value={rt}>
          {REPORT_TYPE_LABEL[rt]}
        </option>
      ))}
    </select>
  );
}

export function StatusSelect<F extends BarFilters>({
  filters, setFilters, analytics, statuses,
}: { filters: F; setFilters: Dispatch<SetStateAction<F>>; analytics: boolean; statuses: ReportStatus[] }) {
  return (
    <select
      aria-label="Status"
      value={filters.status ?? ''}
      onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value || undefined }))}
    >
      {analytics ? (
        <>
          <option value="">Finalized</option>
          <option value="all">All statuses</option>
        </>
      ) : (
        <option value="">All statuses</option>
      )}
      {statuses.map((s) => (
        <option key={s} value={s}>
          {STATUS_LABEL[s]}
        </option>
      ))}
    </select>
  );
}

export function DateRangeInputs<F extends BarFilters>({ filters, setFilters }: { filters: F; setFilters: Dispatch<SetStateAction<F>> }) {
  return (
    <>
      <span className="date-pair-label" aria-hidden="true">
        From
      </span>
      <DateInput
        ariaLabel="From date"
        value={filters.date_from ?? ''}
        onChange={(v) => setFilters((f) => ({ ...f, date_from: v || undefined }))}
      />
      <span className="filter-sep">to</span>
      <span className="date-pair-label" aria-hidden="true">
        To
      </span>
      <DateInput
        ariaLabel="To date"
        value={filters.date_to ?? ''}
        onChange={(v) => setFilters((f) => ({ ...f, date_to: v || undefined }))}
      />
    </>
  );
}

export function ClearFiltersButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="btn small" onClick={onClick}>
      Clear filters
    </button>
  );
}
