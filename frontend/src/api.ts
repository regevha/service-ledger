/**
 * Typed client for the ServiceLedger backend (see SL-TDD-001 §6 for the
 * full endpoint table). Shapes here mirror backend/app/schemas.py field for
 * field rather than approximating them, so a backend schema change is a
 * compile error here, not a silent runtime mismatch.
 */

import type { components } from './generated/api-schema';

// Not set: the local backend. Set to an empty string: the same address the page
// came from (the deployed image serves the built page and the API together).
const CONFIGURED_API_BASE = import.meta.env.VITE_API_BASE_URL as string | undefined;
const API_BASE = CONFIGURED_API_BASE === undefined ? 'http://localhost:8000' : CONFIGURED_API_BASE.replace(/\/+$/, '');

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
  /** The model record this instrument belongs to (see InstrumentModel); the model filters use it. */
  model_id?: string | null;
  manufacturer: string | null;
  /** The local seller / service company when it is not the maker (e.g. "Rhenium"). */
  distributor: string | null;
  /** The university or company the unit belongs to (e.g. "Bar-Ilan University"). */
  institution: string | null;
  serial_number: string;
  location: string | null;
  status: InstrumentStatus;
  /** Worked out by the backend from the model's service interval and the newest finalized preventive-maintenance report. */
  last_maintenance_date?: string | null;
  maintenance_due_date?: string | null;
  /** null for a retired instrument. */
  maintenance_state?: MaintenanceState | null;
}

export type MaintenanceState = 'not_tracked' | 'no_record' | 'ok' | 'due_soon' | 'overdue';

// instrument_type is chosen when an instrument is created and cannot be
// changed afterwards (InstrumentUpdate has no such field).
export interface InstrumentCreatePayload {
  name: string;
  /** The `key` of an instrument type (GET /instrument-types). */
  instrument_type: string;
  model: string;
  /** Required for a new instrument. */
  manufacturer: string;
  /** Optional: the local seller / service company, if it is not the maker. */
  distributor?: string | null;
  /** Optional: the university or company the unit belongs to. */
  institution?: string | null;
  serial_number: string;
  location?: string | null;
}

export interface InstrumentType {
  id: string;
  /** What instruments and templates store (e.g. "facs"). */
  key: string;
  /** What people see (e.g. "Flow cytometer"). */
  display_name: string;
}

export interface InstrumentUpdatePayload {
  name?: string;
  model?: string;
  manufacturer?: string | null;
  distributor?: string | null;
  institution?: string | null;
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
  /** Who issued the form (often a distributor), when classification read one. */
  issuer?: string | null;
  /** A second report type the visit also fits, when classification read one. */
  report_type_note?: string | null;
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
  /** Only when the list was searched: an excerpt around the first match (matched runs are the found words), and the field it came from. */
  snippet?: { text: string; matched: boolean }[] | null;
  matched_field?: string | null;
}

export interface Attachment {
  id: string;
  report_id: string;
  file_path: string;
  file_type: string;
  page_count: number;
  /** Status of the current translation, or null when it never went through the translate step. */
  translation_status?: TranslationStatus | null;
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
  // Read off another company's form: who issued it (often a distributor), the
  // instrument's maker and model name as far as the model could tell, false when
  // the instrument is not any model in the fleet (the instrument guess is then
  // a zero-confidence placeholder), and a second report type if the visit fits two.
  issuer?: string | null;
  detected_manufacturer?: string | null;
  detected_model?: string | null;
  maker_in_fleet?: boolean;
  report_type_note?: string | null;
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
  institution?: string | null;
  serial_number: string;
  report_count: number;
  total_labor_hours: number;
}

/** Reports that matched the filters (finalized unless the status filter says otherwise), per instrument. */
export interface ReportCountByInstrument {
  instrument_id: string;
  name: string;
  model: string;
  institution?: string | null;
  serial_number: string;
  report_count: number;
}

/** The same counts added up per instrument model. */
export interface ReportCountByModel {
  model: string;
  unit_count: number;
  report_count: number;
}

export interface PassFailBreakdown {
  pass_count: number;
  fail_count: number;
  other_count: number;
  total: number;
}

export interface FleetAnalytics {
  finalized_report_count: number;
  parts_replaced: PartUsage[];
  total_labor_hours: number;
  labor_hours_by_instrument: InstrumentRollup[];
  /** Finalized repair/PM reports that added no hours (no number in the labor field, or no instrument). */
  reports_without_labor_hours?: number;
  report_counts_by_instrument?: ReportCountByInstrument[];
  report_counts_by_model?: ReportCountByModel[];
  labor_hours_by_fault_category: Record<string, number>;
  pass_fail_by_report_type: Record<string, PassFailBreakdown>;
}

// ---------- Fetch plumbing ----------

export class ApiError extends Error {
  status: number;
  /** Set when an upload is refused because the exact file is already on file under a read report. */
  existingReportId?: string;
  constructor(status: number, message: string, existingReportId?: string) {
    super(message);
    this.status = status;
    this.existingReportId = existingReportId;
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
    throw new ApiError(0, `Could not reach the backend at ${API_BASE || 'this address'}. Is it running (uvicorn app.main:app), and is VITE_API_BASE_URL correct?`);
  }

  if (!response.ok) {
    // statusText is empty over HTTP/2, so it can't be the only fallback.
    let detail = response.statusText || `Request failed (${response.status})`;
    let existingReportId: string | undefined;
    try {
      const body = await response.json();
      if (typeof body?.existing_report_id === 'string') existingReportId = body.existing_report_id;
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
    throw new ApiError(response.status, detail, existingReportId);
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

export function listInstrumentTypes(): Promise<InstrumentType[]> {
  return apiFetch('/instrument-types');
}

export function createInstrumentType(displayName: string): Promise<InstrumentType> {
  return apiFetch('/instrument-types', { method: 'POST', body: JSON.stringify({ display_name: displayName }) });
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

// Refused (409) while the instrument still has reports.
export function deleteInstrument(instrumentId: string): Promise<void> {
  return apiFetch(`/instruments/${instrumentId}`, { method: 'DELETE' });
}

export function getInstrumentTrendFields(instrumentId: string): Promise<TrendField[]> {
  return apiFetch(`/instruments/${instrumentId}/trend-fields`);
}

export function getInstrumentTrend(instrumentId: string, field: string): Promise<InstrumentTrend> {
  return apiFetch(`/instruments/${instrumentId}/trend?${new URLSearchParams({ field })}`);
}

// ---------- Analytics ----------

export interface UnitComparison {
  instrument_id: string;
  name: string;
  serial_number: string;
  status: InstrumentStatus;
  finalized_report_count: number;
  last_report_date: string | null;
  labor_report_count: number;
  total_labor_hours: number;
  parts_replaced_qty: number;
  repair_results: PassFailBreakdown;
  preventive_maintenance_results: PassFailBreakdown;
}

export interface ModelComparison {
  model: string;
  units: UnitComparison[];
  trend_fields: TrendField[];
}

export interface ModelTrendSeries {
  instrument_id: string;
  name: string;
  serial_number: string;
  points: TrendPoint[];
}

export interface ModelTrend {
  model: string;
  field: string;
  series: ModelTrendSeries[];
}

/**
 * What the analytics are computed from; every field is optional and they
 * combine. The same meaning as on the Reports list: the type is the report's
 * template type, the dates are the report date (a report with no date drops out
 * once a date is set), and the instrument is one unit and the manufacturer is
 * every unit from that maker (both also limit the units listed).
 */
export interface AnalyticsFilters {
  instrument_id?: string;
  /** Every unit of one model record (also limits the units listed). */
  model_id?: string;
  manufacturer?: string;
  report_type?: ReportType;
  date_from?: string;
  date_to?: string;
  /** Omitted: finalized reports only. 'all': every status. Otherwise that one status. */
  status?: string;
  /** Lab manager contains this text. */
  technician?: string;
  /** Free-text search over finalized reports (two or more characters). */
  q?: string;
}

function analyticsParams(filters: AnalyticsFilters, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra);
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

// Units of the same model side by side (finalized reports only).
export function getModelComparison(filters: AnalyticsFilters = {}): Promise<ModelComparison[]> {
  return apiFetch(`/analytics/models${analyticsParams(filters)}`);
}

export function getModelTrend(model: string, field: string, filters: AnalyticsFilters = {}): Promise<ModelTrend> {
  return apiFetch(`/analytics/models/trend${analyticsParams(filters, { model, field })}`);
}

export function getFleetAnalytics(filters: AnalyticsFilters = {}): Promise<FleetAnalytics> {
  return apiFetch(`/analytics/fleet${analyticsParams(filters)}`);
}

// ---------- Report templates ----------

export function findTemplate(
  model: string,
  reportType: ReportType,
  instrumentType: string
): Promise<ReportTemplate | null> {
  return apiFetch<ReportTemplate[]>(
    `/report-templates?${new URLSearchParams({ model, report_type: reportType, instrument_type: instrumentType })}`
  ).then((list) => list[0] ?? null);
}

// One existing template offered as the starting point for a new one
// (GET /report-templates/suggestions). Advice only: choosing it just copies its
// fields into the new-template form, where a person edits them before saving.
export interface TemplateSuggestion {
  template: ReportTemplate;
  score: number;
  /** Why it was picked, e.g. "same report type, same FACSAria family (FACSAria III)". */
  reason: string;
  field_count: number;
}

export function getTemplateSuggestions(params: {
  reportType: ReportType;
  instrumentType: string;
  model?: string | null;
  limit?: number;
}): Promise<TemplateSuggestion[]> {
  const query = new URLSearchParams({ report_type: params.reportType, instrument_type: params.instrumentType });
  if (params.model) query.set('model', params.model);
  if (params.limit) query.set('limit', String(params.limit));
  return apiFetch(`/report-templates/suggestions?${query}`);
}

// Two templates of one instrument type with their fields lined up
// (GET /report-templates/compare). Read-only advice for a person; asking
// changes nothing. `differences` names what differs on a "differs" row.
export type CompareStatus = 'same' | 'differs' | 'only_left' | 'only_right' | 'possible_match';
export type CompareAttribute = 'name' | 'type' | 'unit' | 'notes' | 'options' | 'item_schema';

export interface TemplateCompareRow {
  status: CompareStatus;
  name: string;
  differences: CompareAttribute[];
  left: TemplateField | null;
  right: TemplateField | null;
  /** On a possible_match row: the alias group that lists the two names as one concept. */
  concept?: { id: string; label: string | null; names: string[] } | null;
}

export interface TemplateCompare {
  left: ReportTemplate;
  right: ReportTemplate;
  summary: {
    left_count: number;
    right_count: number;
    shared: number;
    same: number;
    differs: number;
    only_left: number;
    only_right: number;
    possible_match: number;
  };
  rows: TemplateCompareRow[];
}

export function compareTemplates(leftId: string, rightId: string): Promise<TemplateCompare> {
  return apiFetch(`/report-templates/compare?${new URLSearchParams({ left: leftId, right: rightId })}`);
}

// ---------- Field aliases ----------
//
// Sets of field names that mean the same thing under different wording
// ("retest_result", "verification_result"), kept by hand and shared by everyone.
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

export interface TemplateUsage {
  template_id: string;
  report_count: number;
  finalized_count: number;
}

// GET /report-templates/usage — per template, how many reports use it (and how
// many of those are finalized). Templates nothing uses are not listed.
export function getTemplateUsage(): Promise<TemplateUsage[]> {
  return apiFetch('/report-templates/usage');
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
//
// `inline` asks for the file to be displayed rather than downloaded: needed for
// an <iframe>, which stays blank when the response is an attachment.
export function attachmentFileUrl(attachmentId: string, opts: { inline?: boolean } = {}): string {
  return `${API_BASE}/attachments/${attachmentId}/file${opts.inline ? '?inline=1' : ''}`;
}

/** Page count of the stored scan (an image is one page), and a page rendered as a PNG for the phone's Scan view. */
export function getAttachmentPageCount(attachmentId: string): Promise<{ page_count: number }> {
  return apiFetch(`/attachments/${attachmentId}/pages`);
}

export function attachmentPageUrl(attachmentId: string, page: number, width = 900): string {
  return `${API_BASE}/attachments/${attachmentId}/pages/${page}?width=${width}`;
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

// ---------- Saved report filters ----------

// A named combination of the Reports list's six filters, shared by everyone
// (at most `cap` exist). `filters` holds only the criteria that were set.
export interface SavedFilter {
  id: string;
  name: string;
  filters: ReportFilters;
  created_at: string;
  /** The saved instrument or model no longer exists. */
  stale: boolean;
  /** Which saved criteria point at something that is gone. */
  stale_keys: ('instrument_id' | 'model_id')[];
}

export interface SavedFilterList {
  items: SavedFilter[];
  cap: number;
}

export function listSavedFilters(): Promise<SavedFilterList> {
  return apiFetch('/saved-report-filters');
}

export function createSavedFilter(name: string, filters: ReportFilters): Promise<SavedFilter> {
  return apiFetch('/saved-report-filters', { method: 'POST', body: JSON.stringify({ name, filters }) });
}

export function deleteSavedFilter(id: string): Promise<void> {
  return apiFetch(`/saved-report-filters/${id}`, { method: 'DELETE' });
}

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

export type InstrumentModelDetail = components['schemas']['InstrumentModelDetailOut'];
export type InstrumentModelUnit = components['schemas']['InstrumentModelUnitOut'];

export type ModelReliability = components['schemas']['ModelReliabilityOut'];

export function getModelReliability(id: string): Promise<ModelReliability> {
  return apiFetch(`/instrument-models/${id}/reliability`);
}

export function getInstrumentModel(id: string): Promise<InstrumentModelDetail> {
  return apiFetch(`/instrument-models/${id}`);
}
