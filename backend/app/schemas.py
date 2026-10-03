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

from pydantic import BaseModel, ConfigDict, model_validator

from app.models import ExtractionJobKind, ExtractionJobStatus, InstrumentStatus, ReportStatus, ReportType


# ---------- App config ----------


class AppConfigOut(BaseModel):
    """GET /config (§4/§12): the confidence thresholds the frontend used to
    hardcode as its own literal copies of app/config.py's settings. Those two
    numbers drive real UI behavior (review-flagging, badge coloring), so a
    backend .env change used to silently desync the UI instead of the UI
    just reading the real value from here."""

    field_confidence_threshold: float
    classification_confidence_threshold: float


# ---------- Instruments ----------


class InstrumentCreate(BaseModel):
    name: str
    instrument_type: str = "facs"
    model: str
    serial_number: str
    location: str | None = None


class InstrumentUpdate(BaseModel):
    """PATCH /instruments/{id} — every field optional so a caller only sends
    what's changing; `instrument_type` is deliberately not editable here (it's
    a fixed "facs" for MVP per the Instrument model's own doc comment, with
    nothing in the UI to pick another value yet). Which fields the caller
    actually sent is read via `model_fields_set` in the router, the same
    partial-update pattern TemplateUpdate below already uses, so an omitted
    field is left alone rather than overwritten with None."""

    name: str | None = None
    model: str | None = None
    serial_number: str | None = None
    location: str | None = None
    status: InstrumentStatus | None = None


class InstrumentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    instrument_type: str
    model: str
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
