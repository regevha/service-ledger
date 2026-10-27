"""Saved report filters: a short, global list of named filter combinations
(proposal-saved-filters.md). There is deliberately no "apply" endpoint — the
client loads a saved filter's criteria into the Reports list and calls the
existing GET /reports, so the list, the CSV export and saved filters share one
filtering path."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import models, schemas
from app.db import get_db

router = APIRouter(tags=["saved-report-filters"])

# At most this many saved filters exist at once, shared by everyone.
MAX_SAVED_FILTERS = 5

_CAP_MESSAGE = f"{MAX_SAVED_FILTERS} saved filters already exist. Delete one first."
_NAME_MESSAGE = "A saved filter with this name already exists"
# Arbitrary constant key for the transaction-level advisory lock that
# serialises "count, then insert" across concurrent saves.
_LOCK_KEY = 726_001


def _out(row: models.SavedReportFilter, existing: dict[str, set[str]]) -> schemas.SavedFilterOut:
    """`existing` maps a criterion key to the ids that still exist for it (see _existing)."""
    stale_keys = [key for key, ids in existing.items() if row.filters.get(key) and row.filters[key] not in ids]
    return schemas.SavedFilterOut(
        id=row.id,
        name=row.name,
        filters=row.filters,
        created_at=row.created_at,
        stale=bool(stale_keys),
        stale_keys=stale_keys,
    )


def _existing(db: Session) -> dict[str, set[str]]:
    """The instruments and models that exist now, for spotting saved filters that point at a deleted one."""
    return {
        "instrument_id": {str(i) for (i,) in db.query(models.Instrument.id).all()},
        "model_id": {str(i) for (i,) in db.query(models.InstrumentModel.id).all()},
    }


@router.get("/saved-report-filters", response_model=schemas.SavedFilterListOut)
def list_saved_filters(db: Session = Depends(get_db)):
    rows = db.query(models.SavedReportFilter).order_by(models.SavedReportFilter.created_at.desc()).all()
    existing = _existing(db)
    return schemas.SavedFilterListOut(items=[_out(r, existing) for r in rows], cap=MAX_SAVED_FILTERS)


@router.post("/saved-report-filters", response_model=schemas.SavedFilterOut, status_code=201)
def create_saved_filter(payload: schemas.SavedFilterCreate, db: Session = Depends(get_db)):
    criteria = payload.filters
    if criteria.instrument_id and not db.get(models.Instrument, criteria.instrument_id):
        raise HTTPException(422, "That instrument does not exist")
    if criteria.model_id and not db.get(models.InstrumentModel, criteria.model_id):
        raise HTTPException(422, "That model does not exist")
    # exclude_none keeps only the criteria that were set; mode="json" turns
    # UUIDs, enums and dates into their plain string forms (dates as
    # YYYY-MM-DD exactly as picked).
    stored = criteria.model_dump(mode="json", exclude_none=True)

    # Serialise concurrent saves so two people at four existing filters cannot
    # both get in: the lock is held until this transaction ends.
    db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": _LOCK_KEY})
    if db.query(models.SavedReportFilter).count() >= MAX_SAVED_FILTERS:
        db.rollback()
        raise HTTPException(409, _CAP_MESSAGE)
    row = models.SavedReportFilter(name=payload.name, filters=stored)
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        # The unique index on lower(btrim(name)) caught a duplicate name,
        # including one that slipped in between the lock and the insert.
        db.rollback()
        raise HTTPException(409, _NAME_MESSAGE)
    db.refresh(row)
    return _out(row, _existing(db))


@router.delete("/saved-report-filters/{filter_id}", status_code=204)
def delete_saved_filter(filter_id: uuid.UUID, db: Session = Depends(get_db)):
    row = db.get(models.SavedReportFilter, filter_id)
    if not row:
        raise HTTPException(404, "Saved filter not found")
    db.delete(row)
    db.commit()
