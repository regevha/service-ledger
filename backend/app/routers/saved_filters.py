"""Saved report filters: a short, global list of named filter combinations
(proposal-saved-filters.md). There is deliberately no "apply" endpoint — the
client loads a saved filter's criteria into the Reports list and calls the
existing GET /reports, so the list, the CSV export and saved filters share one
filtering path."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app import models, schemas
from app.db import get_db
from app.services import saved_filters as filters
from app.services.saved_filters import _LOCK_KEY, MAX_SAVED_FILTERS  # noqa: F401  (tests read them here)

router = APIRouter(tags=["saved-report-filters"])


def _out(row: models.SavedReportFilter, existing: dict[str, set[str]]) -> schemas.SavedFilterOut:
    """`existing` maps a criterion key to the ids that still exist for it (see filters.existing_ids)."""
    stale_keys = [key for key, ids in existing.items() if row.filters.get(key) and row.filters[key] not in ids]
    return schemas.SavedFilterOut(
        id=row.id,
        name=row.name,
        filters=row.filters,
        created_at=row.created_at,
        stale=bool(stale_keys),
        stale_keys=stale_keys,
    )


@router.get("/saved-report-filters", response_model=schemas.SavedFilterListOut)
def list_saved_filters(db: Session = Depends(get_db)):
    rows = filters.list_filters(db)
    existing = filters.existing_ids(db)
    return schemas.SavedFilterListOut(items=[_out(r, existing) for r in rows], cap=MAX_SAVED_FILTERS)


@router.post("/saved-report-filters", response_model=schemas.SavedFilterOut, status_code=201)
def create_saved_filter(payload: schemas.SavedFilterCreate, db: Session = Depends(get_db)):
    row = filters.create_filter(db, payload.name, payload.filters)
    return _out(row, filters.existing_ids(db))


@router.delete("/saved-report-filters/{filter_id}", status_code=204)
def delete_saved_filter(filter_id: uuid.UUID, db: Session = Depends(get_db)):
    filters.delete_filter(db, filter_id)
