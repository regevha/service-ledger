/**
 * Typed client for the ServiceLedger backend (see SL-TDD-001 §6 for the
 * full endpoint table). Shapes here mirror backend/app/schemas.py field for
 * field rather than approximating them, so a backend schema change is a
 * compile error here, not a silent runtime mismatch.
 */

import type { components } from './generated/api-schema';

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/+$/, '') || 'http://localhost:8000';

// ---------- Shapes (mirrors app/schemas.py) ----------

// InstrumentStatus/ReportType/ReportStatus/ExtractionJobStatus/
// ExtractionJobKind below are real Python Enum classes on the backend
// (app/models.py) — these five used to be hand-typed string-literal unions
// here, a second copy of the backend's enums kept in sync by discipline
// alone (and ExtractionJobKind wasn't mirrored at all). SL-ARCH-001 §3
// specifically cites OpenAPI codegen ("typed request/response shapes for
// free") as the reason this project is split into a separate frontend/
// backend in the first place, so deriving them from the backend's own
// generated schema — instead of retyping them — is that promise actually
// wired up. `src/generated/api-schema.ts` is produced by `npm run codegen`
// (see README's "Regenerating API types from the backend") from
// backend/scripts/export_openapi.py's output; regenerate it after any
// change to a backend enum or response shape.
//
// The other interfaces below (Instrument, Report, ReportTemplate, ...) stay
// hand-written — they're stable, small, and more readable authored directly
// than as a deep `components['schemas'][...]` lookup; only the enums, which
// are exactly where uncaught backend/frontend drift is easy and silent, are
// sourced from the generated schema.
export type InstrumentStatus = components['schemas']['InstrumentStatus'];

export interface Instrument {
  id: string;
  name: string;
  instrument_type: string;
  model: string;
  serial_number: string;
  location: string | null;
  status: InstrumentStatus;
}

// instrument_type is deliberately left out here too — schemas.py's
// InstrumentCreate/InstrumentUpdate don't expose it either (see
// InstrumentManager.tsx's comment: nothing in the UI picks a value other
// than the fixed "facs" default yet).
export interface InstrumentCreatePayload {
  name: string;
  model: string;
  serial_number: string;
  location?: string | null;
}

export interface InstrumentUpdatePayload {
  name?: string;
  model?: string;
  serial_number?: string;
  location?: string | null;
  status?: InstrumentStatus;
}

export type ReportType = components['schemas']['ReportType'];

// Used to be hand-typed here — the last gap this README section (see
// "Regenerating API types from the backend") called out — until template
// management (backend/app/schemas.py's TemplateFieldType) gave it a real
// backend enum to derive from, same as the five above.
export type FieldType = components['schemas']['TemplateFieldType'];

// A list of {name, type} columns, not a {name: type} dict — Postgres's
// JSONB storage doesn't preserve an object's key order (it reorders by key
// length then lexicographically on the binary encoding), only a JSON
// array's element order, so a template author's chosen column order (e.g.
// "part_name, part_number, qty") would otherwise come back scrambled on
// every read. See backend/app/schemas.py's ItemSchemaColumn docstring.
export interface ItemSchemaColumn {
  name: string;
  type: FieldType;
}

export interface TemplateField {
  name: string;
  type: FieldType;
  unit: string | null;
  notes: string | null;
  options?: string[];
  item_schema?: ItemSchemaColumn[];
}

export interface ReportTemplate {
  id: string;
  instrument_type: string;
  report_type: ReportType;
  model: string | null;
  field_schema: { fields: TemplateField[] };
}

export type ReportStatus = components['schemas']['ReportStatus'];

export interface Report {
  id: string;
  instrument_id: string | null;
  template_id: string | null;
  status: ReportStatus;
  extracted_fields: Record<string, unknown>;
  technician_name: string | null;
  service_actions: string | null;
  parts_replaced: string | null;
  next_service_due: string | null;
  report_date: string | null;
  created_at: string;
  finalized_at: string | null;
  attachments: Attachment[];
}

// Denormalized shape GET /reports (filtered search) returns — distinct from
// Report/ReportOut, which stays the raw single-report detail shape the
// review flow round-trips against.
export interface ReportListItem {
  id: string;
  status: ReportStatus;
  instrument_model: string | null;
  instrument_serial_number: string | null;
  report_type: ReportType | null;
  technician_name: string | null;
  report_date: string | null;
  created_at: string;
  finalized_at: string | null;
}

export interface Attachment {
  id: string;
  report_id: string;
  file_path: string;
  file_type: string;
  page_count: number;
  // Only on the upload response: other reports already holding a file with
  // these exact bytes (a warning, never a rejection).
  duplicate_report_ids?: string[];
}

export interface ClassificationGuess {
  value: string;
  confidence: number;
}

// What matching the serial number printed on the document against the fleet
// found (backend/app/services/classification.py): "matched" = exactly one
// instrument has it; "not_found" = a serial was read but no instrument has
// it; "model_conflict" = it belongs to an instrument of a different model
// than the one read from the document; "not_read" = no serial on the document.
export type SerialMatch = 'matched' | 'not_found' | 'model_conflict' | 'not_read';

export interface ClassificationResult {
  instrument: ClassificationGuess;
  report_type: ClassificationGuess;
  // Optional: results stored before serial matching existed don't have these.
  instrument_serial?: ClassificationGuess | null;
  serial_match?: SerialMatch;
  suggested_instrument_id?: string | null;
  resolved_template_id: string | null;
  resolved_instrument_id: string | null;
  // Optional: results stored before these existed don't have them.
  // "task_code" = the report type came from the printed Work Order Task Code
  // by a lookup in code; "model" = Claude's own judgment of the document.
  report_type_source?: 'task_code' | 'model' | 'none';
  // Who read the document: Claude, the PDF's own text parsed in code (no API
  // key needed), or the demo stand-in for a file with no text.
  reader?: 'model' | 'text_layer' | 'stub';
  work_order_number?: string | null;
  // Other reports already holding this document: same file bytes or same
  // work-order number.
  duplicate_report_ids?: string[];
}

export type ExtractionJobStatus = components['schemas']['ExtractionJobStatus'];

export type ExtractionJobKind = components['schemas']['ExtractionJobKind'];

export interface ExtractionJob {
  id: string;
  attachment_id: string;
  kind: ExtractionJobKind;
  status: ExtractionJobStatus;
  classification: Record<string, unknown> | null;
  field_confidences: Record<string, number> | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
}

// GET /config (§4/§12): the confidence thresholds, read from the backend's
// own settings instead of a hardcoded frontend copy of them — see
// backend/app/schemas.py's AppConfigOut for why this exists.
export interface AppConfig {
  field_confidence_threshold: number;
  classification_confidence_threshold: number;
  // false without an API key: extracted values are placeholders.
  live_claude?: boolean;
}

// GET /analytics/fleet — mirrors backend/app/schemas.py's FleetAnalyticsOut
// field for field; see services/analytics.py for how each number is derived.
export interface PartUsage {
  part_name: string;
  part_number: string | null;
  times_replaced: number;
  total_qty: number;
}

export interface InstrumentRollup {
  instrument_id: string;
  name: string;
  model: string;
  serial_number: string;
  report_count: number;
  total_labor_hours: number;
}

export interface PassFailBreakdown {
  pass_count: number;
  fail_count: number;
  other_count: number;
  total: number;
}

export interface FleetAnalytics {
  parts_replaced: PartUsage[];
  total_labor_hours: number;
  labor_hours_by_instrument: InstrumentRollup[];
  labor_hours_by_fault_category: Record<string, number>;
  pass_fail_by_report_type: Record<string, PassFailBreakdown>;
}

// ---------- Fetch plumbing ----------

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: init?.body instanceof FormData ? init.headers : { 'Content-Type': 'application/json', ...init?.headers },
    });
  } catch {
    // The backend hardening work (classification.py/extraction.py) added
    // ClassificationError/ExtractionError for the API's own failures — this
    // catches the layer below that: the request never reached the backend
    // at all (server not running, wrong VITE_API_BASE_URL, CORS/network).
    throw new ApiError(0, `Could not reach the backend at ${API_BASE}. Is it running (uvicorn app.main:app), and is VITE_API_BASE_URL correct?`);
  }

  if (!response.ok) {
    // statusText is empty over HTTP/2, so it can't be the only fallback.
    let detail = response.statusText || `Request failed (${response.status})`;
    try {
      const body = await response.json();
      if (typeof body?.detail === 'string') {
        detail = body.detail;
      } else if (Array.isArray(body?.detail) && body.detail.length > 0) {
        // FastAPI's request-validation 422s send `detail` as a list of
        // {loc, msg, ...} entries, not a string — e.g. the template editor
        // saving an enum field with no options, or two fields with the same
        // name. Ignoring the list left the user with a bare "Unprocessable
        // Content" instead of the reason. Pydantic prefixes errors raised
        // from a validator with "Value error, "; drop it so the message
        // reads as written in schemas.py.
        detail = body.detail
          .map((d: { msg?: unknown }) => (typeof d?.msg === 'string' ? d.msg.replace(/^Value error, /, '') : null))
          .filter(Boolean)
          .join('; ') || detail;
      }
    } catch {
      // non-JSON error body — keep the fallback above
    }
    throw new ApiError(response.status, detail);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// ---------- App config ----------

export function getAppConfig(): Promise<AppConfig> {
  return apiFetch('/config');
}

// ---------- Instruments ----------

export function listInstruments(): Promise<Instrument[]> {
  return apiFetch('/instruments');
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

export function getInstrumentTrendFields(instrumentId: string): Promise<TrendField[]> {
  return apiFetch(`/instruments/${instrumentId}/trend-fields`);
}

export function getInstrumentTrend(instrumentId: string, field: string): Promise<InstrumentTrend> {
  return apiFetch(`/instruments/${instrumentId}/trend?${new URLSearchParams({ field })}`);
}

// ---------- Analytics ----------

export function getFleetAnalytics(): Promise<FleetAnalytics> {
  return apiFetch('/analytics/fleet');
}

// ---------- Report templates ----------

export function findTemplate(model: string, reportType: ReportType): Promise<ReportTemplate | null> {
  return apiFetch<ReportTemplate[]>(
    `/report-templates?${new URLSearchParams({ model, report_type: reportType })}`
  ).then((list) => list[0] ?? null);
}

// ---------- Report template management ----------
//
// Structured-editor CRUD (the Templates tab) — mirrors backend/app/schemas.py's
// TemplateFieldIn/TemplateCreate/TemplateUpdate field for field. Distinct
// from the plain TemplateField above only in that unit/notes/options/
// item_schema are all optional here: the editor builds these payloads from
// scratch as the technician fills in the form, so nothing is guaranteed
// present the way a template already saved by the backend is.
export interface TemplateFieldPayload {
  name: string;
  type: FieldType;
  unit?: string | null;
  notes?: string | null;
  options?: string[];
  item_schema?: ItemSchemaColumn[];
}

export interface TemplateCreatePayload {
  instrument_type?: string;
  report_type: ReportType;
  model?: string | null;
  fields: TemplateFieldPayload[];
}

// All optional — PATCH /report-templates/{id} uses exclude_unset semantics
// (see schemas.py's TemplateUpdate), so a key genuinely omitted here (not
// sent as JSON at all) leaves that column unchanged, while `model: null`
// explicitly clears it to the any-model fallback. Never omit `model` and
// expect a clear; call sites must decide and send accordingly.
export interface TemplateUpdatePayload {
  report_type?: ReportType;
  model?: string | null;
  fields?: TemplateFieldPayload[];
}

// GET /report-templates/all — every row, unresolved (unlike findTemplate
// above, which returns resolve_template()'s one-per-report-type pick). The
// Templates tab's list view needs every variant, including ones no model
// currently resolves to.
export function listAllReportTemplates(): Promise<ReportTemplate[]> {
  return apiFetch('/report-templates/all');
}

export function getReportTemplate(templateId: string): Promise<ReportTemplate> {
  return apiFetch(`/report-templates/${templateId}`);
}

export function createReportTemplate(payload: TemplateCreatePayload): Promise<ReportTemplate> {
  return apiFetch('/report-templates', { method: 'POST', body: JSON.stringify(payload) });
}

export function updateReportTemplate(templateId: string, payload: TemplateUpdatePayload): Promise<ReportTemplate> {
  return apiFetch(`/report-templates/${templateId}`, { method: 'PATCH', body: JSON.stringify(payload) });
}

export function deleteReportTemplate(templateId: string): Promise<void> {
  return apiFetch(`/report-templates/${templateId}`, { method: 'DELETE' });
}

// ---------- Reports ----------

export function createReport(payload: { technician_name?: string | null }): Promise<Report> {
  return apiFetch('/reports', { method: 'POST', body: JSON.stringify(payload) });
}

export function getReport(reportId: string): Promise<Report> {
  return apiFetch(`/reports/${reportId}`);
}

export interface ReportFilters {
  instrument_id?: string;
  report_type?: ReportType;
  status?: ReportStatus;
  date_from?: string;
  date_to?: string;
  technician?: string;
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

// ---------- Attachments / extraction ----------

export function uploadAttachment(reportId: string, file: File): Promise<Attachment> {
  const form = new FormData();
  form.append('file', file);
  return apiFetch(`/reports/${reportId}/attachments`, { method: 'POST', body: form });
}

// Not routed through apiFetch — same reasoning as reportsExportUrl above:
// this is a direct link href (opened in a new tab, or downloaded), not a
// fetch, so the browser handles the PDF/image response and its
// Content-Disposition filename itself rather than any JS/blob plumbing here.
export function attachmentFileUrl(attachmentId: string): string {
  return `${API_BASE}/attachments/${attachmentId}/file`;
}

// Both of these now only enqueue a job and return immediately (202) — the
// actual Claude vision call happens in the background worker (app/worker.py,
// SL-ARCH-001 §3), not inline in the request (a vision call runs seconds,
// not milliseconds, and §3 is explicit that shouldn't block an HTTP
// request). Callers poll the returned job with pollExtractionJob below.
export function classifyAttachment(attachmentId: string): Promise<ExtractionJob> {
  return apiFetch(`/attachments/${attachmentId}/classify`, { method: 'POST' });
}

export function extractAttachment(attachmentId: string): Promise<ExtractionJob> {
  return apiFetch(`/attachments/${attachmentId}/extract`, { method: 'POST' });
}

export function getExtractionJob(jobId: string): Promise<ExtractionJob> {
  return apiFetch(`/extraction-jobs/${jobId}`);
}

// Polls GET /extraction-jobs/{id} (§9) until the background worker (§3)
// moves it out of pending/classifying/extracting. Resolves with the job
// either way — succeeded or failed is a normal outcome for a caller to
// branch on (see App.tsx's runClassification/runExtraction), not an
// exception; only a genuinely stuck job (past timeoutMs) throws.
export async function pollExtractionJob(
  jobId: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<ExtractionJob> {
  const intervalMs = opts.intervalMs ?? 400;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await getExtractionJob(jobId);
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    if (Date.now() >= deadline) {
      throw new ApiError(0, `Extraction job ${jobId} did not finish within ${Math.round(timeoutMs / 1000)}s.`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
