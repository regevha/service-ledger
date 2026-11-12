"""Pydantic shapes: instrument models (part of app/schemas, see __init__.py)."""
from __future__ import annotations

import uuid
from datetime import date

from pydantic import BaseModel, Field, field_validator

from app.models import (
    DEFAULT_INSTRUMENT_TYPE_KEY,
    InstrumentStatus,
)
from app.schemas.analytics import PartUsageOut
from app.schemas.instruments import _required_text
from app.schemas.reports import ReportListItemOut

# ---------- Instrument models ----------


class InstrumentModelOut(BaseModel):
    id: uuid.UUID
    name: str
    manufacturer: str | None
    instrument_type: str
    service_interval_months: int | None
    notes: str | None
    # How many instruments are of this model, and how many report templates
    # are written for exactly this model name.
    unit_count: int
    template_count: int
    # Other model names that look like the same model (never merged by guess).
    similar_to: list[str] = []


class InstrumentModelUnitOut(BaseModel):
    """One instrument on a model's page, with what its reports say."""

    id: uuid.UUID
    name: str
    serial_number: str
    status: InstrumentStatus
    institution: str | None
    location: str | None
    # Finalized reports only; the date is report_date, or the day the report
    # was created when it has none.
    last_service_date: date | None
    report_count: int
    repair_count: int
    maintenance_due_date: date | None = None
    maintenance_state: str | None = None
    # Reports still being read or reviewed.
    draft_count: int


class ModelFaultCategoryOut(BaseModel):
    category: str
    report_count: int
    instrument_count: int
    # The same instrument had this category on two or more repairs.
    repeat: bool


class ModelUnitReliabilityOut(BaseModel):
    instrument_id: uuid.UUID
    name: str
    serial_number: str
    repair_count: int
    # Needs two dated repairs on this instrument; None otherwise, and always
    # None while the model has too few repairs for averages.
    mean_days_between_repairs: float | None


class ModelReliabilityOut(BaseModel):
    """How a model holds up, from its instruments' finalized repair reports.
    Averages are withheld (None) while the model has fewer than `min_repairs`
    repairs; the counts are always given."""

    repair_count: int
    min_repairs: int
    enough_data: bool
    # Repairs with no report date: left out of the gaps.
    repairs_without_date: int
    repairs_with_fault_category: int
    mean_days_between_repairs: float | None
    gap_count: int
    avg_labor_hours: float | None
    repairs_with_labor_hours: int
    total_labor_hours: float
    units: list[ModelUnitReliabilityOut]
    fault_categories: list[ModelFaultCategoryOut]
    # Top 10 by quantity, from every finalized report of the model's instruments.
    parts: list["PartUsageOut"]


class InstrumentModelDetailOut(InstrumentModelOut):
    units: list[InstrumentModelUnitOut]
    # Newest first, at most 25; report_total is how many there are in all.
    reports: list["ReportListItemOut"]
    report_total: int


class InstrumentModelCreate(BaseModel):
    name: str
    manufacturer: str | None = None
    instrument_type: str = DEFAULT_INSTRUMENT_TYPE_KEY
    service_interval_months: int | None = Field(default=None, ge=1, le=600)
    notes: str | None = None

    @field_validator("name")
    @classmethod
    def _name_not_blank(cls, value: str) -> str:
        return _required_text("Name")(value)

    @field_validator("manufacturer", "notes")
    @classmethod
    def _blank_is_none(cls, value: str | None) -> str | None:
        return (value.strip() or None) if isinstance(value, str) else value


class InstrumentModelUpdate(BaseModel):
    name: str | None = None
    manufacturer: str | None = None
    instrument_type: str | None = None
    service_interval_months: int | None = Field(default=None, ge=1, le=600)
    notes: str | None = None

    @field_validator("name")
    @classmethod
    def _name_not_blank(cls, value: str | None) -> str | None:
        return _required_text("Name")(value)

    @field_validator("manufacturer", "notes")
    @classmethod
    def _blank_is_none(cls, value: str | None) -> str | None:
        return (value.strip() or None) if isinstance(value, str) else value


class InstrumentModelMerge(BaseModel):
    into_id: uuid.UUID


class InstrumentModelMergeOut(BaseModel):
    moved_instruments: int
    moved_templates: int
    into: str
