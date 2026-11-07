import { apiFetch } from './http';
import type { ExtractionJob } from './types';

// ---------- Hebrew translation ----------

export type TranslationStatus = 'pending_review' | 'accepted' | 'discarded' | 'superseded' | 'not_needed';

export interface Translation {
  id: string;
  attachment_id: string;
  status: TranslationStatus;
  source_language: string;
  hebrew_share: number | null;
  /** The model's English text. */
  model_text: string | null;
  /** The text a person accepted (possibly edited). */
  accepted_text: string | null;
  /** Pages left out as instrument QC printouts: [{page, reason}]. */
  ignored_pages: { page: number; reason: string }[];
  included_pages: number[];
  /** Identifiers listed for the document and the ones missing from the English. */
  identifier_check: { checked?: number; missing?: string[] };
  notes: string[];
  reader: string;
  model: string | null;
  created_at: string;
  accepted_at: string | null;
}

// Enqueues a translate job (202); poll it with pollExtractionJob. `includePages`
// asks for pages that would be skipped as QC printouts to be translated too.
export function translateAttachment(attachmentId: string, includePages: number[] = []): Promise<ExtractionJob> {
  return apiFetch(`/attachments/${attachmentId}/translate`, {
    method: 'POST',
    body: JSON.stringify({ include_pages: includePages }),
  });
}

/** The attachment's current translation; rejects with a 404 ApiError when it has none. */
export function getTranslation(attachmentId: string): Promise<Translation> {
  return apiFetch(`/attachments/${attachmentId}/translation`);
}

/** Accept the translation; send `acceptedText` to accept an edited version. */
export function acceptTranslation(translationId: string, acceptedText?: string): Promise<Translation> {
  return apiFetch(`/translations/${translationId}/accept`, {
    method: 'POST',
    body: JSON.stringify(acceptedText === undefined ? {} : { accepted_text: acceptedText }),
  });
}

/** Drop the translation and go on with the original document. */
export function discardTranslation(translationId: string): Promise<Translation> {
  return apiFetch(`/translations/${translationId}/discard`, { method: 'POST' });
}
