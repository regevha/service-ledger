from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app import schemas
from app.db import get_db
from app.services.home_summary import home_summary

router = APIRouter(tags=["home"])


@router.get("/home/summary", response_model=schemas.HomeSummaryOut)
def get_home_summary(db: Session = Depends(get_db)) -> schemas.HomeSummaryOut:
    """The figures the Home screen shows: reports waiting (and the oldest), finalized this month against last
    month, and how much of the reading was kept without edits over the last 30 days."""
    return home_summary(db, date.today())
