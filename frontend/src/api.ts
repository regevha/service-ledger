/**
 * Typed client for the Calibration Ledger backend (see CL-TDD-001 §6 for the
 * full endpoint table). Shapes here mirror backend/app/schemas.py field for
 * field rather than approximating them, so a backend schema change is a
 * compile error here, not a silent runtime mismatch.
 */

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/+$/, '') || 'http://localhost:8000';

// ---------- Shapes (mirrors app/schemas.py) ----------

export type InstrumentStatus = 'active' | 'maintenance' | 'retired';

export interface Instrument {
  id: string;
  name: string;
  instrument_type: string;
  model: string;
  serial_number: string;
  location: string | null;
  status: InstrumentStatus;
}

export type ReportType = 'calibration' | 'repair' | 'preventive_maintenance';

export type FieldType =
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'enum'
  | 'enum[]'
  | 'object[]'
  | 'number[detector]'
  | 'number[laser]';

export interface TemplateField {
  name: string;
  type: FieldType;
  unit: string | null;
  notes: string | null;
  options?: string[];
  item_schema?: Record<string, string>;
}

export interface ReportTemplate {
  id: string;
  instrument_type: string;
  report_type: ReportType;
  model: string | null;
  field_schema: { fields: TemplateField[] };
}

export type ReportStatus = 'draft' | 'classified' | 'extracted' | 'in_review' | 'finalized';

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
}

export interface Attachment {
  id: string;
  report_id: string;
  file_path: string;
  file_type: string;
  page_count: number;
}

export interface ClassificationGuess {
  value: string;
  confidence: number;
}

export interface ClassificationResult {
  instrument: ClassificationGuess;
  report_type: ClassificationGuess;
  resolved_template_id: string | null;
  resolved_instrument_id: string | null;
}

export type ExtractionJobStatus = 'pending' | 'classifying' | 'extracting' | 'succeeded' | 'failed';

export interface ExtractionJob {
  id: string;
  attachment_id: string;
  status: ExtractionJobStatus;
  classification: Record<string, unknown> | null;
  field_confidences: Record<string, number> | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
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
    let detail = response.statusText;
    try {
      const body = await response.json();
      if (typeof body?.detail === 'string') detail = body.detail;
    } catch {
      // non-JSON error body — fall back to statusText
    }
    throw new ApiError(response.status, detail);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// ---------- Instruments ----------

export function listInstruments(): Promise<Instrument[]> {
  return apiFetch('/instruments');
}

// ---------- Report templates ----------

export function findTemplate(model: string, reportType: ReportType): Promise<ReportTemplate | null> {
  return apiFetch<ReportTemplate[]>(
    `/report-templates?${new URLSearchParams({ model, report_type: reportType })}`
  ).then((list) => list[0] ?? null);
}

// ---------- Reports ----------

export function createReport(payload: { technician_name?: string | null }): Promise<Report> {
  return apiFetch('/reports', { method: 'POST', body: JSON.stringify(payload) });
}

export function getReport(reportId: string): Promise<Report> {
  return apiFetch(`/reports/${reportId}`);
}

export function confirmTemplate(reportId: string, instrumentId: string, templateId: string): Promise<Report> {
  return apiFetch(`/reports/${reportId}/template`, {
    method: 'PATCH',
    body: JSON.stringify({ instrument_id: instrumentId, template_id: templateId }),
  });
}

export function updateReportFields(
  reportId: string,
  payload: { extracted_fields?: Record<string, unknown> }
): Promise<Report> {
  return apiFetch(`/reports/${reportId}/fields`, { method: 'PATCH', body: JSON.stringify(payload) });
}

export function finalizeReport(reportId: string): Promise<Report> {
  return apiFetch(`/reports/${reportId}/finalize`, { method: 'POST' });
}

// ---------- Attachments / extraction ----------

export function uploadAttachment(reportId: string, file: File): Promise<Attachment> {
  const form = new FormData();
  form.append('file', file);
  return apiFetch(`/reports/${reportId}/attachments`, { method: 'POST', body: form });
}

export function classifyAttachment(attachmentId: string): Promise<ClassificationResult> {
  return apiFetch(`/attachments/${attachmentId}/classify`, { method: 'POST' });
}

export function extractAttachment(attachmentId: string): Promise<ExtractionJob> {
  return apiFetch(`/attachments/${attachmentId}/extract`, { method: 'POST' });
}
