from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app import schemas
from app.db import get_db
from app.services.analytics import compute_fleet_analytics

router = APIRouter(tags=["analytics"])


@router.get("/analytics/fleet", response_model=schemas.FleetAnalyticsOut)
def fleet_analytics(db: Session = Depends(get_db)):
    """Fleet-wide roll-ups computed from every finalized report's already-
    captured fields (components_replaced, labor_hours, fault_category,
    retest_result/verification_result) — no new columns, nothing to backfill.
    See services/analytics.py for exactly how each number is derived and why
    only finalized reports contribute."""
    return compute_fleet_analytics(db)
