from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import models, schemas
from app.db import get_db
from app.services.instrument_types import make_key

router = APIRouter(tags=["instrument-types"])

_CONFLICT = "An instrument type with this name already exists"


@router.get("/instrument-types", response_model=list[schemas.InstrumentTypeOut])
def list_instrument_types(db: Session = Depends(get_db)):
    return db.query(models.InstrumentType).order_by(models.InstrumentType.display_name).all()


@router.post("/instrument-types", response_model=schemas.InstrumentTypeOut, status_code=201)
def create_instrument_type(payload: schemas.InstrumentTypeCreate, db: Session = Depends(get_db)):
    """Adds a type. Admin-only once role-based sign-in exists (PR #13): add it to
    that policy table then. Types cannot be edited or deleted yet; the key is
    derived from the name and is what instruments and templates store."""
    key = make_key(payload.display_name)
    if not key:
        raise HTTPException(422, "The type name needs at least one letter or digit")
    if db.query(models.InstrumentType).filter(models.InstrumentType.key == key).first():
        raise HTTPException(409, _CONFLICT)
    row = models.InstrumentType(key=key, display_name=payload.display_name.strip())
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, _CONFLICT)
    db.refresh(row)
    return row
