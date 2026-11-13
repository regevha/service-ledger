import { apiFetch } from './http';

// ---------- Reading accuracy (GET /analytics/read-accuracy) ----------
//
// How much of the reading people approved without an edit. A field counts when the reading filled it in; it is
// "kept" when the approved value equals the first reading. Goal: 99% of fields.

interface Counts {
  fields: number;
  unchanged: number;
  reports: number;
  untouched: number;
}

export interface ReadAccuracyWeek extends Counts {
  week_start: string;
}

export interface ReadAccuracyForm extends Counts {
  template_id: string | null;
  form: string;
}

export interface ReadAccuracySource extends Counts {
  source: 'translated' | 'original' | string;
}

export interface ReadCorrection {
  report_id: string;
  finalized_at: string | null;
  instrument: string | null;
  form: string;
  field: string;
  read: string;
  kept: string;
  translated: boolean;
}

export interface TranslationEdit {
  report_id: string;
  finalized_at: string | null;
  instrument: string | null;
  changes: { before: string; after: string }[];
}

export interface ReadAccuracy {
  days: number | null;
  goal: number;
  fields: number;
  unchanged: number;
  reports: number;
  reports_untouched: number;
  weeks: ReadAccuracyWeek[];
  by_field: { field: string; fields: number; unchanged: number }[];
  by_form: ReadAccuracyForm[];
  by_source: ReadAccuracySource[];
  corrections: ReadCorrection[];
  translations: { accepted: number; unchanged: number; edits: TranslationEdit[] };
}

/** `days` null: every finalized report. */
export function getReadAccuracy(days: number | null): Promise<ReadAccuracy> {
  return apiFetch(`/analytics/read-accuracy?days=${days ?? 0}`);
}

// ---------- Technical glossary (/glossary-terms) ----------
//
// How a term on a Hebrew form should come out in English. The translation is given the list, and a known wrong
// wording still left in a translation is replaced with the right one (the reviewer sees a note saying so).

export interface GlossaryTerm {
  id: string;
  source_term: string | null;
  wrong_term: string | null;
  english_term: string;
  note: string | null;
  created_at: string;
}

export interface GlossaryTermPayload {
  source_term: string | null;
  wrong_term: string | null;
  english_term: string;
  note: string | null;
}

export function listGlossaryTerms(): Promise<GlossaryTerm[]> {
  return apiFetch('/glossary-terms');
}

export function createGlossaryTerm(payload: GlossaryTermPayload): Promise<GlossaryTerm> {
  return apiFetch('/glossary-terms', { method: 'POST', body: JSON.stringify(payload) });
}

export function updateGlossaryTerm(id: string, payload: Partial<GlossaryTermPayload>): Promise<GlossaryTerm> {
  return apiFetch(`/glossary-terms/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
}

export function deleteGlossaryTerm(id: string): Promise<void> {
  return apiFetch(`/glossary-terms/${id}`, { method: 'DELETE' });
}
