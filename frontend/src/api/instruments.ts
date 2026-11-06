import { apiFetch } from './http';
import type { FieldType, Instrument, InstrumentCreatePayload, InstrumentType, InstrumentUpdatePayload } from './types';

// ---------- Instruments ----------

export function listInstruments(): Promise<Instrument[]> {
  return apiFetch('/instruments');
}

export function listInstrumentTypes(): Promise<InstrumentType[]> {
  return apiFetch('/instrument-types');
}

export function createInstrumentType(displayName: string): Promise<InstrumentType> {
  return apiFetch('/instrument-types', { method: 'POST', body: JSON.stringify({ display_name: displayName }) });
}

export function createInstrument(payload: InstrumentCreatePayload): Promise<Instrument> {
  return apiFetch('/instruments', { method: 'POST', body: JSON.stringify(payload) });
}

export function updateInstrument(instrumentId: string, payload: InstrumentUpdatePayload): Promise<Instrument> {
  return apiFetch(`/instruments/${instrumentId}`, { method: 'PATCH', body: JSON.stringify(payload) });
}

// ---------- Instrument trend ----------
//
// Backs the instrument detail page's trend chart. Mirrors
// backend/app/schemas.py's TrendFieldOut/TrendPointOut/TrendOut — `type`
// tells the caller which shape `value` has for a given field: a plain
// number for "number", a {detector/laser key: value} map for the other two
// FieldType members GET .../trend-fields ever returns.
export interface TrendField {
  name: string;
  type: FieldType;
  unit: string | null;
}

export interface TrendPoint {
  report_id: string;
  report_date: string | null;
  value: number | Record<string, number>;
}

export interface InstrumentTrend {
  instrument_id: string;
  field: string;
  points: TrendPoint[];
}

// Refused (409) while the instrument still has reports.
export function deleteInstrument(instrumentId: string): Promise<void> {
  return apiFetch(`/instruments/${instrumentId}`, { method: 'DELETE' });
}

export function getInstrumentTrendFields(instrumentId: string): Promise<TrendField[]> {
  return apiFetch(`/instruments/${instrumentId}/trend-fields`);
}

export function getInstrumentTrend(instrumentId: string, field: string): Promise<InstrumentTrend> {
  return apiFetch(`/instruments/${instrumentId}/trend?${new URLSearchParams({ field })}`);
}
