"""Pydantic request/response shapes for the API in app/routers/.

Kept close to the ORM models but separate from them on purpose — a report in
`draft` has no instrument or template yet (§4/§5), so the response shape has
to make those genuinely optional rather than just nullable columns leaking
through.
"""
from __future__ import annotations

import enum
import uuid
from typing import Literal
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, field_validator, model_validator

from app.models import (
    ExtractionJobKind,
    ExtractionJobStatus,
    InstrumentStatus,
    ReportStatus,
    ReportType,
    TranslationStatus,
)


# ---------- App config ----------


class AppConfigOut(BaseModel):
    """GET /config (§4/§12): the confidence thresholds the frontend used to
    hardcode as its own literal copies of app/config.py's settings. Those two
    numbers drive real UI behavior (review-flagging, badge coloring), so a
    backend .env change used to silently desync the UI instead of the UI
    just reading the real value from here."""

    field_confidence_threshold: float
    classification_confidence_threshold: float
    # False when running without an API key: extraction values are then
    # deterministic placeholders and their "confidence" is not a measurement,
    # so the UI labels them as placeholders instead of showing a percentage.
    live_claude: bool = False


# ---------- Instruments ----------


class InstrumentTypeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    key: str
    display_name: str


class InstrumentTypeCreate(BaseModel):
    display_name: str


def _required_text(label: str):
    """A validator body for a field that must hold real text: trimmed, and a
    blank or all-whitespace value is refused (422) rather than stored."""

    def check(value: str | None) -> str | None:
        if value is None:
            return None  # an omitted/null PATCH field is handled by the router
        value = value.strip()
        if not value:
            raise ValueError(f"{label} cannot be blank")
        return value

    return check


class InstrumentCreate(BaseModel):
    name: str
    instrument_type: str = "facs"
    model: str
    # Required for new instruments (existing rows may still have none). Blank
    # counts as missing.
    manufacturer: str
    # Optional: the local seller / service company when it is not the maker.
    distributor: str | None = None
    serial_number: str
    location: str | None = None

    @field_validator("name")
    @classmethod
    def _name_not_blank(cls, value: str) -> str:
        return _required_text("Name")(value)

    @field_validator("model")
    @classmethod
    def _model_not_blank(cls, value: str) -> str:
        return _required_text("Model")(value)

    @field_validator("serial_number")
    @classmethod
    def _serial_not_blank(cls, value: str) -> str:
        return _required_text("Serial number")(value)

    @field_validator("manufacturer")
    @classmethod
    def _manufacturer_required(cls, value: str) -> str:
        """Free text, trimmed; required when creating an instrument."""
        value = value.strip()
        if not value:
            raise ValueError("Manufacturer is required")
        return value

    @field_validator("distributor")
    @classmethod
    def _blank_distributor_is_none(cls, value: str | None) -> str | None:
        """Free text, trimmed; blank means "none / not recorded"."""
        return (value.strip() or None) if isinstance(value, str) else value


class InstrumentUpdate(BaseModel):
    """PATCH /instruments/{id} — every field optional so a caller only sends
    what's changing; `instrument_type` is deliberately not editable here (it is
    chosen when the instrument is created, because its templates and reports
    are tied to it). A name, model or serial number that is sent must not be
    blank. Which fields the caller
    actually sent is read via `model_fields_set` in the router, the same
    partial-update pattern TemplateUpdate below already uses, so an omitted
    field is left alone rather than overwritten with None."""

    name: str | None = None
    model: str | None = None
    manufacturer: str | None = None
    distributor: str | None = None
    serial_number: str | None = None
    location: str | None = None
    status: InstrumentStatus | None = None

    @field_validator("name")
    @classmethod
    def _name_not_blank(cls, value: str | None) -> str | None:
        return _required_text("Name")(value)

    @field_validator("model")
    @classmethod
    def _model_not_blank(cls, value: str | None) -> str | None:
        return _required_text("Model")(value)

    @field_validator("serial_number")
    @classmethod
    def _serial_not_blank(cls, value: str | None) -> str | None:
        return _required_text("Serial number")(value)

    @field_validator("manufacturer")
    @classmethod
    def _blank_manufacturer_is_none(cls, value: str | None) -> str | None:
        """Free text, trimmed; a blank value means "not recorded"."""
        return (value.strip() or None) if isinstance(value, str) else value

    @field_validator("distributor")
    @classmethod
    def _blank_distributor_is_none(cls, value: str | None) -> str | None:
        """Free text, trimmed; a blank value means "none / not recorded"."""
        return (value.strip() or None) if isinstance(value, str) else value


class InstrumentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    instrument_type: str
    model: str
    manufacturer: str | None
    distributor: str | None
    serial_number: str
    location: str | None
    status: InstrumentStatus


# ---------- Report templates ----------


class ReportTemplateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    instrument_type: str
    report_type: ReportType
    model: str | None
    field_schema: dict


# ---------- Report template management ----------


class TemplateUsageOut(BaseModel):
    """How many reports point at one template — what the template manager
    needs to warn before an edit and to explain why a delete is refused.
    Templates no report uses are simply absent from the list."""

    template_id: uuid.UUID
    report_count: int
    finalized_count: int

#
# Structured-editor CRUD for report_templates (routers/report_templates.py),
# replacing "edit seed_templates.py's Python literals and re-run the script"
# as the only way to change a template. field_schema itself stays one JSONB
# blob (ReportTemplateOut.field_schema above, untouched) — these schemas
# only add validation on the way in, matching exactly what
# frontend/src/components/FieldEditor.tsx knows how to render for each type.


class TemplateFieldType(str, enum.Enum):
    """Every field `type` value FieldEditor.tsx's FieldControl switches on —
    kept here, not app/models.py, because it isn't a database column type
    (field_schema stores the whole field list as one JSONB blob on
    ReportTemplate, not as structured columns); this exists purely to
    validate/document those values, and to give frontend/src/api.ts's
    hand-typed `FieldType` union (its one remaining hand-typed enum,
    noted in frontend/README.md) something real to derive from via
    codegen instead."""

    text = "text"
    number = "number"
    boolean = "boolean"
    date = "date"
    enum = "enum"
    enum_list = "enum[]"
    object_list = "object[]"
    number_detector = "number[detector]"
    number_laser = "number[laser]"


# object[]'s item_schema columns are always a leaf control (FieldEditor.tsx's
# ObjectArrayInput renders one leafInput per column) — nesting an array or
# another object inside a table cell isn't something the UI can render, so
# it's rejected below rather than silently accepted and left unrenderable.
_LEAF_FIELD_TYPES = {
    TemplateFieldType.text,
    TemplateFieldType.number,
    TemplateFieldType.boolean,
    TemplateFieldType.date,
}
_OPTIONS_FIELD_TYPES = {TemplateFieldType.enum, TemplateFieldType.enum_list}

# Every report's service-visit date (Report.report_date) is read by the same
# extraction call as its template's fields, and its confidence comes back in
# the same field_confidences dict under this key (see services/extraction.py)
# — so no template field may use this name, or the two would overwrite each
# other in the extraction tool's schema and on the review screen.
REPORT_DATE_KEY = "report_date"


class ItemSchemaColumn(BaseModel):
    """One column of an object[] field's row shape. A *list* of these, not a
    `{name: type}` dict — Postgres's JSONB storage does not preserve object
    key order (it reorders by key length then lexicographically on its
    binary encoding), so a template author's chosen column order (e.g.
    "part_name, part_number, qty") silently scrambled into
    "qty, part_name, part_number" on every read, in the review screen's
    object-array table, the template editor, and the PDF export alike. A
    JSON *array* has no such problem — Postgres round-trips JSONB array
    element order exactly — so the column list is one instead of a dict's
    keys."""

    name: str
    type: TemplateFieldType


def _check_no_duplicate_column_names(columns: list[ItemSchemaColumn], field_name: str) -> None:
    names = [c.name for c in columns]
    dupes = sorted({n for n in names if names.count(n) > 1})
    if dupes:
        raise ValueError(f"Field '{field_name}': duplicate item_schema column name(s): {dupes}")


class TemplateFieldIn(BaseModel):
    """One row of the structured editor's field list. `options` and
    `item_schema` are conditionally required/forbidden by `type` — the same
    shapes seed_templates.py's own field lists already follow by hand (see
    e.g. REPAIR_FIELDS's fault_category/components_replaced entries)."""

    name: str
    type: TemplateFieldType
    unit: str | None = None
    notes: str | None = None
    options: list[str] | None = None
    item_schema: list[ItemSchemaColumn] | None = None

    @model_validator(mode="after")
    def _check_shape(self) -> "TemplateFieldIn":
        name = self.name.strip()
        if not name:
            raise ValueError("Field name cannot be blank")
        if name == REPORT_DATE_KEY:
            raise ValueError(
                f"'{REPORT_DATE_KEY}' is reserved — every report's service date is already read from the document"
            )
        self.name = name

        wants_options = self.type in _OPTIONS_FIELD_TYPES
        if wants_options and not self.options:
            raise ValueError(f"Field '{name}': type {self.type.value} requires a non-empty options list")
        if not wants_options and self.options:
            raise ValueError(f"Field '{name}': options is only valid for enum/enum[] fields")

        wants_item_schema = self.type == TemplateFieldType.object_list
        if wants_item_schema and not self.item_schema:
            raise ValueError(f"Field '{name}': type object[] requires a non-empty item_schema")
        if not wants_item_schema and self.item_schema:
            raise ValueError(f"Field '{name}': item_schema is only valid for object[] fields")
        if wants_item_schema and self.item_schema:
            _check_no_duplicate_column_names(self.item_schema, name)
            bad = sorted(c.type.value for c in self.item_schema if c.type not in _LEAF_FIELD_TYPES)
            if bad:
                allowed = sorted(t.value for t in _LEAF_FIELD_TYPES)
                raise ValueError(f"Field '{name}': item_schema column types must be one of {allowed}, got {bad}")
        return self


def _check_no_duplicate_names(fields: list[TemplateFieldIn]) -> None:
    names = [f.name for f in fields]
    dupes = sorted({n for n in names if names.count(n) > 1})
    if dupes:
        raise ValueError(f"Duplicate field name(s): {dupes}")


class TemplateCreate(BaseModel):
    """POST /report-templates. `model=None` is the "applies to every model of
    this instrument_type" fallback row (§2) — a real, meaningful choice, not
    an omitted one, so it defaults to None rather than being required."""

    instrument_type: str = "facs"
    report_type: ReportType
    model: str | None = None
    fields: list[TemplateFieldIn]

    @model_validator(mode="after")
    def _check_fields(self) -> "TemplateCreate":
        if isinstance(self.model, str):
            stripped = self.model.strip()
            self.model = stripped or None
        if not self.fields:
            raise ValueError("A template needs at least one field")
        _check_no_duplicate_names(self.fields)
        return self


class TemplateUpdate(BaseModel):
    """PATCH /report-templates/{id} — exclude_unset semantics, same
    precedent as ReportFieldsUpdate: `model` can be explicitly nulled (falls
    back to the any-model row), but `fields` has no sensible null (a
    template with no field_schema breaks the review screen), so an explicit
    null there is rejected the same way ReportFieldsUpdate rejects a null
    extracted_fields."""

    report_type: ReportType | None = None
    model: str | None = None
    fields: list[TemplateFieldIn] | None = None

    @model_validator(mode="after")
    def _check_fields(self) -> "TemplateUpdate":
        if isinstance(self.model, str):
            stripped = self.model.strip()
            self.model = stripped or None
        if self.fields is not None:
            if not self.fields:
                raise ValueError("A template needs at least one field")
            _check_no_duplicate_names(self.fields)
        return self


# ---------- Attachments ----------


class AttachmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    report_id: uuid.UUID
    file_path: str
    file_type: str
    page_count: int
    # Status of the current translation (pending_review, accepted, discarded,
    # not_needed), or None when the document never went through the translate step.
    translation_status: str | None = None
    # Set only on the upload response: other reports that already hold a file
    # with these exact bytes, or whose PDF text names the same work order. A
    # warning, never a rejection.
    duplicate_report_ids: list[uuid.UUID] = []


# ---------- Reports ----------


class ReportCreate(BaseModel):
    """§9: POST /reports starts a bare draft — no instrument or template yet."""

    technician_name: str | None = None
    report_date: date | None = None


class ReportOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    instrument_id: uuid.UUID | None
    template_id: uuid.UUID | None
    status: ReportStatus
    extracted_fields: dict
    technician_name: str | None
    # Who issued the form and a second report type, when classification read
    # them off the document (see ClassificationResult).
    issuer: str | None = None
    report_type_note: str | None = None
    service_actions: str | None
    parts_replaced: str | None
    next_service_due: date | None
    report_date: date | None
    created_at: datetime
    finalized_at: datetime | None
    # The report screen's "view original scan" link (§4/§9 gap noticed while
    # testing the demo build — GET /reports/{id} previously carried no way
    # back to the attachment that produced it) reads off this list rather
    # than a separate GET /reports/{id}/attachments round trip, since
    # ReportOut already loads the ORM row this hangs off of for free via the
    # existing Report.attachments relationship.
    attachments: list[AttachmentOut] = []


class SnippetPiece(BaseModel):
    """One run of an excerpt: plain text, and whether it is a matched word.
    The server never sends HTML; the screen wraps matched pieces itself."""

    text: str
    matched: bool


class ReportListItemOut(BaseModel):
    """§7/§9: the denormalized shape GET /reports (filtered search) returns —
    distinct from ReportOut, which stays the raw single-report detail shape
    the review flow (PATCH .../fields, .../finalize) round-trips against.
    A list screen needs instrument_model/report_type to render a readable
    row without an extra round trip per report, so this builds them from the
    same instrument/template relationships export_reports already reads —
    it just returns them as JSON instead of flattening straight to CSV."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    status: ReportStatus
    instrument_model: str | None
    instrument_serial_number: str | None
    report_type: ReportType | None
    technician_name: str | None
    report_date: date | None
    created_at: datetime
    finalized_at: datetime | None
    # Only when the list was searched (`q`): a short excerpt around the first
    # match, and the label of the field it came from.
    snippet: list[SnippetPiece] | None = None
    matched_field: str | None = None


class DuplicateReportOut(ReportListItemOut):
    """One entry of GET /reports/{id}/duplicates: another saved report that
    probably records the same visit as this one, in the list-item shape so a
    screen can show and open it without another lookup.

    `reason` is `same_file` (the other report holds a scan with exactly these
    bytes) or `same_work_order` (a scan carrying the same normalized work-order
    number, on the same instrument). If both apply, `same_file` is reported."""

    reason: Literal["same_file", "same_work_order"]
    work_order_number: str | None = None


class ReportFieldsUpdate(BaseModel):
    """§9: PATCH /reports/{id}/fields — overwrites in place, no audit log in MVP."""

    extracted_fields: dict | None = None
    technician_name: str | None = None
    service_actions: str | None = None
    parts_replaced: str | None = None
    next_service_due: date | None = None
    report_date: date | None = None


class TemplateConfirmation(BaseModel):
    """§9: PATCH /reports/{id}/template — confirm or override what classify
    guessed. An override re-triggers extraction (§4, §6)."""

    instrument_id: uuid.UUID
    template_id: uuid.UUID


# ---------- Extraction jobs / classification ----------


class ClassificationGuess(BaseModel):
    value: str
    confidence: float


class ClassificationResult(BaseModel):
    instrument: ClassificationGuess
    report_type: ClassificationGuess
    # The instrument serial number as printed on the document, with Claude's
    # confidence in the read; None when the document shows none (or "N/A").
    instrument_serial: ClassificationGuess | None = None
    # What matching that serial against the fleet found:
    #   matched         exactly one fleet instrument has this serial
    #   not_found       a serial was read but no instrument has it
    #   model_conflict  it matches an instrument whose model is not the model
    #                   read from the document, so one of the two reads is wrong
    #   not_read        no serial on the document
    serial_match: Literal["matched", "not_found", "model_conflict", "not_read"] = "not_read"
    # The instrument the confirm screen should pre-select: the one the serial
    # matched, else the only unit of the guessed model, else None.
    suggested_instrument_id: uuid.UUID | None = None
    # Present only when both guesses cleared the classification threshold and
    # a template could be resolved automatically (§4 step 3).
    resolved_template_id: uuid.UUID | None = None
    resolved_instrument_id: uuid.UUID | None = None
    # Where report_type came from: "task_code" when it was derived from the
    # printed Work Order Task Code (T113 -> repair, T111 -> PM) by a lookup in
    # code, "model" when it is Claude's own judgment of the document.
    report_type_source: Literal["task_code", "model", "none"] = "model"
    # Who read the document: "model" (Claude), "text_layer" (the PDF's own text
    # parsed in code, no API key), or "stub" (demo answer for a file with no text).
    reader: Literal["model", "text_layer", "stub"] = "model"
    # The work-order number as printed, when one was read.
    work_order_number: str | None = None
    # Read off a document from another company's form: who issued it (often a
    # distributor), the instrument's maker as far as the model could tell, False
    # when that instrument is not any model in the fleet (the instrument guess is
    # then a zero-confidence placeholder for the manual pick), and a note when the
    # visit fits a second report type.
    issuer: str | None = None
    detected_manufacturer: str | None = None
    maker_in_fleet: bool = True
    report_type_note: str | None = None
    # The instrument's model name as printed (for example "Cytek Aurora"), so
    # the intake screen can offer to add it to the fleet.
    detected_model: str | None = None
    # Other reports that already hold this document — same file bytes or same
    # work-order number. Empty when none; the intake screen should warn, not block.
    duplicate_report_ids: list[uuid.UUID] = []


class TranslateRequest(BaseModel):
    """POST /attachments/{id}/translate. `include_pages` asks for pages the model
    would otherwise skip as instrument QC printouts to be translated too."""

    include_pages: list[int] = []

    @field_validator("include_pages")
    @classmethod
    def _pages_positive(cls, v: list[int]) -> list[int]:
        if any(p < 1 for p in v):
            raise ValueError("Page numbers start at 1")
        return sorted(set(v))


class TranslationAccept(BaseModel):
    """POST /translations/{id}/accept. Omit `accepted_text` to accept the model's
    text as it is; send it to accept an edited version."""

    accepted_text: str | None = None

    @field_validator("accepted_text")
    @classmethod
    def _not_blank(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if not v.strip():
            raise ValueError("The accepted translation cannot be empty")
        if len(v) > 200_000:
            raise ValueError("The accepted translation is too long")
        return v


class TranslationOut(BaseModel):
    # `model_text` and `model` start with pydantic's protected "model_" prefix.
    model_config = ConfigDict(from_attributes=True, protected_namespaces=())

    id: uuid.UUID
    attachment_id: uuid.UUID
    status: TranslationStatus
    source_language: str
    hebrew_share: float | None
    model_text: str | None
    accepted_text: str | None
    ignored_pages: list[dict]
    included_pages: list[int]
    identifier_check: dict
    notes: list[str]
    reader: str
    model: str | None
    created_at: datetime
    accepted_at: datetime | None


class ExtractionJobOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    attachment_id: uuid.UUID
    kind: ExtractionJobKind
    status: ExtractionJobStatus
    classification: dict | None
    field_confidences: dict | None
    error_message: str | None = None
    started_at: datetime | None
    completed_at: datetime | None


# ---------- Fleet analytics ----------


class PartUsageOut(BaseModel):
    """One row of GET /analytics/fleet's parts_replaced (fleet-wide, sorted by
    total_qty desc) — aggregated from every finalized report's
    components_replaced entries (repair and preventive_maintenance both
    carry that field with the same {part_name, part_number, qty} shape, see
    seed_templates.py). Keyed by (part_name, part_number) so two different
    parts that happen to share a name don't get merged."""

    part_name: str
    part_number: str | None
    # Number of *reports* whose components_replaced mentioned this part —
    # distinct from total_qty (units), since one report can replace several
    # units of the same part in one visit.
    times_replaced: int
    total_qty: float


class InstrumentRollupOut(BaseModel):
    """One row of GET /analytics/fleet's labor_hours_by_instrument. Every
    active instrument appears here, including one with zero qualifying
    reports — a trouble-free instrument is itself a meaningful data point,
    not an absence to hide."""

    instrument_id: uuid.UUID
    name: str
    model: str
    serial_number: str
    # Finalized repair/preventive_maintenance reports with a numeric
    # labor_hours value — calibration reports never carry labor_hours
    # (seed_templates.py), so they never contribute here.
    report_count: int
    total_labor_hours: float


class PassFailBreakdownOut(BaseModel):
    """retest_result (repair) / verification_result (preventive_maintenance)
    tallied across every finalized report of that type. other_count covers
    both the templates' own non-pass/fail option ("not retested"/"not
    verified") and a report that never got that field filled in at all —
    both are "not a confirmed pass", so this doesn't silently drop them from
    the total the way filtering them out would."""

    pass_count: int
    fail_count: int
    other_count: int
    total: int


class FleetAnalyticsOut(BaseModel):
    """GET /analytics/fleet (new): fleet-wide roll-ups computed entirely from
    fields every finalized report already carries — no new columns, no new
    tables. See services/analytics.py for exactly how each number is derived."""

    parts_replaced: list[PartUsageOut]
    total_labor_hours: float
    labor_hours_by_instrument: list[InstrumentRollupOut]
    # Keyed by whatever fault_category values actually appear in the data
    # (repair only — seed_templates.py's REPAIR_FIELDS) rather than a
    # hardcoded copy of that enum's options, so this can't silently drift
    # from the real template if its options list ever changes.
    labor_hours_by_fault_category: dict[str, float]
    # Keyed by ReportType.value ("repair" / "preventive_maintenance") —
    # always both, even at zero, so the frontend never has to guess whether
    # a missing key means zero or means "not implemented yet".
    pass_fail_by_report_type: dict[str, PassFailBreakdownOut]


# ---------- Instrument trend ----------


class TrendFieldOut(BaseModel):
    """One entry of GET /instruments/{id}/trend-fields: a field this
    instrument's own finalized reports actually have data for, restricted to
    field_schema's three numeric-capable types (`number`,
    `number[detector]`, `number[laser]`) — the same three
    TemplateFieldType members the structured template editor also treats as
    numeric. `type` tells the caller which shape GET .../trend?field=<name>
    returns: a plain float for `number`, a {key: value} map per point for
    the other two (routers/instruments.py::instrument_trend_fields)."""

    name: str
    type: TemplateFieldType
    unit: str | None = None


class TrendPointOut(BaseModel):
    report_id: uuid.UUID
    report_date: date | None
    # A plain float for a "number" field; a {detector/laser key: value} map
    # for number[detector]/number[laser] — TrendFieldOut.type (above) is
    # what tells the caller which shape to expect for a given field name.
    value: float | dict[str, float]


class TrendOut(BaseModel):
    instrument_id: uuid.UUID
    field: str
    points: list[TrendPointOut]


class UnitComparisonOut(BaseModel):
    """One physical unit's row in a same-model comparison (GET /analytics/models).
    Counts come from finalized reports only, like GET /analytics/fleet."""

    instrument_id: uuid.UUID
    name: str
    serial_number: str
    status: InstrumentStatus
    # All finalized reports for the unit, any type (calibrations included).
    finalized_report_count: int
    last_report_date: date | None
    # Finalized repair/preventive_maintenance reports with a numeric labor_hours.
    labor_report_count: int
    total_labor_hours: float
    # Sum of qty over every components_replaced row on the unit's reports.
    parts_replaced_qty: float
    repair_results: PassFailBreakdownOut
    preventive_maintenance_results: PassFailBreakdownOut


class ModelComparisonOut(BaseModel):
    """All units of one instrument model, side by side. `trend_fields` is the
    union of the numeric fields any unit's finalized reports carry, so the
    comparison chart's field picker only offers fields with data."""

    model: str
    units: list[UnitComparisonOut]
    trend_fields: list[TrendFieldOut]


class ModelTrendSeriesOut(BaseModel):
    instrument_id: uuid.UUID
    name: str
    serial_number: str
    points: list[TrendPointOut]


class ModelTrendOut(BaseModel):
    """GET /analytics/models/trend: one field's series for every unit of a
    model, in the same point shape as GET /instruments/{id}/trend."""

    model: str
    field: str
    series: list[ModelTrendSeriesOut]


# ---------- Saved report filters ----------

# The only criteria a saved filter may hold: exactly the Reports list's filters,
# under the keys GET /reports already takes. The free-text search `q` became
# saveable on 2026-10-16 (it was left out at first; the project owner reversed
# that after finding that "Save this filter" did nothing with only a search word).
SAVED_FILTER_KEYS = ("instrument_id", "report_type", "status", "date_from", "date_to", "technician", "q")


class SavedFilterCriteria(BaseModel):
    """What a saved filter stores. Extra keys are rejected (a seventh
    criterion needs a deliberate change here), and only set criteria are kept."""

    model_config = ConfigDict(extra="forbid")

    instrument_id: uuid.UUID | None = None
    report_type: ReportType | None = None
    status: ReportStatus | None = None
    date_from: date | None = None
    date_to: date | None = None
    technician: str | None = None
    # Free-text search, kept as typed (trimmed). Same rules as GET /reports?q=.
    q: str | None = None

    @field_validator("technician")
    @classmethod
    def _trim_technician(cls, v: str | None) -> str | None:
        v = v.strip() if v else None
        return v or None

    @field_validator("q")
    @classmethod
    def _valid_search(cls, v: str | None) -> str | None:
        from app.services.report_search import normalize_query  # noqa: PLC0415 (avoids a circular import)

        return normalize_query(v)

    @model_validator(mode="after")
    def _at_least_one_and_ordered(self):
        if all(getattr(self, k) is None for k in SAVED_FILTER_KEYS):
            raise ValueError("Set at least one filter before saving")
        if self.date_from and self.date_to and self.date_from > self.date_to:
            raise ValueError("date_from must not be after date_to")
        return self


class SavedFilterCreate(BaseModel):
    name: str
    filters: SavedFilterCriteria

    @field_validator("name")
    @classmethod
    def _name_not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Name must not be blank")
        if len(v) > 60:
            raise ValueError("Name must be at most 60 characters")
        return v


class SavedFilterOut(BaseModel):
    id: uuid.UUID
    name: str
    # Only the criteria that were set; dates are YYYY-MM-DD exactly as saved.
    filters: dict
    created_at: datetime
    # True when the saved instrument no longer exists.
    stale: bool = False


class SavedFilterListOut(BaseModel):
    items: list[SavedFilterOut]
    cap: int
