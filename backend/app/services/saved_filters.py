"""Saved report filters: a short, global list of named filter combinations
(proposal-saved-filters.md). The rules for saving one live here; the router only
translates HTTP."""
from __future__ import annotations

import uuid

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import models, schemas
from app.services.domain_errors import ConflictError, InvalidError, NotFoundError

# At most this many saved filters exist at once, shared by everyone.
MAX_SAVED_FILTERS = 5

_CAP_MESSAGE = f"{MAX_SAVED_FILTERS} saved filters already exist. Delete one first."
_NAME_MESSAGE = "A saved filter with this name already exists"
# Arbitrary constant key for the transaction-level advisory lock that
# serialises "count, then insert" across concurrent saves.
_LOCK_KEY = 726_001


def existing_ids(db: Session) -> dict[str, set[str]]:
    """The instruments, models and places that exist now, for spotting saved filters that point at a deleted one."""
    return {
        "instrument_id": {str(i) for (i,) in db.query(models.Instrument.id).all()},
        "model_id": {str(i) for (i,) in db.query(models.InstrumentModel.id).all()},
        "place_id": {str(i) for (i,) in db.query(models.Place.id).all()},
    }


def list_filters(db: Session) -> list[models.SavedReportFilter]:
    return db.query(models.SavedReportFilter).order_by(models.SavedReportFilter.created_at.desc()).all()


def create_filter(db: Session, name: str, criteria: schemas.SavedFilterCriteria) -> models.SavedReportFilter:
    if criteria.instrument_id and not db.get(models.Instrument, criteria.instrument_id):
        raise InvalidError("That instrument does not exist")
    if criteria.model_id and not db.get(models.InstrumentModel, criteria.model_id):
        raise InvalidError("That model does not exist")
    if criteria.place_id and not db.get(models.Place, criteria.place_id):
        raise InvalidError("That place does not exist")
    # exclude_none keeps only the criteria that were set; mode="json" turns
    # UUIDs, enums and dates into their plain string forms (dates as
    # YYYY-MM-DD exactly as picked).
    stored = criteria.model_dump(mode="json", exclude_none=True)

    # Serialise concurrent saves so two people at four existing filters cannot
    # both get in: the lock is held until this transaction ends.
    db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": _LOCK_KEY})
    if db.query(models.SavedReportFilter).count() >= MAX_SAVED_FILTERS:
        db.rollback()
        raise ConflictError(_CAP_MESSAGE)
    row = models.SavedReportFilter(name=name, filters=stored)
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        # The unique index on lower(btrim(name)) caught a duplicate name,
        # including one that slipped in between the lock and the insert.
        db.rollback()
        raise ConflictError(_NAME_MESSAGE)
    db.refresh(row)
    return row


def delete_filter(db: Session, filter_id: uuid.UUID) -> None:
    row = db.get(models.SavedReportFilter, filter_id)
    if not row:
        raise NotFoundError("Saved filter not found")
    db.delete(row)
    db.commit()
