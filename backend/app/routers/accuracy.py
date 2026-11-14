"""Reading accuracy (Admin screen)."""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app import schemas
from app.db import get_db
from app.services.read_accuracy import read_accuracy

router = APIRouter(tags=["accuracy"])


@router.get("/analytics/read-accuracy", response_model=schemas.ReadAccuracyOut)
def get_read_accuracy(
    days: int | None = Query(90, ge=0, le=3660, description="Reports finalized in the last N days; leave out for 90, send 0 for all."),
    db: Session = Depends(get_db),
) -> schemas.ReadAccuracyOut:
    """How much of the reading was approved without an edit: the overall share of fields and of reports, by week,
    by field, by form and by source (translated or not), the newest corrections, and the translation edits."""
    return read_accuracy(db, date.today(), days or None)
