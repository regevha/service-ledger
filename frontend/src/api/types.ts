import type { components } from '../generated/api-schema';
import type { TranslationStatus } from './translations';

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
  /** The most specific place known (see Places); null when no institution or room is recorded. */
  place_id?: string | null;
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
  /** What instruments and templates store (e.g. "flow_cytometer"). */
  key: string;
  /** What people see (e.g. "Flow cytometer"). */
  display_name: string;
  /** The type a new instrument, model or template starts with. */
  is_default: boolean;
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

/** Where on a sample PDF a field was picked: a 1-based page and a box in fractions of the page (0 to 1 from the top left). */
export interface FieldSource {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TemplateField {
  name: string;
  type: FieldType;
  unit: string | null;
  notes: string | null;
  options?: string[];
  item_schema?: ItemSchemaColumn[];
  /** Filled in by a person, not printed on the form: the model only suggests it, and Review always asks to check it. */
  filled_by_person?: boolean;
  /** May be left empty: when the form does not state it, an empty value is not flagged on Review. */
  optional?: boolean;
  /** Where on a sample PDF the field was picked; absent for a field typed by hand. */
  source?: FieldSource | null;
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
  /** The prompt waiting for Send/Cancel while status is 'awaiting_approval' (VIEW_PROMPTS). */
  prompt_preview?: PromptPreview | null;
  started_at: string | null;
  completed_at: string | null;
}

/** The exact request a job is about to send to Claude (backend services/prompt_gate.py). */
export interface PromptPreview {
  verb: string;
  model: string | null;
  max_tokens: number | null;
  system: unknown;
  tool_choice: unknown;
  tools: unknown;
  blocks: {
    type: string;
    role?: string | null;
    text?: string;
    media_type?: string | null;
    bytes?: number | null;
    sha256?: string | null;
  }[];
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
  /** Hours for the fleet list's row. */
  total_labor_hours?: number;
}

/** The same counts added up per instrument model. */
export interface ReportCountByModel {
  model: string;
  /** The model record's id: what the model_id filter takes. Null for units with no model record. */
  model_id?: string | null;
  unit_count: number;
  report_count: number;
  total_labor_hours?: number;
}

export type PlaceRollup = components['schemas']['PlaceRollupOut'];

export interface FleetAnalytics {
  finalized_report_count: number;
  parts_replaced: PartUsage[];
  total_labor_hours: number;
  labor_hours_by_instrument: InstrumentRollup[];
  /** Finalized repair/PM reports that added no hours (no number in the labor field, or no instrument). */
  reports_without_labor_hours?: number;
  report_counts_by_instrument?: ReportCountByInstrument[];
  report_counts_by_model?: ReportCountByModel[];
  /** Instruments, reports and work hours per institution, faculty and room. */
  place_rollups?: PlaceRollup[];
  labor_hours_by_fault_category: Record<string, number>;
}
