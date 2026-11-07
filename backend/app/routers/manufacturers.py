from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app import models, schemas
from app.db import get_db
from app.services import manufacturers as makers

router = APIRouter(tags=["manufacturers"])


def _out(db: Session, maker: models.Manufacturer) -> schemas.ManufacturerOut:
    out = schemas.ManufacturerOut.model_validate(maker)
    out.instrument_count, out.model_count = makers.usage_counts(db, maker)
    return out


@router.get("/manufacturers", response_model=list[schemas.ManufacturerOut])
def list_manufacturers(db: Session = Depends(get_db)):
    return [_out(db, m) for m in makers.list_makers(db)]


@router.post("/manufacturers", response_model=schemas.ManufacturerOut, status_code=201)
def create_manufacturer(payload: schemas.ManufacturerCreate, db: Session = Depends(get_db)):
    return _out(db, makers.create_maker(db, payload.name, payload.aliases))


@router.patch("/manufacturers/{maker_id}", response_model=schemas.ManufacturerOut)
def update_manufacturer(maker_id: uuid.UUID, payload: schemas.ManufacturerUpdate, db: Session = Depends(get_db)):
    """Renames a maker and/or replaces its aliases. A rename is copied onto the
    instruments and models that point at it, so their text keeps matching. Two makers
    are never merged here: a name or alias another maker answers to is refused (409)."""
    provided = payload.model_fields_set
    name = payload.name if "name" in provided else None
    aliases = payload.aliases if "aliases" in provided else None
    return _out(db, makers.update_maker(db, maker_id, name, aliases))


@router.delete("/manufacturers/{maker_id}", status_code=204)
def delete_manufacturer(maker_id: uuid.UUID, db: Session = Depends(get_db)):
    makers.delete_maker(db, maker_id)
