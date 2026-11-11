"""The report filters shared by the Reports list, its CSV export and the Analytics page.

One place decides what "instrument, model, report type, dates, status, lab manager and search text"
mean, so the Analytics tab can never drift from the Reports tab (the lab asked for them to be
identical). Callers pass whatever they have; a filter left as None is not applied.
"""
from __future__ import annotations

import uuid
from datetime import date

from sqlalchemy import cast, func, literal, select
from sqlalchemy.dialects.postgresql import JSONB, JSONPATH
from sqlalchemy.orm import Query

from app import models
from app.services import report_search


# The comparisons a field condition can make, as jsonpath operators (never built from user input).
FIELD_OPS = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<=", "eq": "=="}


def field_condition_error(field: str | None, op: str | None, value: float | None) -> str | None:
    """None when the three parts of a field condition are all set or all empty and make sense; else a message."""
    if field is None and op is None and value is None:
        return None
    if not field or not field.strip() or op is None or value is None:
        return "A field condition needs the field, the comparison and the value together."
    if op not in FIELD_OPS:
        return f"The comparison must be one of: {', '.join(FIELD_OPS)}."
    if value != value or value in (float("inf"), float("-inf")):
        return "The value of a field condition must be a finite number."
    return None


def field_condition(field: str, op: str, value: float):
    """True for a report whose number in `field` passes. A number[laser] or number[detector] field holds one number
    per laser or detector, and passes when any of them does. Text, empty and other non-number values never pass."""
    path = f"$.keyvalue() ? (@.key == $field && (@.value {FIELD_OPS[op]} $value || exists(@.value.* ? (@ {FIELD_OPS[op]} $value))))"
    variables = {"field": field.strip(), "value": value}
    return func.jsonb_path_exists(models.Report.extracted_fields, cast(literal(path), JSONPATH), cast(literal(variables, type_=JSONB), JSONB))


NUMERIC_FIELD_TYPES = ("number", "number[laser]", "number[detector]")


def numeric_field_names(session) -> list[str]:
    """The names of the fields that hold numbers in any template (plain, per laser or per detector), sorted,
    so a plain-words search can be told which fields a condition may name. Table columns inside a list are not included."""
    names: set[str] = set()
    for (schema,) in session.query(models.ReportTemplate.field_schema).all():
        fields = schema.get("fields") if isinstance(schema, dict) else schema
        for item in fields or []:
            if isinstance(item, dict) and item.get("type") in NUMERIC_FIELD_TYPES and isinstance(item.get("name"), str):
                names.add(item["name"])
    return sorted(names)


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
    field: str | None = None,
    op: str | None = None,
    value: float | None = None,
) -> Query:
    """Narrow a query on Report. `model_id` keeps the reports of every instrument of that model
    record (instrument_models.id); with `instrument_id` too, both must hold. `technician` is a
    case-insensitive partial match (ILIKE); `q` is the word-based free-text search, which covers
    finalized reports only (services/report_search.py), so combined with another status it is
    simply empty. `field`, `op` and `value` together are a condition on a number in the report's fields
    ("laser delay above 29"); like `q` it covers finalized reports only (values still being checked can change)."""
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
    if field and op in FIELD_OPS and value is not None:
        query = query.filter(report_search.finalized_only(), field_condition(field, op, value))
    return query
