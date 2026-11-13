import { API_BASE, apiFetch, apiFetchWithHeaders } from './http';
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
  /** A condition on a number in the report (finalized only): the field, gt/gte/lt/lte/eq, and the number. All three or none. */
  number_field?: string;
  number_op?: string;
  number_value?: string;
  /** Set only on the answer to a question about instruments; never sent to the Reports list. */
  repairs_op?: string;
  repairs_count?: string;
}

function reportsQuery(filters: ReportFilters, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/** Every matching report. For screens that need them all; the Reports list pages instead (listReportsPage). */
export function listReports(filters: ReportFilters = {}): Promise<ReportListItem[]> {
  return apiFetch(`/reports${reportsQuery(filters)}`);
}

export interface ReportsPage {
  items: ReportListItem[];
  /** How many reports match in all, not how many are in this page. */
  total: number;
}

/** One page of the matching reports, with the total that match. */
export async function listReportsPage(filters: ReportFilters, limit: number, offset: number): Promise<ReportsPage> {
  const { data, headers } = await apiFetchWithHeaders<ReportListItem[]>(
    `/reports${reportsQuery(filters, { limit: String(limit), offset: String(offset) })}`
  );
  const total = Number(headers.get('X-Total-Count'));
  return { items: data, total: Number.isFinite(total) && headers.has('X-Total-Count') ? total : data.length };
}

/** One report as a list row, without loading the list. */
export function getReportItem(reportId: string): Promise<ReportListItem> {
  return apiFetch(`/reports/${reportId}/item`);
}

/** How many reports match, without loading them. */
export async function countReports(filters: ReportFilters = {}): Promise<number> {
  return (await listReportsPage(filters, 1, 0)).total;
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
  /** "instruments" for a question about instruments ("more than 2 repairs this year"); the filters then hold repairs_op and repairs_count. */
  target?: 'reports' | 'instruments';
}

export function parseReportSearch(text: string): Promise<ReportSearchResult> {
  return apiFetch('/reports/parse-search', { method: 'POST', body: JSON.stringify({ text }) });
}
