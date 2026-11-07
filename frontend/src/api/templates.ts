import { apiFetch } from './http';
import type { FieldSource, FieldType, ItemSchemaColumn, ReportTemplate, ReportType, TemplateField } from './types';

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
  filled_by_person?: boolean;
  optional?: boolean;
  source?: FieldSource;
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

/** A stored PDF the template editor can show while a person picks fields from it. */
export interface SampleScan {
  attachment_id: string;
  report_id: string;
  file_name: string;
  report_type: ReportType | null;
  instrument_model: string | null;
  instrument_serial_number: string | null;
  report_date: string | null;
  /** Why it is offered: "Same report type and model", "Same report type", "Same model" or "Another report". */
  reason: string;
}

export function listSampleScans(params: { report_type?: ReportType; model?: string; limit?: number } = {}): Promise<SampleScan[]> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const qs = query.toString();
  return apiFetch(`/report-templates/sample-scans${qs ? `?${qs}` : ''}`);
}
