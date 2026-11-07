import type { Instrument, Place, ReportFilters, ReportStatus } from '../../api';
import { REPORT_TYPE_LABEL, STATUS_LABEL } from '../../labels';
import { placeLabel } from '../../placeUtils';

/** A model as this bar knows it: one per model record that has instruments in the list it is given. */
export type ModelOption = { id: string; name: string; manufacturer: string | null };

export function modelsOf(instruments: Instrument[]): ModelOption[] {
  const byId = new Map<string, ModelOption>();
  for (const i of instruments) {
    if (i.model_id && !byId.has(i.model_id)) byId.set(i.model_id, { id: i.model_id, name: i.model, manufacturer: i.manufacturer });
  }
  return [...byId.values()];
}

/** The filters this bar edits: the Reports list's, with a status that may also be 'all' (Analytics). */
export type BarFilters = Omit<ReportFilters, 'status'> & { status?: string };

/** The one-line summary of the chosen filters shown when the bar is folded away. */
export function summarizeFilters({
  filters,
  instrument,
  model,
  place,
  summaryExtra,
}: {
  filters: BarFilters;
  instrument: Instrument | undefined;
  model: ModelOption | undefined;
  place: Place | undefined;
  summaryExtra: string[];
}): string[] {
  const statusText = filters.status === 'all' ? 'All statuses' : filters.status ? STATUS_LABEL[filters.status as ReportStatus] : '';
  const dates =
    filters.date_from && filters.date_to
      ? `${filters.date_from} to ${filters.date_to}`
      : filters.date_from
        ? `from ${filters.date_from}`
        : filters.date_to
          ? `until ${filters.date_to}`
          : '';
  const summary = [
    filters.q ? `“${filters.q}”` : '',
    ...summaryExtra,
    place ? placeLabel(place) : '',
    model ? model.name : '',
    instrument ? `${instrument.model} (${instrument.serial_number})` : '',
    filters.report_type ? REPORT_TYPE_LABEL[filters.report_type] : '',
    statusText,
    dates,
    filters.technician ? `Lab manager: ${filters.technician}` : '',
  ].filter(Boolean);
  return summary;
}
