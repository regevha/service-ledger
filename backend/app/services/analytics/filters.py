"""Which reports and instruments the analytics are computed from."""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Query

from app import models
from app.services.manufacturers import find_maker
from app.services.places import subtree_ids
from app.services.report_filters import apply_report_filters


@dataclass(frozen=True)
class AnalyticsFilters:
    """Which finalized reports the analytics are computed from. Every field is
    optional and they combine (all must hold). They mean the same as on the
    Reports list: `report_type` is the report's template type, and the dates
    are the report date, so a report with no date drops out as soon as a date
    bound is set. `instrument_id` also narrows which instruments are listed
    (fleet roll-up rows, comparison units), not only whose reports count; so
    does `manufacturer` (matched ignoring case and surrounding spaces), which
    selects the whole group of instruments from that maker."""

    instrument_id: uuid.UUID | None = None
    # The instruments of one model record (instrument_models.id); narrows the
    # listed instruments and whose reports count, like `manufacturer`.
    model_id: uuid.UUID | None = None
    # A place (institution, faculty or room) and everything inside it: only the
    # instruments there, and their reports. Same meaning as on the Reports list.
    place_id: uuid.UUID | None = None
    manufacturer: str | None = None
    report_type: models.ReportType | None = None
    date_from: date | None = None
    date_to: date | None = None
    # Same meaning as on the Reports list. `status` None means finalized only (what
    # the analytics always used); "all" means every status; otherwise that one status.
    status: str | None = None
    technician: str | None = None
    q: str | None = None
    # A number in this field must pass (op: gt, gte, lt, lte, eq; value: the number), as on the Reports list.
    field: str | None = None
    op: str | None = None
    value: float | None = None


def _apply_unit_filters(query: Query, filters: AnalyticsFilters) -> Query:
    """The filters that choose which instruments are listed (query on Instrument)."""
    if filters.instrument_id:
        query = query.filter(models.Instrument.id == filters.instrument_id)
    if filters.model_id:
        query = query.filter(models.Instrument.model_id == filters.model_id)
    if filters.place_id:
        place = query.session.get(models.Place, filters.place_id)
        ids = subtree_ids(query.session, place) if place is not None else []
        query = query.filter(models.Instrument.place_id.in_(ids))
    if filters.manufacturer:
        query = query.filter(_same_manufacturer(query.session, filters.manufacturer))
    return query


def _same_manufacturer(session, name: str):
    """The instruments made by the maker `name` names: by its name or any other name it is
    known by ("Becton Dickinson" finds BD's instruments), and, for text no maker has, by
    the exact text, ignoring case and surrounding spaces."""
    maker = find_maker(session.query(models.Manufacturer).all(), name)
    same_text = func.lower(func.trim(models.Instrument.manufacturer)) == name.strip().lower()
    return or_(same_text, models.Instrument.manufacturer_id == maker.id) if maker else same_text


def _apply_filters(query: Query, filters: AnalyticsFilters) -> Query:
    """The Reports-list filters (shared code, services/report_filters.py) plus the analytics-only
    manufacturer. `status` None means finalized only, which is what the analytics always used;
    "all" means every status."""
    if filters.manufacturer:
        query = query.filter(
            models.Report.instrument_id.in_(select(models.Instrument.id).where(_same_manufacturer(query.session, filters.manufacturer)))
        )
    if filters.status is None:
        status = models.ReportStatus.finalized
    elif filters.status == "all":
        status = None
    else:
        status = models.ReportStatus(filters.status)
    return apply_report_filters(
        query,
        instrument_id=filters.instrument_id,
        model_id=filters.model_id,
        place_id=filters.place_id,
        report_type=filters.report_type,
        date_from=filters.date_from,
        date_to=filters.date_to,
        status=status,
        technician=filters.technician,
        q=filters.q,
        field=filters.field,
        op=filters.op,
        value=filters.value,
    )
