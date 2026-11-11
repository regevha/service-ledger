"""Pydantic shapes: saved filters (part of app/schemas, see __init__.py)."""
from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, field_validator, model_validator

from app.models import (
    ReportStatus,
    ReportType,
)

from app.schemas.instrument_models import InstrumentModelDetailOut, ModelReliabilityOut


# ---------- Saved report filters ----------

# The only criteria a saved filter may hold: exactly the Reports list's filters,
# under the keys GET /reports already takes. The free-text search `q` became
# saveable on 2026-10-16 (it was left out at first; the project owner reversed
# that after finding that "Save this filter" did nothing with only a search word).
# The instrument model (`model_id`) joined on 2026-10-27 with the model filter.
# The place (`place_id`) joined with the places plan, step 3.
SAVED_FILTER_KEYS = ("instrument_id", "model_id", "place_id", "report_type", "status", "date_from", "date_to", "technician", "q", "field", "op", "value")


class SavedFilterCriteria(BaseModel):
    """What a saved filter stores. Extra keys are rejected (a seventh
    criterion needs a deliberate change here), and only set criteria are kept."""

    model_config = ConfigDict(extra="forbid")

    instrument_id: uuid.UUID | None = None
    # An instrument model record (instrument_models.id), as GET /reports?model_id= takes.
    model_id: uuid.UUID | None = None
    place_id: uuid.UUID | None = None
    report_type: ReportType | None = None
    status: ReportStatus | None = None
    date_from: date | None = None
    date_to: date | None = None
    technician: str | None = None
    # Free-text search, kept as typed (trimmed). Same rules as GET /reports?q=.
    q: str | None = None
    # A condition on a number in the report's fields ("laser delay above 29"): all three or none.
    field: str | None = None
    op: str | None = None
    value: float | None = None

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
        from app.services.report_filters import field_condition_error  # noqa: PLC0415

        problem = field_condition_error(self.field, self.op, self.value)
        if problem:
            raise ValueError(problem)
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
    # True when a saved instrument, model or place no longer exists; `stale_keys`
    # says which ("instrument_id", "model_id", "place_id").
    stale: bool = False
    stale_keys: list[str] = []


class SavedFilterListOut(BaseModel):
    items: list[SavedFilterOut]
    cap: int


InstrumentModelDetailOut.model_rebuild()
ModelReliabilityOut.model_rebuild()
