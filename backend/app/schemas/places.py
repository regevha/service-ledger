"""Pydantic shapes: places (part of app/schemas, see __init__.py)."""
from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, field_validator

from app.schemas.instruments import _required_text


# ---------- Places ----------

PlaceKind = Literal["institution", "faculty", "room"]


class PlaceOut(BaseModel):
    id: uuid.UUID
    kind: PlaceKind
    name: str
    parent_id: uuid.UUID | None
    # The institution this place is in (itself, for an institution) and, for a
    # room inside a faculty, that faculty.
    institution_id: uuid.UUID
    institution_name: str
    faculty_id: uuid.UUID | None
    faculty_name: str | None
    # Instruments pointing exactly here, and in all (here plus everything inside).
    unit_count: int
    total_unit_count: int
    child_count: int
    # Other places of the same kind that look like the same place (never merged by guess).
    similar_to: list[str] = []


class PlaceCreate(BaseModel):
    kind: PlaceKind
    name: str
    parent_id: uuid.UUID | None = None

    @field_validator("name")
    @classmethod
    def _name_not_blank(cls, value: str) -> str:
        return " ".join(_required_text("Name")(value).split())


class PlaceUpdate(BaseModel):
    name: str | None = None
    parent_id: uuid.UUID | None = None

    @field_validator("name")
    @classmethod
    def _name_not_blank(cls, value: str | None) -> str | None:
        return " ".join(_required_text("Name")(value).split()) if value is not None else None


class PlaceMerge(BaseModel):
    into_id: uuid.UUID


class PlaceMergeOut(BaseModel):
    moved_instruments: int
    moved_places: int
    into: str
