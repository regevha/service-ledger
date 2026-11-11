"""Pydantic shapes: instruments (part of app/schemas, see __init__.py)."""
from __future__ import annotations

import uuid
from datetime import date

from pydantic import BaseModel, ConfigDict, field_validator, model_validator

from app.models import (
    DEFAULT_INSTRUMENT_TYPE_KEY,
    InstrumentStatus,
)

from app.schemas.templates import TemplateUpdate


# ---------- Instruments ----------


class InstrumentTypeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    key: str
    display_name: str
    # The type a new instrument, model or template starts with (the screens preselect it).
    is_default: bool = False

    @model_validator(mode="after")
    def _mark_default(self):
        self.is_default = self.key == DEFAULT_INSTRUMENT_TYPE_KEY
        return self


class InstrumentTypeCreate(BaseModel):
    display_name: str


class ManufacturerOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    aliases: list[str]
    # Filled by the router: how many instruments and models name this maker.
    instrument_count: int = 0
    model_count: int = 0


class ManufacturerCreate(BaseModel):
    name: str
    aliases: list[str] = []


class ManufacturerUpdate(BaseModel):
    name: str | None = None
    aliases: list[str] | None = None


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
    instrument_type: str = DEFAULT_INSTRUMENT_TYPE_KEY
    model: str
    # Required for new instruments (existing rows may still have none). Blank
    # counts as missing.
    manufacturer: str
    # Optional: the local seller / service company when it is not the maker.
    distributor: str | None = None
    # Optional: the university or company the unit belongs to ("Bar-Ilan University").
    institution: str | None = None
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

    @field_validator("institution")
    @classmethod
    def _blank_institution_is_none(cls, value: str | None) -> str | None:
        """Free text, trimmed; blank means "not recorded"."""
        return (value.strip() or None) if isinstance(value, str) else value


class RepairCountOut(BaseModel):
    """How many finalized repair reports one instrument has in a date range."""

    instrument_id: uuid.UUID
    repairs: int


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
    institution: str | None = None
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

    @field_validator("institution")
    @classmethod
    def _blank_institution_is_none(cls, value: str | None) -> str | None:
        """Free text, trimmed; blank means "not recorded"."""
        return (value.strip() or None) if isinstance(value, str) else value


class InstrumentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    instrument_type: str
    model: str
    # The model record this instrument belongs to (instrument_models.id); the
    # model filter on the Reports, Analytics and Instruments screens uses it.
    model_id: uuid.UUID | None = None
    manufacturer: str | None
    distributor: str | None
    institution: str | None
    serial_number: str
    location: str | None
    status: InstrumentStatus
    # The most specific place known (institutions, faculties and rooms are
    # managed under Places); None when no institution or room is recorded.
    place_id: uuid.UUID | None = None
    # Worked out on every read from the model's service interval and the
    # newest finalized preventive-maintenance report (services/maintenance.py).
    # State is one of not_tracked, no_record, ok, due_soon, overdue; None for a
    # retired instrument.
    last_maintenance_date: date | None = None
    maintenance_due_date: date | None = None
    maintenance_state: str | None = None
