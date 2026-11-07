"""Pydantic shapes: templates (part of app/schemas, see __init__.py)."""
from __future__ import annotations

import enum
import uuid
from typing import Literal
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.models import (
    DEFAULT_INSTRUMENT_TYPE_KEY,
    ReportType,
)

from app.schemas.reports import ReportFieldsUpdate


# ---------- Report templates ----------


class ReportTemplateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    instrument_type: str
    report_type: ReportType
    model: str | None
    field_schema: dict


# ---------- Report template management ----------


# ---------- Field aliases ----------

_ALIAS_NAME_MAX = 100
_ALIAS_NAMES_MAX = 20


class FieldAliasGroupIn(BaseModel):
    """A set of at least two field names that mean the same thing. Names are
    trimmed; two names that match once case, spaces, underscores and hyphens are
    ignored count as one and are rejected."""

    label: str | None = None
    names: list[str]

    @field_validator("label")
    @classmethod
    def _label(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if len(v) > _ALIAS_NAME_MAX:
            raise ValueError(f"The label can be at most {_ALIAS_NAME_MAX} characters")
        return v or None

    @field_validator("names")
    @classmethod
    def _names(cls, v: list[str]) -> list[str]:
        from app.services.template_compare import normalize_name

        cleaned = [n.strip() for n in v]
        if any(not n for n in cleaned):
            raise ValueError("A name cannot be blank")
        if any(len(n) > _ALIAS_NAME_MAX for n in cleaned):
            raise ValueError(f"A name can be at most {_ALIAS_NAME_MAX} characters")
        if any(not normalize_name(n) for n in cleaned):
            raise ValueError("A name needs at least one letter or digit")
        if len(cleaned) < 2:
            raise ValueError("A group needs at least two names")
        if len(cleaned) > _ALIAS_NAMES_MAX:
            raise ValueError(f"A group can have at most {_ALIAS_NAMES_MAX} names")
        seen: dict[str, str] = {}
        for n in cleaned:
            key = normalize_name(n)
            if key in seen:
                raise ValueError(f"'{seen[key]}' and '{n}' are the same name once case, spaces and underscores are ignored")
            seen[key] = n
        return cleaned


class FieldAliasGroupOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    label: str | None
    names: list[str]
    created_at: datetime


class AliasConceptOut(BaseModel):
    """The alias group behind a "possible match" row of a comparison."""

    id: uuid.UUID
    label: str | None
    names: list[str]


class TemplateCompareRowOut(BaseModel):
    """One field of a comparison (GET /report-templates/compare). `left` and
    `right` are the field definitions as stored, absent on the side that does
    not have the field. `differences` names what differs for a "differs" or
    "possible_match" row: name (spelled differently), type, unit, notes,
    options, item_schema. A "possible_match" row pairs two differently named
    fields that an alias group lists as the same concept."""

    status: Literal["same", "differs", "only_left", "only_right", "possible_match"]
    name: str
    differences: list[Literal["name", "type", "unit", "notes", "options", "item_schema"]]
    left: dict | None
    right: dict | None
    # Set on a "possible_match" row: the alias group that links the two names.
    concept: AliasConceptOut | None = None


class TemplateCompareSummaryOut(BaseModel):
    left_count: int
    right_count: int
    shared: int
    same: int
    differs: int
    only_left: int
    only_right: int
    possible_match: int = 0


class TemplateCompareOut(BaseModel):
    """Two templates of one instrument type, their fields lined up. Read-only
    advice for a person; nothing is changed by asking."""

    left: ReportTemplateOut
    right: ReportTemplateOut
    summary: TemplateCompareSummaryOut
    rows: list[TemplateCompareRowOut]


class TemplateSuggestionOut(BaseModel):
    """One existing template offered as the starting point for a new one
    (GET /report-templates/suggestions). Advice only; nothing is applied."""

    template: ReportTemplateOut
    score: int
    reason: str
    field_count: int


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
    # Filled in by a person, not printed on the form (fault category,
    # root cause). The model still suggests a value, but the review screen always
    # asks for it to be checked, whatever the confidence.
    filled_by_person: bool = False
    # May be left empty: when the form does not state it, an empty value is the
    # right answer and the review screen does not flag it.
    optional: bool = False

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

    instrument_type: str = DEFAULT_INSTRUMENT_TYPE_KEY
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
