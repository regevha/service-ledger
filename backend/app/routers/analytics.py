from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app import schemas
from app.db import get_db
from app.services.analytics import compute_fleet_analytics, compute_model_comparison, compute_model_trend

router = APIRouter(tags=["analytics"])


@router.get("/analytics/fleet", response_model=schemas.FleetAnalyticsOut)
def fleet_analytics(db: Session = Depends(get_db)):
    """Fleet-wide roll-ups computed from every finalized report's already-
    captured fields (components_replaced, labor_hours, fault_category,
    retest_result/verification_result) — no new columns, nothing to backfill.
    See services/analytics.py for exactly how each number is derived and why
    only finalized reports contribute."""
    return compute_fleet_analytics(db)


@router.get("/analytics/models", response_model=list[schemas.ModelComparisonOut])
def model_comparison(db: Session = Depends(get_db)):
    """Instruments of the same model side by side: per unit (serial), finalized
    report count, labor hours, parts replaced and pass/fail results, plus the
    numeric fields the comparison chart can plot. Finalized reports only."""
    return compute_model_comparison(db)


@router.get("/analytics/models/trend", response_model=schemas.ModelTrendOut)
def model_trend(
    model: str = Query(..., description="Instrument model, e.g. LSRFortessa"),
    field: str = Query(..., description="Key inside extracted_fields to plot, one series per unit"),
    db: Session = Depends(get_db),
):
    """One numeric field's trend for every unit of a model, in the same point
    shape as GET /instruments/{id}/trend, so the units can share one chart."""
    result = compute_model_trend(db, model, field)
    if result is None:
        raise HTTPException(404, "No instrument with that model")
    return result
