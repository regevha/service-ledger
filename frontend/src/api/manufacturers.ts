import { apiFetch } from './http';

// ---------- Makers (manufacturers) ----------

/** A maker as a record: one per maker however it was typed; `aliases` are other spellings that mean it. */
export interface Manufacturer {
  id: string;
  name: string;
  aliases: string[];
  instrument_count: number;
  model_count: number;
}

export function listManufacturers(): Promise<Manufacturer[]> {
  return apiFetch('/manufacturers');
}

export function createManufacturer(payload: { name: string; aliases: string[] }): Promise<Manufacturer> {
  return apiFetch('/manufacturers', { method: 'POST', body: JSON.stringify(payload) });
}

export function updateManufacturer(id: string, payload: { name?: string; aliases?: string[] }): Promise<Manufacturer> {
  return apiFetch(`/manufacturers/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
}

export function deleteManufacturer(id: string): Promise<void> {
  return apiFetch(`/manufacturers/${id}`, { method: 'DELETE' });
}
