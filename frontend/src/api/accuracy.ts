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

export interface ReadAccuracyConfidence {
  band: 'below_0.70' | '0.70_to_0.85' | '0.85_and_up' | string;
  fields: number;
  unchanged: number;
}

export interface ReadAccuracyKind {
  /** "structured": compared exactly. "free_text": the narrative fields, compared ignoring case, spacing and punctuation. */
  kind: 'structured' | 'free_text' | string;
  fields: number;
  unchanged: number;
}

export interface ReadAccuracyPrompt {
  /** The form the prompt was used for: its hash covers that form's field list, so rows are per form. */
  form: string;
  prompt_hash: string;
  model: string;
  fields: number;
  unchanged: number;
  reports: number;
}

export interface ReadCorrection {
  report_id: string;
  finalized_at: string | null;
  instrument: string | null;
  form: string;
  field: string;
  read: string;
  kept: string;
  /** The same values at much greater length, and for text the phrases that changed (before, after). */
  read_full: string;
  kept_full: string;
  changes: { before: string; after: string }[];
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
  by_confidence: ReadAccuracyConfidence[];
  by_prompt: ReadAccuracyPrompt[];
  by_kind: ReadAccuracyKind[];
  /** Reports whose first reading is a later re-read of the document (not the reading made when it was uploaded). */
  from_reread: number;
  filled_by_hand: { empty: number; filled: number };
  corrections: ReadCorrection[];
  translations: { accepted: number; unchanged: number; edits: TranslationEdit[] };
}

/** `days` null: every finalized report. */
export function getReadAccuracy(days: number | null): Promise<ReadAccuracy> {
  return apiFetch(`/analytics/read-accuracy?days=${days ?? 0}`);
}
