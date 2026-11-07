import { apiFetch } from './http';

// ---------- Field aliases ----------
//
// Sets of field names that mean the same thing under different wording
// ("root_cause", "cause"), kept by hand and shared by everyone.
// The template comparison reads them to show a "possible match"; nothing is
// renamed or merged because of them.
export interface FieldAliasGroup {
  id: string;
  label: string | null;
  names: string[];
  created_at: string;
}

export interface FieldAliasGroupPayload {
  label: string | null;
  names: string[];
}

export function listFieldAliases(): Promise<FieldAliasGroup[]> {
  return apiFetch('/field-aliases');
}

export function createFieldAliasGroup(payload: FieldAliasGroupPayload): Promise<FieldAliasGroup> {
  return apiFetch('/field-aliases', { method: 'POST', body: JSON.stringify(payload) });
}

export function replaceFieldAliasGroup(id: string, payload: FieldAliasGroupPayload): Promise<FieldAliasGroup> {
  return apiFetch(`/field-aliases/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
}

export function deleteFieldAliasGroup(id: string): Promise<void> {
  return apiFetch(`/field-aliases/${id}`, { method: 'DELETE' });
}
