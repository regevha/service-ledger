import { apiFetch } from './http';
import type { components } from '../generated/api-schema';

/** The figures on the Home screen (GET /home/summary). */
export interface HomeSummary {
  waiting: { count: number; oldest_created_at: string | null };
  finalized: { this_month: number; last_month: number };
  read_without_edits: { days: number; reports: number; fields: number; unchanged: number };
  email_drafts?: components['schemas']['HomeEmailDraftsOut'];
}

export function getHomeSummary(): Promise<HomeSummary> {
  return apiFetch('/home/summary');
}
