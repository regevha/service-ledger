import { API_BASE, apiFetch } from './http';
import type { Report, ReportListItem, ReportStatus, ReportType } from './types';

// ---------- Reports ----------

export function createReport(payload: { technician_name?: string | null }): Promise<Report> {
  return apiFetch('/reports', { method: 'POST', body: JSON.stringify(payload) });
}

export function getReport(reportId: string): Promise<Report> {
  return apiFetch(`/reports/${reportId}`);
}

// Permanent: removes the report, its scan and its extraction jobs. A finalized
// report is refused (409) unless `force` is set.
export function deleteReport(reportId: string, force = false): Promise<void> {
  return apiFetch(`/reports/${reportId}${force ? '?force=true' : ''}`, { method: 'DELETE' });
}

// Another saved report that probably records the same visit (GET /reports/{id}/duplicates):
// the same scan file, or the same work-order number on the same instrument.
export interface ReportDuplicate extends ReportListItem {
  reason: 'same_file' | 'same_work_order';
  work_order_number: string | null;
}

export function getReportDuplicates(reportId: string): Promise<ReportDuplicate[]> {
  return apiFetch(`/reports/${reportId}/duplicates`);
}

export interface ReportFilters {
  instrument_id?: string;
  /** Every unit of one model record (an InstrumentModel id). */
  model_id?: string;
  /** An institution, faculty or room, with everything inside it. */
  place_id?: string;
  report_type?: ReportType;
  status?: ReportStatus;
  date_from?: string;
  date_to?: string;
  technician?: string;
  /** Free-text search over finalized reports (two or more characters). */
  q?: string;
}

export function listReports(filters: ReportFilters = {}): Promise<ReportListItem[]> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  const qs = params.toString();
  return apiFetch(`/reports${qs ? `?${qs}` : ''}`);
}

// Not routed through apiFetch — this is a direct link href, not a fetch: the
// backend's GET /reports/export sets Content-Disposition: attachment, so a
// plain browser navigation downloads the CSV without any JS/blob plumbing.
// Same filter shape as listReports, so exporting always matches the current
// on-screen search (§7/§9 — the backend keeps both endpoints' filters in sync).
export function reportsExportUrl(filters: ReportFilters = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  const qs = params.toString();
  return `${API_BASE}/reports/export${qs ? `?${qs}` : ''}`;
}

export function confirmTemplate(reportId: string, instrumentId: string, templateId: string): Promise<Report> {
  return apiFetch(`/reports/${reportId}/template`, {
    method: 'PATCH',
    body: JSON.stringify({ instrument_id: instrumentId, template_id: templateId }),
  });
}

export function updateReportFields(
  reportId: string,
  // report_date: the service-visit date. Extraction fills it in from the
  // document; the review screen sends it back as corrected (null clears it).
  payload: { extracted_fields?: Record<string, unknown>; report_date?: string | null }
): Promise<Report> {
  return apiFetch(`/reports/${reportId}/fields`, { method: 'PATCH', body: JSON.stringify(payload) });
}

export function finalizeReport(reportId: string): Promise<Report> {
  return apiFetch(`/reports/${reportId}/finalize`, { method: 'POST' });
}

// Not routed through apiFetch — same reasoning as reportsExportUrl/
// attachmentFileUrl above: GET /reports/{id}/pdf sets Content-Disposition:
// attachment, so a plain link href downloads the PDF without any JS/blob
// plumbing here.
export function reportPdfUrl(reportId: string): string {
  return `${API_BASE}/reports/${reportId}/pdf`;
}

export interface ReportSearchPart {
  key: string;
  label: string;
}

/** A request in plain words turned into the Reports filters it names, plus what was understood from it. */
export interface ReportSearchResult {
  filters: ReportFilters;
  understood: ReportSearchPart[];
  /** "rules" (built-in rules), "ai" (a small model filled what the rules could not), "rules_fallback" (the model was wanted but unavailable). */
  source: 'rules' | 'ai' | 'rules_fallback';
  /** Parts of the question that no filter can express yet, for example "overdue". */
  notes: string[];
}

export function parseReportSearch(text: string): Promise<ReportSearchResult> {
  return apiFetch('/reports/parse-search', { method: 'POST', body: JSON.stringify({ text }) });
}
