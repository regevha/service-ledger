"""Same-model comparison."""
from __future__ import annotations

import uuid

from sqlalchemy.orm import Session, joinedload

from app import models, schemas
from app.models import report_chronological_order

from .filters import AnalyticsFilters, _apply_filters, _apply_unit_filters
from .trends import trend_points, trendable_fields
from .values import _LABOR_TRACKING_REPORT_TYPES, _as_number


def _finalized_reports_by_instrument(
    db: Session, filters: AnalyticsFilters | None = None
) -> dict[uuid.UUID, list[models.Report]]:
    reports = (
        _apply_filters(
            db.query(models.Report)
            .options(joinedload(models.Report.template))
            .filter(models.Report.instrument_id.isnot(None)),
            filters or AnalyticsFilters(),
        )
        .order_by(*report_chronological_order())
        .all()
    )
    by_instrument: dict[uuid.UUID, list[models.Report]] = {}
    for report in reports:
        by_instrument.setdefault(report.instrument_id, []).append(report)
    return by_instrument


def _unit_comparison(instrument: models.Instrument, reports: list[models.Report]) -> schemas.UnitComparisonOut:
    labor_hours = 0.0
    labor_reports = 0
    parts_qty = 0.0
    for report in reports:
        fields = report.extracted_fields or {}
        for entry in fields.get("components_replaced") or []:
            if isinstance(entry, dict):
                qty = _as_number(entry.get("qty"))
                if qty is not None:
                    parts_qty += qty
        if report.template is None or report.template.report_type not in _LABOR_TRACKING_REPORT_TYPES:
            continue
        hours = _as_number(fields.get("labor_hours"))
        if hours is not None:
            labor_hours += hours
            labor_reports += 1
    dated = [r.report_date for r in reports if r.report_date is not None]
    return schemas.UnitComparisonOut(
        instrument_id=instrument.id,
        name=instrument.name,
        serial_number=instrument.serial_number,
        status=instrument.status,
        finalized_report_count=len(reports),
        last_report_date=max(dated) if dated else None,
        labor_report_count=labor_reports,
        total_labor_hours=labor_hours,
        parts_replaced_qty=parts_qty,
    )


def compute_model_comparison(db: Session, filters: AnalyticsFilters | None = None) -> list[schemas.ModelComparisonOut]:
    """Every instrument model with its units side by side. A model with a
    single unit is included (nothing to compare yet, but it is not hidden);
    units with no matching finalized reports show zeros rather than
    disappearing. With an instrument filter only that unit is listed."""
    filters = filters or AnalyticsFilters()
    by_instrument = _finalized_reports_by_instrument(db, filters)
    grouped: dict[str, list[models.Instrument]] = {}
    unit_query = db.query(models.Instrument).order_by(models.Instrument.serial_number)
    for instrument in _apply_unit_filters(unit_query, filters).all():
        grouped.setdefault(instrument.model, []).append(instrument)
    out = []
    for model in sorted(grouped):
        units = grouped[model]
        all_reports = [r for u in units for r in by_instrument.get(u.id, [])]
        out.append(
            schemas.ModelComparisonOut(
                model=model,
                units=[_unit_comparison(u, by_instrument.get(u.id, [])) for u in units],
                trend_fields=trendable_fields(all_reports),
            )
        )
    return out


def compute_model_trend(
    db: Session, model: str, field: str, filters: AnalyticsFilters | None = None
) -> schemas.ModelTrendOut | None:
    """One field's series for every unit of `model`; None if no instrument has
    that model. With an instrument filter only that unit's series is returned
    (None when the filtered instrument is not of this model)."""
    filters = filters or AnalyticsFilters()
    unit_query = db.query(models.Instrument).filter(models.Instrument.model == model).order_by(models.Instrument.serial_number)
    units = _apply_unit_filters(unit_query, filters).all()
    if not units:
        return None
    by_instrument = _finalized_reports_by_instrument(db, filters)
    return schemas.ModelTrendOut(
        model=model,
        field=field,
        series=[
            schemas.ModelTrendSeriesOut(
                instrument_id=u.id,
                name=u.name,
                serial_number=u.serial_number,
                points=trend_points(by_instrument.get(u.id, []), field),
            )
            for u in units
        ],
    )
