"""Pydantic shapes: analytics (part of app/schemas, see __init__.py)."""
from __future__ import annotations

import uuid
from datetime import date

from pydantic import BaseModel

from app.models import (
    InstrumentStatus,
)
from app.schemas.places import PlaceKind
from app.schemas.templates import TemplateFieldType

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
    institution: str | None = None
    serial_number: str
    # Finalized repair/preventive_maintenance reports with a numeric
    # labor_hours value; other report types never carry labor_hours
    # (seed_templates.py), so they never contribute here.
    report_count: int
    total_labor_hours: float


class ReportCountByInstrumentOut(BaseModel):
    """One row of GET /analytics/fleet's report_counts_by_instrument: how many reports matched the
    filters (finalized unless the status filter says otherwise, any report type) for one instrument.
    Every instrument that passes the unit filters appears, including one with none."""

    instrument_id: uuid.UUID
    name: str
    model: str
    institution: str | None = None
    serial_number: str
    report_count: int
    # What the fleet list beside the charts shows per row: the hours added up for this instrument.
    total_labor_hours: float = 0.0


class ReportCountByModelOut(BaseModel):
    """The same counts added up per instrument model, with how many units of the model are listed."""

    model: str
    # The model record (instrument_models.id) when the units have one: what the
    # `model_id` filter takes, so the page can narrow itself to this model.
    model_id: uuid.UUID | None = None
    unit_count: int
    report_count: int
    total_labor_hours: float = 0.0


class PlaceRollupOut(BaseModel):
    """One row of GET /analytics/fleet's place_rollups: the instruments under
    a place (itself and everything inside it), the reports that matched the
    filters on them, and their work hours."""

    place_id: uuid.UUID
    kind: PlaceKind
    name: str
    institution_name: str
    instrument_count: int
    report_count: int
    total_labor_hours: float


class FleetAnalyticsOut(BaseModel):
    """GET /analytics/fleet (new): fleet-wide roll-ups computed entirely from
    fields every finalized report already carries — no new columns, no new
    tables. See services/analytics.py for exactly how each number is derived."""

    # Finalized reports of any type that matched the filters, i.e. what the
    # numbers below were computed from.
    finalized_report_count: int = 0
    parts_replaced: list[PartUsageOut]
    total_labor_hours: float
    labor_hours_by_instrument: list[InstrumentRollupOut]
    # Finalized repair/preventive_maintenance reports that added no hours above: no
    # number in the labor field, or no instrument on the report. The page says so.
    reports_without_labor_hours: int = 0
    report_counts_by_instrument: list[ReportCountByInstrumentOut] = []
    report_counts_by_model: list[ReportCountByModelOut] = []
    # Per institution, faculty and room (see services/analytics.py::_place_rollups).
    place_rollups: list[PlaceRollupOut] = []
    # Keyed by whatever fault_category values actually appear in the data
    # (repair only — seed_templates.py's REPAIR_FIELDS) rather than a
    # hardcoded copy of that enum's options, so this can't silently drift
    # from the real template if its options list ever changes.
    labor_hours_by_fault_category: dict[str, float]


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
    # All finalized reports for the unit, any type.
    finalized_report_count: int
    last_report_date: date | None
    # Finalized repair/preventive_maintenance reports with a numeric labor_hours.
    labor_report_count: int
    total_labor_hours: float
    # Sum of qty over every components_replaced row on the unit's reports.
    parts_replaced_qty: float


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
