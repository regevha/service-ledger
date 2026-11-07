import type { components } from '../generated/api-schema';
import { apiFetch } from './http';

// ---------- Instrument models ----------
//
// A model ("FACSAria III") as a record of its own. The record is the source:
// renaming it, or changing its manufacturer, updates its instruments' copies
// (and a rename updates the templates written for the name).

export type InstrumentModel = components['schemas']['InstrumentModelOut'];

export interface InstrumentModelPayload {
  name?: string;
  manufacturer?: string | null;
  instrument_type?: string;
  service_interval_months?: number | null;
  notes?: string | null;
}

export function listInstrumentModels(): Promise<InstrumentModel[]> {
  return apiFetch('/instrument-models');
}

export function createInstrumentModel(payload: InstrumentModelPayload & { name: string }): Promise<InstrumentModel> {
  return apiFetch('/instrument-models', { method: 'POST', body: JSON.stringify(payload) });
}

export function updateInstrumentModel(id: string, payload: InstrumentModelPayload): Promise<InstrumentModel> {
  return apiFetch(`/instrument-models/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
}

export function deleteInstrumentModel(id: string): Promise<void> {
  return apiFetch(`/instrument-models/${id}`, { method: 'DELETE' });
}

export function mergeInstrumentModel(
  id: string,
  intoId: string
): Promise<{ moved_instruments: number; moved_templates: number; into: string }> {
  return apiFetch(`/instrument-models/${id}/merge`, { method: 'POST', body: JSON.stringify({ into_id: intoId }) });
}

export type Place = components['schemas']['PlaceOut'];
export type PlaceKind = Place['kind'];

export function listPlaces(): Promise<Place[]> {
  return apiFetch('/places');
}

export function createPlace(payload: { kind: PlaceKind; name: string; parent_id?: string | null }): Promise<Place> {
  return apiFetch('/places', { method: 'POST', body: JSON.stringify(payload) });
}

export function updatePlace(id: string, payload: { name?: string; parent_id?: string | null }): Promise<Place> {
  return apiFetch(`/places/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
}

export function deletePlace(id: string): Promise<void> {
  return apiFetch(`/places/${id}`, { method: 'DELETE' });
}

export function mergePlace(id: string, intoId: string): Promise<{ moved_instruments: number; moved_places: number; into: string }> {
  return apiFetch(`/places/${id}/merge`, { method: 'POST', body: JSON.stringify({ into_id: intoId }) });
}

export type InstrumentModelDetail = components['schemas']['InstrumentModelDetailOut'];
export type InstrumentModelUnit = components['schemas']['InstrumentModelUnitOut'];

export type ModelReliability = components['schemas']['ModelReliabilityOut'];

export function getModelReliability(id: string): Promise<ModelReliability> {
  return apiFetch(`/instrument-models/${id}/reliability`);
}

export function getInstrumentModel(id: string): Promise<InstrumentModelDetail> {
  return apiFetch(`/instrument-models/${id}`);
}
