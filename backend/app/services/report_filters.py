"""The report filters shared by the Reports list, its CSV export and the Analytics page.

One place decides what "instrument, model, report type, dates, status, lab manager and search text"
mean, so the Analytics tab can never drift from the Reports tab (the lab asked for them to be
identical). Callers pass whatever they have; a filter left as None is not applied.
"""
from __future__ import annotations

import uuid
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Query

from app import models
from app.services import report_search


def normalized_search_text(q: str | None) -> str | None:
    """The free-text query, trimmed; None when blank. Raises ValueError (with a message the
    screen can show) when it is too short or too long."""
    return report_search.normalize_query(q)


def _place_ids(query: Query, place_id: uuid.UUID) -> list[uuid.UUID]:
    """The place and everything inside it (empty when the place does not exist, so nothing matches)."""
    from app.services.places import subtree_ids  # noqa: PLC0415 (places imports models, as this does)

    session = query.session
    place = session.get(models.Place, place_id)
    return subtree_ids(session, place) if place is not None else []


def apply_report_filters(
    query: Query,
    *,
    instrument_id: uuid.UUID | None = None,
    model_id: uuid.UUID | None = None,
    place_id: uuid.UUID | None = None,
    report_type: models.ReportType | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    status: models.ReportStatus | None = None,
    technician: str | None = None,
    q: str | None = None,
) -> Query:
    """Narrow a query on Report. `model_id` keeps the reports of every instrument of that model
    record (instrument_models.id); with `instrument_id` too, both must hold. `technician` is a
    case-insensitive partial match (ILIKE); `q` is the word-based free-text search, which covers
    finalized reports only (services/report_search.py), so combined with another status it is
    simply empty."""
    if instrument_id:
        query = query.filter(models.Report.instrument_id == instrument_id)
    if model_id:
        query = query.filter(
            models.Report.instrument_id.in_(select(models.Instrument.id).where(models.Instrument.model_id == model_id))
        )
    if place_id:
        query = query.filter(models.Report.instrument_id.in_(select(models.Instrument.id).where(models.Instrument.place_id.in_(_place_ids(query, place_id)))))
    if report_type:
        query = query.join(models.ReportTemplate).filter(models.ReportTemplate.report_type == report_type)
    if date_from:
        query = query.filter(models.Report.report_date >= date_from)
    if date_to:
        query = query.filter(models.Report.report_date <= date_to)
    if status:
        query = query.filter(models.Report.status == status)
    if technician:
        query = query.filter(models.Report.technician_name.ilike(f"%{technician}%"))
    if q:
        match, _rank = report_search.match_expressions(q)
        query = query.filter(report_search.finalized_only(), match)
    return query
