from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app import schemas
from app.db import get_db
from app.services import instrument_types as types

router = APIRouter(tags=["instrument-types"])


@router.get("/instrument-types", response_model=list[schemas.InstrumentTypeOut])
def list_instrument_types(db: Session = Depends(get_db)):
    return types.list_types(db)


@router.post("/instrument-types", response_model=schemas.InstrumentTypeOut, status_code=201)
def create_instrument_type(payload: schemas.InstrumentTypeCreate, db: Session = Depends(get_db)):
    """Adds a type. Admin-only once role-based sign-in exists (PR #13): add it to
    that policy table then. Types cannot be edited or deleted yet; the key is
    derived from the name and is what instruments and templates store."""
    return types.create_type(db, payload.display_name)
