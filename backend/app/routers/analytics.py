from __future__ import annotations

import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app import models, schemas
from app.db import get_db
from app.services import report_filters
from app.services.analytics import (
    AnalyticsFilters,
    compute_fleet_analytics,
    compute_model_comparison,
    compute_model_trend,
)

router = APIRouter(tags=["analytics"])


def analytics_filters(
    instrument_id: uuid.UUID | None = Query(None, description="Only this instrument (also limits the units listed)"),
    model_id: uuid.UUID | None = Query(None, description="Only instruments of this model record (also limits the units listed)"),
    manufacturer: str | None = Query(None, description="Only instruments from this manufacturer (also limits the units listed)"),
    report_type: models.ReportType | None = Query(None, description="Only reports of this type"),
    date_from: date | None = Query(None, description="Report date on or after this day"),
    date_to: date | None = Query(None, description="Report date on or before this day"),
    status: str | None = Query(
        None, description="Only reports in this status; omitted = finalized only, 'all' = every status"
    ),
    technician: str | None = Query(None, description="Lab manager contains this text (case-insensitive)"),
    q: str | None = Query(None, description="Free-text search (finalized reports only), as on the Reports list"),
) -> AnalyticsFilters:
    """The optional filters every analytics endpoint takes, same meaning as on
    the Reports list. A report with no report date is left out once a date
    bound is given."""
    if date_from and date_to and date_from > date_to:
        raise HTTPException(422, "date_from must not be after date_to")
    if status is not None and status != "all":
        try:
            models.ReportStatus(status)
        except ValueError:
            raise HTTPException(422, f"Unknown status '{status}'") from None
    try:
        search = report_filters.normalized_search_text(q)
    except ValueError as e:
        raise HTTPException(422, str(e)) from None
    return AnalyticsFilters(
        instrument_id=instrument_id,
        model_id=model_id,
        manufacturer=manufacturer or None,
        report_type=report_type,
        date_from=date_from,
        date_to=date_to,
        status=status or None,
        technician=(technician or "").strip() or None,
        q=search,
    )


@router.get("/analytics/fleet", response_model=schemas.FleetAnalyticsOut)
def fleet_analytics(filters: AnalyticsFilters = Depends(analytics_filters), db: Session = Depends(get_db)):
    """Fleet-wide roll-ups computed from every finalized report's already-
    captured fields (components_replaced, labor_hours, fault_category,
    retest_result/verification_result) — no new columns, nothing to backfill.
    See services/analytics.py for exactly how each number is derived and why
    only finalized reports contribute."""
    return compute_fleet_analytics(db, filters)


@router.get("/analytics/models", response_model=list[schemas.ModelComparisonOut])
def model_comparison(filters: AnalyticsFilters = Depends(analytics_filters), db: Session = Depends(get_db)):
    """Instruments of the same model side by side: per unit (serial), finalized
    report count, labor hours, parts replaced and pass/fail results, plus the
    numeric fields the comparison chart can plot. Finalized reports only,
    narrowed by the optional filters."""
    return compute_model_comparison(db, filters)


@router.get("/analytics/models/trend", response_model=schemas.ModelTrendOut)
def model_trend(
    model: str = Query(..., description="Instrument model, e.g. LSRFortessa"),
    field: str = Query(..., description="Key inside extracted_fields to plot, one series per unit"),
    filters: AnalyticsFilters = Depends(analytics_filters),
    db: Session = Depends(get_db),
):
    """One numeric field's trend for every unit of a model, in the same point
    shape as GET /instruments/{id}/trend, so the units can share one chart."""
    result = compute_model_trend(db, model, field, filters)
    if result is None:
        raise HTTPException(404, "No instrument with that model")
    return result
